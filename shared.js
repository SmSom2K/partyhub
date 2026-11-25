const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.89.0/+esm';
const BUCKET = 'partyhub-media';
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm'];
const STATUS = {pending: 'Pending', yes: 'Coming', no: 'Declined'};

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const section = (title, content) => `<section class="card section"><h2>${title}</h2>${content}</section>`;
const field = (label, name, value = '', options = '') => `<label class="field">${label}<input name="${name}" value="${escape(value)}" ${options}></label>`;
const checked = (value) => value ? 'checked' : '';
const empty = (message) => `<p class="empty">${message}</p>`;
const button = (text, action, id = '', style = 'secondary') =>
  `<button type="button" class="${style}" data-shared-action="${action}" data-id="${escape(id)}">${text}</button>`;
const form = (action, content, id = '') =>
  `<form data-shared-form="${action}" data-id="${escape(id)}" class="shared-form">${content}</form>`;

function defaultState() {
  return {
    event: {
      name: 'My event', date: '', time: '', venue: '', details: '', capacity: 100,
      karaoke: '', songs: true, media: false, rsvp: true,
    },
    guests: [], songs: [], tasks: [], timeline: [],
  };
}

function eventFields(event) {
  return [
    field('Event name', 'name', event.name, 'required maxlength="120"'),
    field('Date', 'date', event.date, 'type="date"'),
    field('Time', 'time', event.time, 'type="time"'),
    field('Venue', 'venue', event.venue, 'maxlength="160"'),
    field('Capacity', 'capacity', event.capacity, 'type="number" min="1" max="10000" required'),
    field('Karaoke link', 'karaoke', event.karaoke, 'type="url" maxlength="500"'),
    `<label class="field">Arrival details<textarea name="details" maxlength="2000">${escape(event.details)}</textarea></label>`,
    `<div class="actions"><label><input type="checkbox" name="rsvp" ${checked(event.rsvp)}> Guest RSVPs</label>
      <label><input type="checkbox" name="songs" ${checked(event.songs)}> Guest song requests</label></div>`,
  ].join('');
}

function songFields() {
  return field('Song title', 'name', '', 'required maxlength="100"') +
    field('Artist', 'artist', '', 'required maxlength="100"');
}

function statusOptions(current) {
  return Object.entries(STATUS).map(([value, label]) =>
    `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`
  ).join('');
}

function sortedSongs(songs) {
  return [...songs].sort((a, b) => Number(b.votes) - Number(a.votes));
}

function timelineRows(timeline, canEdit) {
  return [...timeline].sort((a, b) => a.time.localeCompare(b.time)).map((item) =>
    `<div class="item"><time>${escape(item.time)}</time><strong class="grow">${escape(item.name)}</strong>
    ${canEdit ? button('Remove', 'remove-time', item.id, 'danger') : ''}</div>`
  ).join('') || empty('No scheduled activities.');
}

function eventHero(event, label) {
  const summary = [event.date, event.time, event.venue].filter(Boolean).map(escape).join(' · ');
  return `<header class="hero"><div class="eyebrow">${label}</div><h1>${escape(event.name)}</h1>
    ${summary ? `<p>${summary}</p>` : ''}</header>`;
}

function cleanText(values, name) {
  return String(values.get(name) ?? '').trim();
}

function requiredText(values, name, message) {
  const value = cleanText(values, name);
  if (!value) throw new Error(message);
  return value;
}

function basePage() {
  const url = new URL(window.location.href);
  url.hash = '';
  url.search = '';
  return url;
}

