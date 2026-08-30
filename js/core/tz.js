// The pool runs on Eastern time.
//
// Two separate reasons this matters, and only one of them is cosmetic:
//
//   * Rules. "Each week opens Tuesday at 6:00 AM" has to mean one instant for
//     everybody. Built with setHours() it meant 6am on whatever clock the
//     viewer's device happened to be set to, so the week opened three hours
//     apart for someone in California.
//   * Display. Everyone quotes NFL kickoffs in Eastern, and so should the board,
//     regardless of where a phone thinks it is.
//
// The zone is data (config.json), not a constant, so a league in another
// timezone only has to change one line.
import { CONFIG } from './data.js';

export function leagueZone(){
  return (CONFIG && CONFIG.timezone) || 'America/New_York';
}

/**
 * How far the league zone is from UTC at a given instant, in milliseconds.
 * Reads the real offset from Intl, so daylight saving is handled for free.
 */
function zoneOffsetMs(instant, zone){
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for(const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  // Some engines render midnight as hour 24.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second)
  );
  return asIfUtc - instant.getTime();
}

/**
 * The instant at which the league's wall clock reads the given date and time.
 * e.g. zonedToUtc(2026, 9, 15, 6, 0) is 6:00 AM Eastern on 15 Sep 2026.
 *
 * Two passes: the offset itself depends on the instant, so the first guess is
 * corrected once. That second pass is what makes the hour either side of a
 * daylight-saving change come out right.
 */
export function zonedToUtc(year, month, day, hour = 0, minute = 0){
  const zone = leagueZone();
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let ts = naive - zoneOffsetMs(new Date(naive), zone);
  ts = naive - zoneOffsetMs(new Date(ts), zone);
  return new Date(ts);
}

/** Same, from a "YYYY-MM-DD" string. */
export function zonedDateToUtc(dateStr, hour = 0, minute = 0){
  const [y, m, d] = dateStr.split('-').map(Number);
  return zonedToUtc(y, m, d, hour, minute);
}

/** Formats an instant on the league's clock, wherever the viewer actually is. */
export function formatInZone(date, options){
  const d = date instanceof Date ? date : new Date(date);
  if(isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { ...options, timeZone: leagueZone() });
}

/** Short label for the zone right now, e.g. "ET" -- DST aware. */
export function zoneLabel(date = new Date()){
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: leagueZone(), timeZoneName: 'short',
  }).formatToParts(date);
  const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
  return name;
}

/** A datetime-local input value on the league's clock, not the browser's. */
export function isoToZonedInput(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  const parts = {};
  for(const p of new Intl.DateTimeFormat('en-US', {
    timeZone: leagueZone(), hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(d)) parts[p.type] = p.value;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

/** The reverse: a datetime-local value typed on the league's clock. */
export function zonedInputToIso(value){
  if(!value) return null;
  const [datePart, timePart] = value.split('T');
  if(!datePart || !timePart) return null;
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  const dt = zonedToUtc(y, m, d, hh, mm);
  return isNaN(dt.getTime()) ? null : dt.toISOString();
}
