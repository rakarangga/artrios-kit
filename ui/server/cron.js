// Five-field cron (minute hour day-of-month month day-of-week), local time. Pure: no I/O.
// Supports *, numbers, ranges a-b, lists a,b, and steps */n or a-b/n. Day-of-week 0-7 (0 and 7 = Sunday).
// Day-of-month and day-of-week follow classic cron: when both are restricted, either one matching is enough.

export class CronError extends Error {}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
];

function parseField(src, { name, min, max }) {
  const set = new Set();
  for (const part of src.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`bad ${name} field: "${src}"`);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : (m[4] !== undefined ? max : lo);
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new CronError(`${name} out of range: "${part}" (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`schedule needs 5 fields (minute hour day month weekday), got "${expr}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  return { expr: parts.join(' '), minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

export function matches(c, d) {
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

const floorMinute = (t) => { const d = new Date(t); d.setSeconds(0, 0); return d; };

// Fire times in the half-open window (from, to], oldest first, at most `limit`.
export function fireTimes(c, from, to, limit = 10000) {
  const out = [];
  const d = floorMinute(from);
  d.setMinutes(d.getMinutes() + 1);
  const end = to.getTime();
  while (d.getTime() <= end && out.length < limit) {
    if (matches(c, d)) out.push(new Date(d));
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}

// Next fire time after `from` (within ~1 year), or null.
export function nextFire(c, from) {
  const d = floorMinute(from);
  for (let i = 0; i < 366 * 1440; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (matches(c, d)) return new Date(d);
  }
  return null;
}
