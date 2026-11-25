-- Keep each household's write budget on its existing invite row.
-- Rotation refreshes expiration while retaining the household's usage counters.
alter table partyhub_private.invites
  add column expires_at timestamptz not null default (now() + interval '180 days'),
  add column write_reset_at timestamptz not null default '-infinity',
  add column write_count smallint not null default 0 check (write_count between 0 and 30),
  add column song_reset_at timestamptz not null default '-infinity',
  add column song_count smallint not null default 0 check (song_count between 0 and 8);

-- Enforce the host payload size limit for guest writes as well. Retain old rows
-- even if a guest operation had already made them larger in an earlier version.
alter table partyhub_private.workspaces
  add constraint partyhub_workspace_size
  check (octet_length(state::text) <= 1048576) not valid;

create function partyhub_private.save_guest_change(
  p_invite partyhub_private.invites, p_state jsonb, p_new_song boolean
) returns void
language plpgsql set search_path = '' as $$
declare
  checked_at timestamptz := clock_timestamp();
begin
  -- Return a safe error before the table constraint can report private row data.
  if octet_length(p_state::text) > 1048576 then
    raise exception 'This event has reached its data limit' using errcode = '22023';
  end if;
  -- Mutators already lock the workspace row before reaching this function.
  -- Check and update the counters together so the budget cannot be overdrawn.
  update partyhub_private.invites as invite
  set write_reset_at = case when invite.write_reset_at <= checked_at
      then checked_at + interval '1 minute' else invite.write_reset_at end,
    write_count = case when invite.write_reset_at <= checked_at then 1
      else invite.write_count + 1 end,
    song_reset_at = case when p_new_song and invite.song_reset_at <= checked_at
      then checked_at + interval '1 hour' else invite.song_reset_at end,
    song_count = case when not p_new_song then invite.song_count
      when invite.song_reset_at <= checked_at then 1 else invite.song_count + 1 end
  where invite.owner_id = p_invite.owner_id
    and invite.guest_id = p_invite.guest_id
    and (invite.write_reset_at <= checked_at or invite.write_count < 30)
    and (not p_new_song or invite.song_reset_at <= checked_at or invite.song_count < 8);
  if not found then
    raise sqlstate 'PT429' using message = 'Too many changes for this invitation. Try again later.';
  end if;
  update partyhub_private.workspaces set state = p_state, revision = revision + 1
  where owner_id = p_invite.owner_id;
end;
$$;

revoke all on function partyhub_private.save_guest_change(partyhub_private.invites, jsonb, boolean)
  from public, anon, authenticated;

