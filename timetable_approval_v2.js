'use strict';
// Phase 8: pure validation. No network, no Firebase, no payments.
const crypto = require('crypto');
const { orderedBusStops, validateDirection, stopKey } = require('./route_timing_review');
const { validLocalServiceDate } = require('./overnight_booking_core');

function positiveFare(bus, stops, a, b, sleeper) {
  const base = Number(sleeper ? (bus.sleeperPrice ?? bus.price) : (bus.seatPrice ?? bus.price));
  const valid = n => Number.isFinite(n) && n > 0;
  if (bus.sameFareForAllStops === true) return valid(base);
  const typed = sleeper ? bus.sleeperRouteFares : bus.seatRouteFares;
  const legacy = sleeper ? null : bus.routeFares;
  const raw = typed && typeof typed === 'object' && Object.keys(typed).length ? typed : legacy;
  const fares = {};
  if (raw && typeof raw === 'object') for (const [key, value] of Object.entries(raw)) {
    const n = Number(value);
    if (valid(n)) fares[String(key).trim().toLowerCase()] = n;
  }
  const pair = (x, y) => fares[`${stopKey(stops[x])}|${stopKey(stops[y])}`] ?? fares[`${stopKey(stops[y])}|${stopKey(stops[x])}`];
  if (!Object.keys(fares).length) {
    const full = (a === 0 && b === stops.length - 1) || (b === 0 && a === stops.length - 1);
    return (sleeper || full) && valid(base);
  }
  if (valid(Number(pair(a, b)))) return true;
  const step = b > a ? 1 : -1;
  for (let i = a; i !== b; i += step) {
    if (!valid(Number(pair(i, i + step)))) return sleeper && valid(base);
  }
  return true;
}
function evaluate({ bus, busId, seatDocs, journeys, dates }) {
  const blockers = [];
  const stops = orderedBusStops(bus);
  const going = validateDirection(bus, false);
  const returning = validateDirection(bus, true);
  if (!going.ok) blockers.push(`Going: ${going.error}`);
  if (!returning.ok) blockers.push(`Return: ${returning.error}`);
  if (!stops) blockers.push('Invalid route stops.');
  if (bus.routeTimingLiveV2 != null) blockers.push('Approved timetable already exists; no overwrite in Phase 8.');
  if (bus.manualBookingClosed === true) blockers.push('Bus has manual booking closure.');
  const active = seatDocs.filter(x => x && x.blocked !== true);
  if (!active.length) blockers.push('No active seats.');
  const hasSleeper = active.some(x => String(x.seatType ?? '').toLowerCase().includes('sleeper'));
  const hasSeater = active.some(x => !String(x.seatType ?? '').toLowerCase().includes('sleeper'));
  if (stops) for (const sleeper of [false, true]) {
    if (!(sleeper ? hasSleeper : hasSeater)) continue;
    for (let a = 0; a < stops.length; a++) for (let b = 0; b < stops.length; b++) {
      if (a !== b && !positiveFare(bus, stops, a, b, sleeper)) {
        blockers.push(`Missing ${sleeper ? 'sleeper' : 'seater'} fare: ${stops[a]} -> ${stops[b]}`);
      }
    }
  }
  for (const [direction, date, key] of [
    ['Going', dates.going, `${busId}_${dates.going}`],
    ['Return', dates.return, `${busId}_${dates.return}_return`],
  ]) {
    if (!validLocalServiceDate(date)) blockers.push(`${direction} sample date invalid.`);
    else if (journeys[direction.toLowerCase()]?.serviceStatus !== 'scheduled') {
      blockers.push(`${direction} sample journey ${key} is not scheduled.`);
    }
  }
  return { ok: blockers.length === 0, blockers, activeSeats: active.length,
    hasSeater, hasSleeper, dates, goingValid: going.ok, returnValid: returning.ok };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function fingerprint({ bus, seats, journeys, dates }) {
  const relevant = {
    bus: Object.fromEntries(['routeTimingDraftV2','routeTimingLiveV2','routeStops','from','to',
      'departureTime','returnDepartureTime','manualBookingClosed','sameFareForAllStops',
      'price','seatPrice','sleeperPrice','seatRouteFares','sleeperRouteFares','routeFares']
      .map(k => [k, bus[k] ?? null])),
    // Fingerprint seat inventory including seat type + blocked flag, not customer PII.
    seats: seats.map(s => ({id:s.id, seatType:s.seatType ?? null, blocked:s.blocked === true}))
      .sort((a,b) => a.id.localeCompare(b.id)),
    journeys: { going: journeys.going?.serviceStatus ?? null,
      return: journeys.return?.serviceStatus ?? null }, dates,
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(relevant))).digest('hex');
}
function approvalRecord(bus, uid) {
  const draft = bus.routeTimingDraftV2;
  return {schemaVersion:2, timezone:'Asia/Kolkata',
    going:structuredClone(draft.going), return:structuredClone(draft.return),
    approvedBy:uid};
}
module.exports={evaluate,fingerprint,approvalRecord};
