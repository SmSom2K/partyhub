-- The public API is limited to RPCs. Event records and invite hashes live in a private schema.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema partyhub_private;
revoke all on schema partyhub_private from public, anon, authenticated;

create table partyhub_private.workspaces (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  revision bigint not null check (revision > 0),
  state jsonb not null
);

create table partyhub_private.invites (
  owner_id uuid not null references partyhub_private.workspaces (owner_id) on delete cascade,
  guest_id text not null,
  token_hash bytea unique not null,
  primary key (owner_id, guest_id)
);

create table partyhub_private.votes (
  owner_id uuid not null references partyhub_private.workspaces (owner_id) on delete cascade,
  guest_id text not null,
  song_id text not null,
  primary key (owner_id, guest_id, song_id)
);

alter table partyhub_private.workspaces enable row level security;
alter table partyhub_private.invites enable row level security;
alter table partyhub_private.votes enable row level security;
revoke all on all tables in schema partyhub_private from public, anon, authenticated;

create function partyhub_private.require_host() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  viewer uuid := auth.uid();
begin
  if viewer is null or coalesce(auth.jwt()->>'is_anonymous', 'false') = 'true' then
    raise exception 'Host sign-in required' using errcode = '42501';
  end if;
  return viewer;
end;
$$;

create function partyhub_private.validate_state(p_state jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  field text;
begin
  if jsonb_typeof(p_state) is distinct from 'object'
     or octet_length(p_state::text) > 1048576
     or jsonb_typeof(p_state->'event') is distinct from 'object' then
    raise exception 'Invalid workspace data' using errcode = '22023';
  end if;
  foreach field in array array['guests','songs','tasks','timeline'] loop
    if jsonb_typeof(p_state->field) is distinct from 'array'
       or jsonb_array_length(p_state->field) > 1000 then
      raise exception 'Invalid workspace collection' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_state->field) as entry(value)
      where jsonb_typeof(value) is distinct from 'object'
         or jsonb_typeof(value->'id') is distinct from 'string'
         or length(value->>'id') not between 1 and 100
    ) or exists (
      select 1 from jsonb_array_elements(p_state->field) as entry(value)
      group by value->>'id' having count(*) > 1
    ) then
      raise exception 'Workspace entries require unique IDs' using errcode = '22023';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(p_state->'songs') as entry(value)
    where jsonb_typeof(value->'votes') is distinct from 'number'
       or (value->>'votes') !~ '^[0-9]{1,8}$'
       or jsonb_typeof(value->'played') is distinct from 'boolean'
       or jsonb_typeof(value->'name') is distinct from 'string'
       or jsonb_typeof(value->'artist') is distinct from 'string'
       or length(value->>'name') not between 1 and 100
       or length(value->>'artist') not between 1 and 100
  ) then
    raise exception 'Invalid song entry' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_state->'guests') as entry(value)
    where jsonb_typeof(value->'count') is distinct from 'number'
       or (value->>'count') !~ '^([1-9][0-9]?|100)$'
       or jsonb_typeof(value->'name') is distinct from 'string'
       or length(value->>'name') not between 1 and 200
       or coalesce(value->>'status', '') not in ('pending','yes','no')
  ) then
    raise exception 'Invalid guest entry' using errcode = '22023';
  end if;
end;
$$;

create function public.partyhub_load() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('revision', workspace.revision, 'state', workspace.state)
  from partyhub_private.workspaces as workspace
  where workspace.owner_id = (select partyhub_private.require_host());
$$;

