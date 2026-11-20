'use strict';
// Phase 3: server-authoritative boarding date -> original journey date.
// This module is inert unless the backend's OVERNIGHT_BOOKING_ENABLED flag is
// explicitly true AND the bus has a separately approved routeTimingLiveV2.
// routeTimingDraftV2 is NEVER accepted as live booking authority.
const { previewBoarding, validateDirection } = require('./route_timing_review');

function overnightBookingEnabled(env = process.env) {
  return env.OVERNIGHT_BOOKING_ENABLED === 'true';
}
function validLocalServiceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function approvedBusView(bus) {
  const active = bus && bus.routeTimingLiveV2;
  if (!active || typeof active !== 'object' || Array.isArray(active) ||
      active.schemaVersion !== 2 || active.timezone !== 'Asia/Kolkata') {
    return null;
  }
  return { ...bus, routeTimingDraftV2: active };
}
function resolveApprovedBoarding(bus, busId, from, to, boardingDate) {
  if (!validLocalServiceDate(boardingDate)) {
    return { ok: false, error: 'Invalid boarding date. Use YYYY-MM-DD.' };
  }
  const approved = approvedBusView(bus);
  if (!approved) {
    return { ok: false, error: 'This bus has no approved overnight stop timetable.' };
  }
  // Both directions must be completely verified before activating a bus.
  // This prevents alternate-day Going/Return schedules using partial data.
  for (const reverse of [false, true]) {
    const checked = validateDirection(approved, reverse);
    if (!checked.ok) return { ok: false, error: `Unapproved ${reverse ? 'Return' : 'Going'} timetable: ${checked.error}` };
  }
  return previewBoarding(approved, busId, from, to, boardingDate);
}
function boardingAtIsClosed(bus, boardingAt, nowMs = Date.now()) {
  if (bus && bus.manualBookingClosed === true) return true;
  if (typeof boardingAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(boardingAt)) return true;
  const when = new Date(boardingAt);
  return !Number.isFinite(when.getTime()) || when.getTime() <= nowMs;
}
module.exports = { overnightBookingEnabled, validLocalServiceDate, approvedBusView,
  resolveApprovedBoarding, boardingAtIsClosed };