function readInvite() {
  const url = new URL(window.location.href);
  if (url.hash.startsWith('#invite=')) return url.hash.slice(8);
  if (!url.searchParams.has('invite')) return null;
  const token = url.searchParams.get('invite');
  url.searchParams.delete('invite');
  url.hash = `invite=${encodeURIComponent(token)}`;
  window.history.replaceState(null, '', url);
  return token;
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export async function startShared(config) {
  const app = document.querySelector('#app');
  const invite = readInvite();
  const apiOrigin = new URL(config.url).origin;
  const {createClient} = await import(SDK_URL);
  const client = createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: invite === null, autoRefreshToken: invite === null,
      detectSessionInUrl: invite === null, flowType: 'pkce',
    },
  });
  let user = null;
  let state = defaultState();
  let revision = 0;
  let guest = null;
  let hostEmail = '';
  let hostTab = 'event';
  let busy = false;
  let media = [];
  let mediaUnavailable = false;
  let activeInvite = null;

  function notify(message) {
    const status = app.querySelector('#shared-status');
    if (status) status.textContent = message;
  }

  function layout(content, extra = '') {
    app.innerHTML = `<div class="landing shared-shell"><header class="top">
      <div class="brand">event<i>hub.</i></div>${extra}
      </header><main class="shared-main" id="shared-main">${content}</main>
      <p id="shared-status" class="shared-status" role="status" aria-live="polite"></p></div>`;
  }

  function showAuth() {
    const emailOptions = 'type="email" autocomplete="email" maxlength="254" required';
    const content = hostEmail ? form('code',
      `<p>Check ${escape(hostEmail)} for your sign-in email. If it includes a sign-in link, open it in this browser.</p>
      ${field('Email code', 'code', '', 'inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" required')}
      <div class="actions"><button>Verify code</button>${button('Use another email', 'change-email')}</div>`
    ) : form('email',
      `${field('Email address', 'email', '', emailOptions)}<button>Continue with email</button>`
    );
    layout(`<div class="auth"><div class="hero"><h1>Host workspace</h1>
      <p>Sign in to manage your event, guest list, music, and memories.</p></div>
      ${section('Host sign-in', content)}
      <p class="muted">Attending an event? Open the private invitation link from your host.</p></div>`);
  }

  function showGuest() {
    if (!guest) {
      layout(section('Invitation unavailable', '<p>Ask your host for a current invitation link.</p>'));
      return;
    }
    const {event, guest: household, songs = [], timeline = []} = guest;
    const rsvp = event.rsvp ? section('Your RSVP', form('rsvp',
      `<p>${escape(STATUS[household.status] ?? 'Pending')}</p>
      ${field('Party size', 'count', household.count, 'type="number" min="1" max="100" required')}
      <div class="actions"><button name="status" value="yes">I’m coming</button>
      <button class="secondary" name="status" value="no" formnovalidate>I can’t make it</button></div>`
    )) : '';
    const music = event.songs ? section('Song requests', form('guest-song',
      songFields() + '<button>Request song</button>'
    ) + sortedSongs(songs).map((song) => `<div class="item">
      <div class="grow"><strong>${escape(song.name)}</strong><div class="muted">${escape(song.artist)}</div></div>
      <span class="pill">${Number(song.votes)} votes</span>
      ${song.voted ? '<span class="pill">Voted</span>' : button('Vote', 'vote', song.id)}
    </div>`).join('')) : '';
    const karaoke = safeLink(event.karaoke);
    layout(`<div class="guest">${eventHero(event, 'Private invitation')}
      ${section(`Welcome, ${escape(household.name)}`,
        `${event.details ? `<p class="shared-details">${escape(event.details)}</p>` : ''}
        ${household.table ? `<p>Your table is <strong>${escape(household.table)}</strong>.</p>` : ''}
        ${karaoke ? `<p><a href="${escape(karaoke)}" target="_blank" rel="noopener noreferrer">Karaoke sign-up</a></p>` : ''}`)}
      ${rsvp}${music}${timeline.length ? section('Schedule', timelineRows(timeline, false)) : ''}
    </div>`);
  }

  function showHouseholds() {
    const add = form('add-guest', field('Household name', 'name', '', 'required maxlength="120"') +
      field('Party size', 'count', 1, 'type="number" min="1" max="100" required') + '<button>Add household</button>');
    const rows = state.guests.map((household) =>
      `<article class="card section"><h3>${escape(household.name)}</h3>
      ${form('edit-guest', field('Household name', 'name', household.name, 'required maxlength="120"') +
        field('Party size', 'count', household.count, 'type="number" min="1" max="100" required') +
        `<label class="field">RSVP<select name="status">${statusOptions(household.status)}</select></label>` +
        field('Table', 'table', household.table, 'maxlength="40"') +
        `<div class="actions"><button>Save household</button>
        ${button('Create fresh invite link', 'invite', household.id)}
        ${button('Expire invite', 'revoke', household.id)}
        ${button('Remove', 'remove-guest', household.id, 'danger')}</div>`, household.id)}
      ${activeInvite?.id === household.id ? `<label class="field">Private invite link
        <input value="${escape(activeInvite.url)}" readonly></label>
        <p class="muted">Anyone with this link can respond for this household. Creating a fresh link expires the previous one.</p>
        ${button('Copy link', 'copy')}` : ''}</article>`
    ).join('') || empty('No households yet.');
    return section('Add household', add) + rows;
  }

  function showMusic() {
    const songRow = (song) => `<div class="item">
      <div class="grow"><strong>${escape(song.name)}</strong><div class="muted">${escape(song.artist)}</div></div>
      <span class="pill">${Number(song.votes)} votes</span>
      ${button(song.played ? 'Restore' : 'Mark played', 'play', song.id)}
      ${button('Remove', 'remove-song', song.id, 'danger')}
    </div>`;
    const sorted = sortedSongs(state.songs);
    return section('Add to the queue', form('host-song', songFields() + '<button>Add song</button>')) +
      section('Request queue', sorted.filter((song) => !song.played).map(songRow).join('') || empty('No songs in the queue.')) +
      section('Played history', sorted.filter((song) => song.played).map(songRow).join('') || empty('Nothing has played yet.'));
  }

  function showPlanning() {
    const taskRows = state.tasks.map((task) => `<div class="item">
      <strong class="grow">${escape(task.name)} ${task.done ? '<span class="pill">Done</span>' : ''}</strong>
      ${button(task.done ? 'Reopen' : 'Complete', 'complete', task.id)}
      ${button('Remove', 'remove-task', task.id, 'danger')}
    </div>`).join('');
    return section('Planning checklist', form('task',
      field('Task', 'name', '', 'required maxlength="160"') + '<button>Add task</button>'
    ) + (taskRows || empty('No tasks yet.'))) + section('Run of show', form('timeline',
      field('Time', 'time', '', 'type="time" required') +
      field('Activity', 'name', '', 'required maxlength="160"') + '<button>Add activity</button>'
    ) + timelineRows(state.timeline, true));
  }

  function showMedia() {
    const items = media.map(({name, url, path, video}) => `<article>
      ${video ? `<video src="${escape(url)}" controls preload="metadata" playsinline></video>`
        : `<img src="${escape(url)}" alt="${escape(name)}" loading="lazy" decoding="async">`}
      <p class="grow">${escape(name)}</p>${button('Remove', 'remove-media', path, 'danger')}</article>`
    ).join('');
    return section('Private host album',
      `<p class="muted">Photos and videos are visible to the host account.</p>
      ${form('upload', `<label class="field">Photo or video
        <input name="media" type="file" accept="${MEDIA_TYPES.join(',')}" required></label>
        <p class="muted">Maximum 50 MB per file.</p><button>Upload</button>`)}
      ${mediaUnavailable ? '<p class="muted">The album could not be loaded. Try refreshing.</p>' : ''}
      ${items ? `<div class="gallery">${items}</div>` : empty('No uploads yet.')}`
    );
  }

  function showHost() {
    const tabs = [
      ['event', 'Event', () => section('Event settings', form('event', eventFields(state.event) + '<button>Save event</button>'))],
      ['guests', 'Guests', showHouseholds],
      ['music', 'Music', showMusic],
      ['planning', 'Planning', showPlanning],
      ['media', 'Album', showMedia],
    ];
    const nav = tabs.map(([name, label]) => `<button type="button" data-shared-action="tab" data-id="${name}"
      class="${hostTab === name ? 'active' : 'secondary'}" ${hostTab === name ? 'aria-current="page"' : ''}>${label}</button>`).join('');
    const view = tabs.find(([name]) => name === hostTab)[2]();
    layout(`${eventHero(state.event, 'Host workspace')}<nav aria-label="Workspace" class="actions shared-nav">${nav}</nav>${view}`,
      `<div class="actions"><span class="muted">${escape(user.email)}</span>
      ${button('Refresh', 'refresh')}${button('Sign out', 'signout')}</div>`);
  }

  async function rpc(name, args = {}) {
    const {data, error} = await client.rpc(`partyhub_${name}`, args);
    if (error) throw error;
    return data;
  }

  async function loadHost() {
    const workspace = await rpc('load');
    state = workspace?.state ?? defaultState();
    revision = workspace?.revision ?? 0;
  }

  async function saveHost(update) {
    const draft = structuredClone(state);
    update(draft);
    try {
      const workspace = await rpc('save', {p_revision: revision, p_state: draft});
      state = workspace.state;
      revision = workspace.revision;
    } catch (error) {
      if (error.code !== '40001') throw error;
      await loadHost();
      showHost();
      throw new Error('The event changed on another device. The latest data is loaded. Apply your change again.');
    }
    showHost();
    notify('Saved.');
  }

  async function loadMedia() {
    mediaUnavailable = false;
    try {
      const bucket = client.storage.from(BUCKET);
      const {data, error} = await bucket.list(user.id, {limit: 100, sortBy: {column: 'created_at', order: 'desc'}});
      if (error) throw error;
      const files = data.filter((file) => file.id && MEDIA_TYPES.includes(file.metadata?.mimetype));
      if (!files.length) {
        media = [];
        return;
      }
      const paths = files.map((file) => `${user.id}/${file.name}`);
      const signed = await bucket.createSignedUrls(paths, 900);
      if (signed.error) throw signed.error;
      media = files.flatMap((file, index) => {
        const url = signed.data[index]?.signedUrl;
        if (!url || new URL(url).origin !== apiOrigin) return [];
        return [{
          name: file.name.split('--').slice(1).join('--') || file.name,
          video: file.metadata.mimetype.startsWith('video/'), path: paths[index], url,
        }];
      });
    } catch {
      media = [];
      mediaUnavailable = true;
    }
  }

  async function loadGuest(action = 'guest', args = {}) {
    guest = await rpc(action, {p_token: invite, ...args});
    showGuest();
  }

  async function signIn(nextUser) {
    user = nextUser;
    activeInvite = null;
    media = [];
    if (!user) {
      hostEmail = '';
      showAuth();
      return;
    }
    hostTab = 'event';
    await loadHost();
    showHost();
  }

  function householdValues(values) {
    return {
      name: requiredText(values, 'name', 'Enter a household name.'),
      count: Number(values.get('count')),
    };
  }

  async function submit(action, target, id, submitter) {
    const values = new FormData(target);
    switch (action) {
      case 'email': {
        const email = cleanText(values, 'email');
        const {error} = await client.auth.signInWithOtp({email, options: {emailRedirectTo: basePage().href}});
        if (error) throw new Error('Could not send a sign-in email. Check the address or try again shortly.');
        hostEmail = email;
        showAuth();
        notify('Sign-in email sent.');
        return;
      }
      case 'code': {
        const token = cleanText(values, 'code');
        const {data, error} = await client.auth.verifyOtp({email: hostEmail, token, type: 'email'});
        if (error) throw new Error('That code is invalid or expired. Check the email or request a fresh code.');
        await signIn(data.user);
        return;
      }
      case 'rsvp': {
        const status = submitter?.value === 'no' ? 'no' : 'yes';
        const count = status === 'no' ? guest.guest.count : Number(values.get('count'));
        await loadGuest('rsvp', {p_status: status, p_count: count});
        notify('Your RSVP is saved.');
        return;
      }
      case 'guest-song': {
        await loadGuest('song', {
          p_name: requiredText(values, 'name', 'Enter a song title.'),
          p_artist: requiredText(values, 'artist', 'Enter an artist.'),
        });
        notify('Song request saved.');
        return;
      }
      case 'event': {
        const name = requiredText(values, 'name', 'Enter an event name.');
        const karaoke = cleanText(values, 'karaoke');
        if (karaoke && !safeLink(karaoke)) throw new Error('The karaoke link must start with https:// or http://.');
        await saveHost((draft) => {
          draft.event = {
            ...draft.event, name, karaoke, date: cleanText(values, 'date'), time: cleanText(values, 'time'),
            venue: cleanText(values, 'venue'), details: cleanText(values, 'details'),
            capacity: Number(values.get('capacity')), rsvp: values.has('rsvp'), songs: values.has('songs'),
          };
        });
        return;
      }
      case 'add-guest': {
        const incoming = householdValues(values);
        await saveHost((draft) => draft.guests.push({...incoming, id: crypto.randomUUID(), status: 'pending', table: ''}));
        return;
      }
      case 'edit-guest': {
        const incoming = {...householdValues(values), table: cleanText(values, 'table'), status: values.get('status')};
        await saveHost((draft) => Object.assign(draft.guests.find((item) => item.id === id), incoming));
        return;
      }
      case 'host-song': {
        const name = requiredText(values, 'name', 'Enter a song title.');
        const artist = requiredText(values, 'artist', 'Enter an artist.');
        await saveHost((draft) => {
          const exists = draft.songs.some((song) => !song.played && song.name.toLowerCase() === name.toLowerCase() &&
            song.artist.toLowerCase() === artist.toLowerCase());
          if (exists) throw new Error('This song is already in the queue.');
          draft.songs.push({id: crypto.randomUUID(), name, artist, votes: 0, played: false});
        });
        return;
      }
      case 'task': {
        const name = requiredText(values, 'name', 'Enter a task.');
        await saveHost((draft) => draft.tasks.push({id: crypto.randomUUID(), name, done: false}));
        return;
      }
      case 'timeline': {
        const name = requiredText(values, 'name', 'Enter an activity.');
        const time = cleanText(values, 'time');
        await saveHost((draft) => draft.timeline.push({id: crypto.randomUUID(), time, name}));
        return;
      }
      case 'upload': {
        const file = values.get('media');
        if (!(file instanceof File) || !file.size || !MEDIA_TYPES.includes(file.type) || file.size > MAX_MEDIA_BYTES) {
          throw new Error('Choose an accepted photo or video up to 50 MB.');
        }
        const name = file.name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(-100) || 'upload';
        const path = `${user.id}/${crypto.randomUUID()}--${name}`;
        const {error} = await client.storage.from(BUCKET).upload(path, file, {contentType: file.type, upsert: false});
        if (error) throw new Error('Could not upload the file.');
        await loadMedia();
        showHost();
        notify('File uploaded.');
        return;
      }
    }
  }

  async function act(action, id) {
    switch (action) {
      case 'tab':
        if (id === 'media') await loadMedia();
        hostTab = id;
        showHost();
        app.querySelector('[aria-current="page"]')?.focus();
        return;
      case 'refresh':
        await loadHost();
        if (hostTab === 'media') await loadMedia();
        showHost();
        notify('Up to date.');
        return;
      case 'signout': {
        const {error} = await client.auth.signOut({scope: 'local'});
        if (error) throw new Error('Could not sign out. Try again.');
        await signIn(null);
        return;
      }
      case 'change-email':
        hostEmail = '';
        showAuth();
        app.querySelector('input[name="email"]')?.focus();
        return;
      case 'invite': {
        if (!window.confirm('Create a fresh link for this household? Any previous link will expire.')) return;
        const token = await rpc('issue_invite', {p_guest_id: id});
        const url = basePage();
        url.hash = `invite=${token}`;
        activeInvite = {id, url: url.href};
        showHost();
        notify('Private invite link created.');
        return;
      }
      case 'copy':
        try {
          await navigator.clipboard.writeText(activeInvite.url);
          notify('Private invite link copied.');
        } catch {
          throw new Error('Select the invite link and copy it manually.');
        }
        return;
      case 'revoke':
        if (!window.confirm('Expire the invitation for this household?')) return;
        await rpc('revoke_invite', {p_guest_id: id});
        if (activeInvite?.id === id) activeInvite = null;
        showHost();
        notify('Private invite link expired.');
        return;
      case 'vote':
        await loadGuest('vote', {p_song_id: id});
        notify('Vote saved.');
        return;
      case 'play':
        await saveHost((draft) => {
          const song = draft.songs.find((item) => item.id === id);
          song.played = !song.played;
        });
        return;
      case 'complete':
        await saveHost((draft) => {
          const task = draft.tasks.find((item) => item.id === id);
          task.done = !task.done;
        });
        return;
      case 'remove-guest':
        if (!window.confirm('Remove this household and expire its invite?')) return;
        if (activeInvite?.id === id) activeInvite = null;
        await saveHost((draft) => { draft.guests = draft.guests.filter((item) => item.id !== id); });
        return;
      case 'remove-song':
        await saveHost((draft) => { draft.songs = draft.songs.filter((item) => item.id !== id); });
        return;
      case 'remove-task':
        await saveHost((draft) => { draft.tasks = draft.tasks.filter((item) => item.id !== id); });
        return;
      case 'remove-time':
        await saveHost((draft) => { draft.timeline = draft.timeline.filter((item) => item.id !== id); });
        return;
      case 'remove-media': {
        if (!window.confirm('Remove this file from your album?')) return;
        const {error} = await client.storage.from(BUCKET).remove([id]);
        if (error) throw new Error('Could not remove this file.');
        await loadMedia();
        showHost();
        notify('File removed.');
        return;
      }
    }
  }

  async function run(operation) {
    if (busy) return;
    busy = true;
    app.setAttribute('aria-busy', 'true');
    notify('Working…');
    try {
      await operation();
      if (app.querySelector('#shared-status')?.textContent === 'Working…') notify('');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not complete the request. Refresh and try again.');
    } finally {
      busy = false;
      app.removeAttribute('aria-busy');
    }
  }

  app.addEventListener('submit', (event) => {
    const target = event.target.closest('[data-shared-form]');
    if (!target) return;
    event.preventDefault();
    void run(() => submit(target.dataset.sharedForm, target, target.dataset.id, event.submitter));
  });
  app.addEventListener('click', (event) => {
    const target = event.target.closest('[data-shared-action]');
    if (target) void run(() => act(target.dataset.sharedAction, target.dataset.id));
  });

  window.addEventListener('hashchange', () => {
    if (readInvite() !== invite) window.location.reload();
  });

  layout('<p role="status">Loading PartyHub…</p>');
  if (invite !== null) {
    if (!/^[a-f0-9]{64}$/.test(invite)) {
      showGuest();
      return;
    }
    try {
      await loadGuest();
    } catch {
      showGuest();
    }
    return;
  }

  const {data, error} = await client.auth.getSession();
  if (error) throw new Error('PartyHub could not connect to host sign-in.');
  await signIn(data.session?.user ?? null);
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && user) setTimeout(() => { if (user) void signIn(null); });
  });
}
