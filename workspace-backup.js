import { eventHasTime, formatEventDate } from './calendar.js';

export const MAX_BACKUP_BYTES = 1024 * 1024;

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object.');
  }
  return value;
}

function text(value, maximum, label, required = false) {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) {
    throw new Error(label + ' must be valid text of up to ' + maximum + ' characters.');
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(label + ' must be an integer from ' + minimum + ' to ' + maximum + '.');
  }
  return value;
}

function flag(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be on or off.');
  return value;
}

function list(value, label, normalize) {
  if (!Array.isArray(value) || value.length > 1000) {
    throw new Error(label + ' must contain up to 1,000 entries.');
  }
  const ids = new Set();
  return value.map((entry, index) => {
    const item = label + ' entry ' + (index + 1);
    const record = object(entry, item);
    const id = text(record.id, 100, item + ' ID', true);
    if (ids.has(id)) throw new Error(label + ' contains a duplicate ID.');
    ids.add(id);
    return { id, ...normalize(record, item) };
  });
}

function eventDate(value) {
  if (value === '' || formatEventDate({ date: value })) return value;
  throw new Error('The event date is invalid.');
}

function eventTime(value, label, optional = false) {
  if ((optional && value === '') || eventHasTime({ time: value })) return value;
  throw new Error(label + ' must use 24-hour hours and minutes.');
}

function karaokeLink(value) {
  const link = text(value ?? '', 500, 'Karaoke link');
  if (!link) return '';
  try {
    const { protocol } = new URL(link);
    if (protocol === 'https:' || protocol === 'http:') return link;
  } catch {
    // Report invalid links with the same field-level message.
  }
  throw new Error('The karaoke link needs an HTTP or HTTPS address.');
}

function parseBackup(source) {
  let backup;
  try {
    backup = JSON.parse(source);
  } catch {
    throw new Error('Choose a valid PartyHub JSON export.');
  }
  const { event, guests, songs, tasks, timeline } = object(backup, 'Backup');
  const details = object(event, 'Event');
  return {
    event: {
      name: text(details.name, 120, 'Event name', true),
      date: eventDate(details.date),
      time: eventTime(details.time, 'Event time', true),
      venue: text(details.venue, 160, 'Venue'),
      capacity: integer(details.capacity, 1, 10000, 'Capacity'),
      karaoke: karaokeLink(details.karaoke),
      details: text(details.details, 2000, 'Arrival details'),
      rsvp: flag(details.rsvp, 'Guest RSVPs'),
      songs: flag(details.songs, 'Song requests'),
      media: false,
    },
    guests: list(guests, 'Households', (guest, label) => {
      if (!['pending', 'yes', 'no'].includes(guest.status)) throw new Error(label + ' has an invalid RSVP.');
      return {
        name: text(guest.name, 120, label + ' name', true),
        count: integer(guest.count, 1, 100, label + ' party size'),
        status: guest.status,
        table: text(guest.table ?? '', 40, label + ' table'),
      };
    }),
    songs: list(songs, 'Songs', (song, label) => ({
      name: text(song.name, 100, label + ' title', true),
      artist: text(song.artist, 100, label + ' artist', true),
      votes: integer(song.votes, 0, 99999999, label + ' vote count'),
      played: flag(song.played, label + ' played'),
    })),
    tasks: list(tasks, 'Tasks', (task, label) => ({
      name: text(task.name, 160, label + ' name', true),
      done: flag(task.done, label + ' complete'),
    })),
    timeline: list(timeline, 'Schedule', (entry, label) => ({
      name: text(entry.name, 160, label + ' name', true),
      time: eventTime(entry.time, label + ' time'),
    })),
  };
}

export async function readWorkspaceBackup(file) {
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_BACKUP_BYTES) {
    throw new Error('Choose a PartyHub JSON export of up to 1 MB.');
  }
  return parseBackup(await file.text());
}

export function downloadWorkspaceBackup(state) {
  const contents = JSON.stringify(state);
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'partyhub-workspace.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