create function public.partyhub_save(p_revision bigint, p_state jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  viewer uuid := partyhub_private.require_host();
  saved partyhub_private.workspaces;
begin
  perform partyhub_private.validate_state(p_state);
  if p_revision = 0 then
    insert into partyhub_private.workspaces (owner_id, revision, state)
    values (viewer, 1, p_state)
    on conflict (owner_id) do nothing
    returning * into saved;
  else
    update partyhub_private.workspaces
    set revision = revision + 1, state = p_state
    where owner_id = viewer and revision = p_revision
    returning * into saved;
  end if;
  if saved.owner_id is null then
    raise exception 'This event changed on another device. Reload and try again.' using errcode = '40001';
  end if;
  delete from partyhub_private.invites as invite
  where invite.owner_id = viewer
    and not exists (
      select 1 from jsonb_array_elements(p_state->'guests') as entry(value)
      where value->>'id' = invite.guest_id
    );
  delete from partyhub_private.votes as vote
  where vote.owner_id = viewer
    and (
      not exists (
        select 1 from jsonb_array_elements(p_state->'guests') as entry(value)
        where value->>'id' = vote.guest_id
      )
      or not exists (
        select 1 from jsonb_array_elements(p_state->'songs') as entry(value)
        where value->>'id' = vote.song_id
      )
    );
  return jsonb_build_object('revision', saved.revision, 'state', saved.state);
end;
$$;

create function public.partyhub_issue_invite(p_guest_id text) returns text
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
  on conflict (owner_id, guest_id) do update set token_hash = excluded.token_hash;
  return new_token;
end;
$$;

create function public.partyhub_revoke_invite(p_guest_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  viewer uuid := partyhub_private.require_host();
begin
  perform 1 from partyhub_private.workspaces where owner_id = viewer for update;
  delete from partyhub_private.invites where owner_id = viewer and guest_id = p_guest_id;
end;
$$;

create function partyhub_private.invite_for(p_token text) returns partyhub_private.invites
language plpgsql stable set search_path = '' as $$
declare
  invite partyhub_private.invites;
begin
  if p_token ~ '^[a-f0-9]{64}$' then
    select * into invite from partyhub_private.invites
    where token_hash = extensions.digest(p_token, 'sha256');
  end if;
  if invite.owner_id is null then
    raise exception 'This invitation is invalid or has been replaced' using errcode = '22023';
  end if;
  return invite;
end;
$$;

create function partyhub_private.guest_payload(p_owner_id uuid, p_guest_id text, p_state jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'event', jsonb_build_object(
      'name', p_state#>'{event,name}', 'date', p_state#>'{event,date}',
      'time', p_state#>'{event,time}', 'venue', p_state#>'{event,venue}',
      'details', p_state#>'{event,details}', 'karaoke', p_state#>'{event,karaoke}',
      'rsvp', p_state#>'{event,rsvp}', 'songs', p_state#>'{event,songs}',
      'media', false
    ),
    'guest', jsonb_build_object(
      'name', entry.value->'name', 'count', entry.value->'count',
      'status', entry.value->'status', 'table', entry.value->'table'
    ),
    'songs', case when p_state#>'{event,songs}' = 'true'::jsonb then (
      select coalesce(jsonb_agg(
        jsonb_build_object('id', song.value->'id', 'name', song.value->'name',
          'artist', song.value->'artist', 'votes', song.value->'votes',
          'voted', exists (
            select 1 from partyhub_private.votes as vote
            where vote.owner_id = p_owner_id and vote.guest_id = p_guest_id
              and vote.song_id = song.value->>'id'
          ))
        order by (song.value->>'votes')::int desc, song.ordinality
      ), '[]'::jsonb)
      from jsonb_array_elements(p_state->'songs') with ordinality as song(value, ordinality)
      where song.value->'played' = 'false'::jsonb
    ) else '[]'::jsonb end,
    'timeline', (
      select coalesce(jsonb_agg(jsonb_build_object('time', item.value->'time', 'name', item.value->'name')), '[]'::jsonb)
      from jsonb_array_elements(p_state->'timeline') as item(value)
    )
  )
  from jsonb_array_elements(p_state->'guests') as entry(value)
  where entry.value->>'id' = p_guest_id;
$$;

create function public.partyhub_guest(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  invite partyhub_private.invites := partyhub_private.invite_for(p_token);
  payload jsonb;
begin
  select partyhub_private.guest_payload(invite.owner_id, invite.guest_id, state) into payload
  from partyhub_private.workspaces where owner_id = invite.owner_id;
  if payload is null then
    raise exception 'This invitation is invalid or has been replaced' using errcode = '22023';
  end if;
  return payload;
end;
$$;

-- Guest mutations lock the same row as host edits. Revalidate the invite after
-- waiting for that lock because the organizer may have revoked it in the meantime.
create function public.partyhub_rsvp(p_token text, p_status text, p_count integer) returns jsonb
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
  workspace_state := jsonb_set(workspace_state, array['guests', guest_index::text],
    workspace_state#>array['guests', guest_index::text] || jsonb_build_object('status', p_status, 'count', p_count));
  update partyhub_private.workspaces set state = workspace_state, revision = revision + 1
  where owner_id = invite.owner_id;
  return partyhub_private.guest_payload(invite.owner_id, invite.guest_id, workspace_state);
end;
$$;

create function partyhub_private.record_vote(p_owner uuid, p_guest text, p_song text, p_songs jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  song_index integer;
  song_votes integer;
begin
  select ordinality::int - 1, (value->>'votes')::int into song_index, song_votes
  from jsonb_array_elements(p_songs) with ordinality as entry(value, ordinality)
  where value->>'id' = p_song and value->'played' = 'false'::jsonb;
  if song_index is null then
    raise exception 'This song is no longer in the queue' using errcode = '22023';
  end if;
  insert into partyhub_private.votes (owner_id, guest_id, song_id)
  values (p_owner, p_guest, p_song) on conflict do nothing;
  if found then
    return jsonb_set(p_songs, array[song_index::text, 'votes'], to_jsonb(song_votes + 1));
  end if;
  return p_songs;
end;
$$;

create function partyhub_private.guest_music(p_token text, p_song_id text, p_name text, p_artist text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  invite partyhub_private.invites := partyhub_private.invite_for(p_token);
  workspace_state jsonb;
  song_id text := p_song_id;
  artist_name text := btrim(p_artist);
  song_name text := btrim(p_name);
  songs jsonb;
  updated_songs jsonb;
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
      song_id := gen_random_uuid()::text;
      songs := songs || jsonb_build_array(jsonb_build_object(
        'id', song_id, 'name', song_name, 'artist', artist_name, 'votes', 0, 'played', false
      ));
    end if;
  end if;
  updated_songs := partyhub_private.record_vote(invite.owner_id, invite.guest_id, song_id, songs);
  if updated_songs is distinct from workspace_state->'songs' then
    workspace_state := jsonb_set(workspace_state, '{songs}', updated_songs);
    update partyhub_private.workspaces set state = workspace_state, revision = revision + 1
    where owner_id = invite.owner_id;
  end if;
  return partyhub_private.guest_payload(invite.owner_id, invite.guest_id, workspace_state);
end;
$$;

create function public.partyhub_song(p_token text, p_name text, p_artist text) returns jsonb
language sql security definer set search_path = '' as $$
  select partyhub_private.guest_music(p_token, null, p_name, p_artist);
$$;

create function public.partyhub_vote(p_token text, p_song_id text) returns jsonb
language sql security definer set search_path = '' as $$
  select partyhub_private.guest_music(p_token, p_song_id, null, null);
$$;

revoke all on all functions in schema partyhub_private from public, anon, authenticated;
revoke all on function public.partyhub_load(), public.partyhub_save(bigint, jsonb),
  public.partyhub_issue_invite(text), public.partyhub_revoke_invite(text) from public, anon, authenticated;
grant execute on function public.partyhub_load(), public.partyhub_save(bigint, jsonb),
  public.partyhub_issue_invite(text), public.partyhub_revoke_invite(text) to authenticated;
revoke all on function public.partyhub_guest(text), public.partyhub_rsvp(text, text, integer),
  public.partyhub_song(text, text, text), public.partyhub_vote(text, text) from public, anon, authenticated;
grant execute on function public.partyhub_guest(text), public.partyhub_rsvp(text, text, integer),
  public.partyhub_song(text, text, text), public.partyhub_vote(text, text) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('partyhub-media', 'partyhub-media', false, 52428800,
  array['image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime']);

create policy partyhub_media_read on storage.objects for select to authenticated
using (bucket_id = 'partyhub-media' and (storage.foldername(name))[1] = (select auth.uid()::text)
  and coalesce((select auth.jwt()->>'is_anonymous'), 'false') <> 'true');

create policy partyhub_media_insert on storage.objects for insert to authenticated
with check (bucket_id = 'partyhub-media' and (storage.foldername(name))[1] = (select auth.uid()::text)
  and coalesce((select auth.jwt()->>'is_anonymous'), 'false') <> 'true');

create policy partyhub_media_delete on storage.objects for delete to authenticated
using (bucket_id = 'partyhub-media' and (storage.foldername(name))[1] = (select auth.uid()::text)
  and coalesce((select auth.jwt()->>'is_anonymous'), 'false') <> 'true');
