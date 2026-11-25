export function formatEventDate(event, locale) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date)) return '';
    const date = new Date(event.date + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== event.date) return '';
    return new Intl.DateTimeFormat(locale, {
        dateStyle: 'full', timeZone: 'UTC',
    }).format(date);
}

export function eventHasTime(event) {
    return typeof event.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(event.time);
}

const calendarText = value => String(value ?? '').replace(/\\/g, '\\\\')
    .replace(/\r\n|[\r\n]/g, '\\n').replace(/[,;]/g, '\\$&')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
function foldCalendarLine(line) {
    const encoder = new TextEncoder();
    let width = 0, output = '';
    for (const character of line) {
        const size = encoder.encode(character).length;
        if (width + size > 75) {
            output += '\r\n ';
            width = 1;
        }
        output += character;
        width += size;
    }
    return output;
}

export async function downloadEventCalendar(event) {
    if (!formatEventDate(event)) return;
    const date = event.date.replaceAll('-', '');
    const time = eventHasTime(event)
        ? event.time.replace(':', '') : '';
    const keyData = new TextEncoder().encode(JSON.stringify([event.name, event.date, event.time, event.venue]));
    const digest = await crypto.subtle.digest('SHA-256', keyData);
    const uid = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PartyHub//Event Calendar//EN',
        'BEGIN:VEVENT', `UID:${uid}@partyhub`, `DTSTAMP:${stamp}`,
        time ? `DTSTART:${date}T${time}00` : `DTSTART;VALUE=DATE:${date}`,
        `SUMMARY:${calendarText(event.name)}`, `LOCATION:${calendarText(event.venue)}`,
        `DESCRIPTION:${calendarText(event.details)}`, 'END:VEVENT', 'END:VCALENDAR',
    ];
    const content = lines.map(foldCalendarLine).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'partyhub-event.ics';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