create or replace function public.partyhub_issue_invite(p_guest_id text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  viewer uuid := partyhub_private.require_host();
  workspace_state jsonb;
  new_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  select state into workspace_state
  from partyhub_private.workspaces
  where owner_id = viewer
  for update;
  if not exists (
    select 1 from jsonb_array_elements(workspace_state->'guests') as entry(value)
    where value->>'id' = p_guest_id
  ) then
    raise exception 'Save this guest before creating an invitation' using errcode = '22023';
  end if;
  insert into partyhub_private.invites (owner_id, guest_id, token_hash)
  values (viewer, p_guest_id, extensions.digest(new_token, 'sha256'))
  on conflict (owner_id, guest_id) do update
  set token_hash = excluded.token_hash, expires_at = excluded.expires_at;
  return new_token;
end;
$$;

create or replace function partyhub_private.invite_for(p_token text) returns partyhub_private.invites
language plpgsql stable set search_path = '' as $$
declare
  invite partyhub_private.invites;
begin
  if p_token ~ '^[a-f0-9]{64}$' then
    select * into invite from partyhub_private.invites
    where token_hash = extensions.digest(p_token, 'sha256')
      and expires_at > statement_timestamp();
  end if;
  if invite.owner_id is null then
    raise exception 'This invitation is invalid, expired or replaced' using errcode = '22023';
  end if;
  return invite;
end;
$$;

create or replace function public.partyhub_rsvp(p_token text, p_status text, p_count integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  invite partyhub_private.invites := partyhub_private.invite_for(p_token);
  workspace_state jsonb;
  guest_index integer;
begin
  if coalesce(p_status, '') not in ('yes','no') or p_count is null or p_count not between 1 and 100 then
    raise exception 'Invalid RSVP' using errcode = '22023';
  end if;
  select state into workspace_state from partyhub_private.workspaces
  where owner_id = invite.owner_id for update;
  invite := partyhub_private.invite_for(p_token);
  if workspace_state#>'{event,rsvp}' is distinct from 'true'::jsonb then
    raise exception 'RSVPs are closed' using errcode = '42501';
  end if;
  select ordinality::int - 1 into guest_index
  from jsonb_array_elements(workspace_state->'guests') with ordinality as entry(value, ordinality)
  where value->>'id' = invite.guest_id;
  if guest_index is null then
    raise exception 'This invitation is invalid or has been replaced' using errcode = '22023';
  end if;
  if workspace_state#>>array['guests', guest_index::text, 'status'] = p_status
     and workspace_state#>>array['guests', guest_index::text, 'count'] = p_count::text then
    return partyhub_private.guest_payload(invite.owner_id, invite.guest_id, workspace_state);
  end if;
  workspace_state := jsonb_set(workspace_state, array['guests', guest_index::text],
    workspace_state#>array['guests', guest_index::text] || jsonb_build_object('status', p_status, 'count', p_count));
  perform partyhub_private.save_guest_change(invite, workspace_state, false);
  return partyhub_private.guest_payload(invite.owner_id, invite.guest_id, workspace_state);
end;
$$;

create or replace function partyhub_private.guest_music(p_token text, p_song_id text, p_name text, p_artist text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  invite partyhub_private.invites := partyhub_private.invite_for(p_token);
  workspace_state jsonb;
  song_id text := p_song_id;
  artist_name text := btrim(p_artist);
  song_name text := btrim(p_name);
  songs jsonb;
  updated_songs jsonb;
  new_song boolean := false;
begin
  select state into workspace_state from partyhub_private.workspaces
  where owner_id = invite.owner_id for update;
  invite := partyhub_private.invite_for(p_token);
  if workspace_state#>'{event,songs}' is distinct from 'true'::jsonb then
    raise exception 'Song requests and votes are closed' using errcode = '42501';
  end if;
  songs := workspace_state->'songs';
  if song_id is null then
    if coalesce(length(song_name), 0) not between 1 and 100
       or coalesce(length(artist_name), 0) not between 1 and 100 then
      raise exception 'Song title and artist must have 1 to 100 characters' using errcode = '22023';
    end if;
    select value->>'id' into song_id from jsonb_array_elements(songs) as entry(value)
    where lower(value->>'name') = lower(song_name) and lower(value->>'artist') = lower(artist_name)
      and value->'played' = 'false'::jsonb
    limit 1;
    if song_id is null then
      if jsonb_array_length(songs) >= 1000 then
        raise exception 'The song queue is full' using errcode = '22023';
      end if;
      new_song := true;
      song_id := gen_random_uuid()::text;
      songs := songs || jsonb_build_array(jsonb_build_object(
        'id', song_id, 'name', song_name, 'artist', artist_name, 'votes', 0, 'played', false
      ));
    end if;
  end if;
  updated_songs := partyhub_private.record_vote(invite.owner_id, invite.guest_id, song_id, songs);
  if updated_songs is distinct from workspace_state->'songs' then
    workspace_state := jsonb_set(workspace_state, '{songs}', updated_songs);
    perform partyhub_private.save_guest_change(invite, workspace_state, new_song);
  end if;
  return partyhub_private.guest_payload(invite.owner_id, invite.guest_id, workspace_state);
end;
$$;
