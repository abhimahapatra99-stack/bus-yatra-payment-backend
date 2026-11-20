'use strict';

// Pure, side-effect-free validation for the admin DRAFT timetable.
// No Firebase writes. No bookings, holds or payments may call this module
// as an activation mechanism. Production activation needs a separate release.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const dt = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== value ? null : dt;
}
function dateShift(date, offset) {
  const dt = localDate(date);
  if (!dt || !Number.isInteger(offset) || offset < -2 || offset > 2) return null;
  dt.setUTCDate(dt.getUTCDate() + offset);
  return dt.toISOString().slice(0, 10);
}
function stopKey(value) { return String(value ?? '').trim().toLocaleLowerCase('en'); }
function parseTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(value.trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridian = (match[3] || '').toUpperCase();
  if (minute > 59) return null;
  if (meridian) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (meridian === 'PM' ? 12 : 0);
  } else if (hour > 23) return null;
  return hour * 60 + minute;
}
function orderedBusStops(bus) {
  let stops = Array.isArray(bus?.routeStops)
    ? bus.routeStops.map(x => String(x ?? '').trim()) : [];
  if (stops.length < 2) stops = [String(bus?.from ?? '').trim(), String(bus?.to ?? '').trim()];
  if (stops.length < 2 || stops.length > 50 || stops.some(x => !x) ||
      new Set(stops.map(stopKey)).size !== stops.length) return null;
  return stops;
}
function validateDirection(bus, isReturnTrip) {
  const rawStops = orderedBusStops(bus);
  if (!rawStops) return { ok: false, error: 'Bus route stops are missing, duplicated or exceed 50.' };
  const expected = isReturnTrip ? [...rawStops].reverse() : rawStops;
  const draft = bus?.routeTimingDraftV2;
  if (!draft || draft.schemaVersion !== 2 || draft.timezone !== 'Asia/Kolkata') {
    return { ok: false, error: 'Draft schema version or Asia/Kolkata timezone is missing.' };
  }
  const rows = isReturnTrip ? draft.return : draft.going;
  if (!Array.isArray(rows) || rows.length !== expected.length) {
    return { ok: false, error: 'Save timings for every stop in the selected direction.' };
  }
  const validated = [];
  let previousDeparture = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        stopKey(row.stop) !== stopKey(expected[i])) {
      return { ok: false, error: `Stop #${i + 1} does not match the bus route order.` };
    }
    const isFirst = i === 0;
    const isLast = i === rows.length - 1;
    const arrOffset = row.arrivalDayOffset;
    const depOffset = row.departureDayOffset;
    const arr = isFirst ? null : parseTime(row.arrival);
    const dep = isLast ? null : parseTime(row.departure);
    // The UI stores BOTH day offsets on every row; validate even the unused
    // endpoint offset to reject corrupt drafts.
    if (![arrOffset, depOffset].every(n => Number.isInteger(n) && n >= 0 && n <= 2)) {
      return { ok: false, error: `Invalid day offset at ${expected[i]}.` };
    }
    if (!isFirst && arr === null) {
      return { ok: false, error: `Arrival time missing or invalid at ${expected[i]}.` };
    }
    if (!isLast && dep === null) {
      return { ok: false, error: `Departure time missing or invalid at ${expected[i]}.` };
    }
    if (isFirst && depOffset !== 0) {
      return { ok: false, error: 'Starting stop must depart on Same Day (day 0).' };
    }
    const arrivalMinute = arr === null ? null : arrOffset * 1440 + arr;
    const departureMinute = dep === null ? null : depOffset * 1440 + dep;
    if (arrivalMinute !== null && arrivalMinute <= previousDeparture) {
      return { ok: false, error: `Arrival at ${expected[i]} is not after previous stop departure.` };
    }
    if (departureMinute !== null && departureMinute < (arrivalMinute ?? previousDeparture)) {
      return { ok: false, error: `Departure at ${expected[i]} is before arrival.` };
    }
    if (departureMinute !== null) previousDeparture = departureMinute;
    if (arrivalMinute !== null && arrivalMinute > 3 * 1440) {
      return { ok: false, error: 'Timetable exceeds three days.' };
    }
    validated.push({ stop: expected[i], arrivalMinute, departureMinute,
      arrivalDayOffset: arrOffset, departureDayOffset: depOffset,
      arrivalTime: isFirst ? null : String(row.arrival).trim(),
      departureTime: isLast ? null : String(row.departure).trim() });
  }
  // The admin can update the bus start time after saving its draft. A stale
  // draft must not silently produce a different boarding timestamp.
  const configured = parseTime(isReturnTrip ? bus.returnDepartureTime : bus.departureTime);
  const firstDeparture = validated[0].departureMinute;
  if (configured !== null && configured !== firstDeparture) {
    return { ok: false, error: 'Draft first-stop departure differs from Bus Management. Review and resave.' };
  }
  return { ok: true, rows: validated, isReturnTrip };
}
function previewBoarding(bus, busId, from, to, boardingDate) {
  const stops = orderedBusStops(bus);
  if (!stops) return { ok: false, error: 'Invalid ordered route stops.' };
  if (!localDate(boardingDate)) return { ok: false, error: 'Use a real YYYY-MM-DD boarding date.' };
  const a = stops.findIndex(s => stopKey(s) === stopKey(from));
  const b = stops.findIndex(s => stopKey(s) === stopKey(to));
  if (a < 0 || b < 0 || a === b) {
    return { ok: false, error: 'Select two different configured route stops.' };
  }
  const isReturnTrip = a > b;
  const checked = validateDirection(bus, isReturnTrip);
  if (!checked.ok) return checked;
  const boardingRow = checked.rows.find(r => stopKey(r.stop) === stopKey(from));
  const dropRow = checked.rows.find(r => stopKey(r.stop) === stopKey(to));
  if (!boardingRow || !dropRow || boardingRow.departureMinute === null ||
      dropRow.arrivalMinute === null || dropRow.arrivalMinute <= boardingRow.departureMinute) {
    return { ok: false, error: 'Boarding or drop stop does not form a valid forward travel segment.' };
  }
  const serviceDate = dateShift(boardingDate, -boardingRow.departureDayOffset);
  if (!serviceDate) return { ok: false, error: 'Could not calculate original service date.' };
  const dropoffDate = dateShift(serviceDate, dropRow.arrivalDayOffset);
  const boardingMinutes = boardingRow.departureMinute % 1440;
  const dropoffMinutes = dropRow.arrivalMinute % 1440;
  const localTime = n => `${String(Math.floor(n/60)).padStart(2, '0')}:${String(n%60).padStart(2, '0')}`;
  const boardingAt = new Date(`${boardingDate}T${localTime(boardingMinutes)}:00+05:30`);
  const dropoffAt = new Date(`${dropoffDate}T${localTime(dropoffMinutes)}:00+05:30`);
  if (!Number.isFinite(boardingAt.getTime()) || !Number.isFinite(dropoffAt.getTime()) ||
      dropoffAt.getTime() <= boardingAt.getTime()) {
    return { ok: false, error: 'Stop event times are inconsistent.' };
  }
  return { ok: true, busId, from: boardingRow.stop, to: dropRow.stop,
    boardingDate, serviceDate, dropoffDate, isReturnTrip,
    boardingTime: boardingRow.departureTime, dropoffTime: dropRow.arrivalTime,
    boardingAt: boardingAt.toISOString(), dropoffAt: dropoffAt.toISOString(),
    journeyKey: `${busId}_${serviceDate}${isReturnTrip ? '_return' : ''}`,
    dayOffset: boardingRow.departureDayOffset };
}
module.exports = { dateShift, stopKey, parseTime, orderedBusStops, validateDirection, previewBoarding };
