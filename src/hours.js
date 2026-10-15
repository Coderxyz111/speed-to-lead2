// Call-hours logic so the AI never rings someone at 11pm.
// call_hours: { start: "08:00", end: "19:00", days: [1..6] }  (0 = Sunday)

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { dow, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function isWithinHours(date, hours, timeZone) {
  const { dow, minutes } = localParts(date, timeZone);
  return hours.days.includes(dow) && minutes >= toMin(hours.start) && minutes < toMin(hours.end);
}

// Next moment calls are allowed (scans forward minute by minute, up to 8 days).
function nextOpening(date, hours, timeZone) {
  if (isWithinHours(date, hours, timeZone)) return date;
  let t = new Date(Math.ceil(date.getTime() / 60000) * 60000);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    t = new Date(t.getTime() + 60000);
    if (isWithinHours(t, hours, timeZone)) return t;
  }
  throw new Error('call_hours never open — check config');
}

module.exports = { isWithinHours, nextOpening };
