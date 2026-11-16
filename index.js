const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const fs = require("fs");

const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
require("dotenv").config();

const app = express();
app.use(cors());

// The webhook needs the EXACT raw payload to verify Razorpay's signature.
// Register before express.json(). Set RAZORPAY_WEBHOOK_SECRET in Render and
// configure /razorpay-webhook in the Razorpay Dashboard separately.
app.post("/razorpay-webhook", express.raw({ type: "application/json", limit: "100kb" }), async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret || !dependenciesReady()) {
      return res.status(503).json({ success: false, message: "Webhook is not configured." });
    }
    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ success: false, message: "Invalid webhook payload." });
    }
    const expected = crypto.createHmac("sha256", webhookSecret).update(req.body).digest("hex");
    const signature = req.headers["x-razorpay-signature"];
    if (!safeEqualHex(expected, signature)) {
      return res.status(400).json({ success: false, message: "Invalid webhook signature." });
    }
    const event = JSON.parse(req.body.toString("utf8"));
    if (!event || !["payment.captured", "order.paid"].includes(event.event)) {
      return res.json({ success: true, ignored: true });
    }
    const orderId = cleanString(
      event.event === "payment.captured"
        ? event.payload?.payment?.entity?.order_id
        : event.payload?.order?.entity?.id, 100
    );
    if (!orderId) return res.status(400).json({ success: false, message: "Missing order ID." });

    const snap = await db.collection("razorpay_orders").doc(orderId).get();
    // This Razorpay account may serve unrelated products. Only reconcile
    // orders created by Bus Yatra and owned by a known Firebase user.
    if (!snap.exists || !snap.data()?.userId) {
      return res.json({ success: true, ignored: true });
    }
    const ownedUserId = snap.data().userId;
    const internalReq = { firebaseUser: { uid: ownedUserId }, body: { orderId } };
    let outcomeStatus = 500;
    let outcome = null;
    const internalRes = {
      status(code) { outcomeStatus = code; return this; },
      json(body) { outcome = body; return this; },
    };
    await verifyCapturedPaymentAndBook(internalReq, internalRes, true);
    if (outcomeStatus === 200 && outcome?.bookingSaved === true) {
      return res.json({ success: true, bookingConfirmed: true });
    }
    if (outcomeStatus === 202 && outcome?.paymentReview === true) {
      // Review record was persisted; do not deliver a double booking.
      console.error("Webhook captured payment needs review:", orderId);
      return res.json({ success: true, paymentReview: true });
    }
    // Gateway may not yet show the captured payment; let Razorpay retry.
    return res.status(503).json({ success: false, message: "Payment reconciliation not complete." });
  } catch (error) {
    console.error("Razorpay webhook processing error:", error.message);
    return res.status(503).json({ success: false, message: "Webhook could not be processed." });
  }
});

app.use(express.json({ limit: "100kb" }));

const firebaseServiceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  "/etc/secrets/firebase-service-account.json";
let db = null;
let auth = null;
try {
  if (!fs.existsSync(firebaseServiceAccountPath)) throw new Error("Firebase service-account secret file not found.");
  const serviceAccount = JSON.parse(fs.readFileSync(firebaseServiceAccountPath, "utf8"));
  if (serviceAccount.type !== "service_account" || !serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("Firebase service-account required fields are missing.");
  }
  const appInstance = getApps().length
    ? getApps()[0]
    : initializeApp({
        credential: cert({
          projectId: serviceAccount.project_id,
          clientEmail: serviceAccount.client_email,
          privateKey: serviceAccount.private_key.replace(/\\n/g, "\n"),
        }),
        projectId: serviceAccount.project_id,
      });
  db = getFirestore(appInstance);
  auth = getAuth(appInstance);
  console.log("Firebase Admin initialized successfully.");
} catch (error) {
  db = null;
  auth = null;
  console.error("Firebase initialization failed:", error.message);
}

let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

function dependenciesReady() { return Boolean(razorpay && db && auth); }
function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const aa = Buffer.from(a, "hex"); const bb = Buffer.from(b, "hex");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function cleanString(value, max = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}
function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}
function journeyKeyFor(busId, dateString, isReturnTrip) {
  return `${busId}_${dateString}${isReturnTrip ? "_return" : ""}`;
}
// Trip Schedule v1: one explicitly published trip per bus, service date, and direction.
// Existing services remain in legacy mode until the operator deliberately sets
// TRIP_SCHEDULE_ENFORCED=true on Render after publishing operating dates.
function tripScheduleEnforced() {
  return process.env.TRIP_SCHEDULE_ENFORCED === "true";
}
function isPublishedTrip(data) {
  return data && data.serviceStatus === "scheduled";
}
function serviceDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = parseDate(value);
  if (!parsed) return null;
  // Calendar dates like 2026-02-31 must not silently roll over.
  const iso = new Date(parsed.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return iso === value ? value : null;
}
function isValidBusId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 150
    && !value.includes("/");
}

function publicSeatRef(journeyKey, seatId) {
  return db.collection("journeys").doc(journeyKey).collection("seat_status").doc(seatId);
}
function routeStopsFor(bus) {
  if (Array.isArray(bus.routeStops)) {
    const stops = bus.routeStops.map((s) => String(s).trim()).filter(Boolean);
    if (stops.length >= 2) return stops;
  }
  const from = cleanString(bus.from); const to = cleanString(bus.to);
  return from && to ? [from, to] : [];
}
function normalizeStop(s) { return String(s ?? "").trim().toLowerCase(); }
function routeFareFor(bus, from, to, sleeper) {
  const stops = routeStopsFor(bus);
  const start = stops.findIndex((s) => normalizeStop(s) === normalizeStop(from));
  const end = stops.findIndex((s) => normalizeStop(s) === normalizeStop(to));
  if (start < 0 || end < 0 || start === end) return null;
  const rawDefault = sleeper ? (bus.sleeperPrice ?? bus.price) : (bus.seatPrice ?? bus.price);
  const defaultPrice = Number.isFinite(Number(rawDefault)) ? Math.trunc(Number(rawDefault)) : null;
  if (bus.sameFareForAllStops === true) return defaultPrice;
  const selectedMap = sleeper ? bus.sleeperRouteFares : bus.seatRouteFares;
  const rawFares = selectedMap && typeof selectedMap === "object" && Object.keys(selectedMap).length
    ? selectedMap : (sleeper ? null : bus.routeFares);
  const fares = {};
  if (rawFares && typeof rawFares === "object") {
    for (const [key, value] of Object.entries(rawFares)) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) fares[key.toLowerCase()] = Math.trunc(n);
    }
  }
  const pairFare = (a, b) => fares[`${normalizeStop(a)}|${normalizeStop(b)}`] ?? fares[`${normalizeStop(b)}|${normalizeStop(a)}`] ?? null;
  if (!Object.keys(fares).length) {
    const wholeRoute = (start === 0 && end === stops.length - 1) || (start === stops.length - 1 && end === 0);
    return sleeper || wholeRoute ? defaultPrice : null;
  }
  const direct = pairFare(stops[start], stops[end]);
  if (direct !== null) return direct;
  let total = 0; const step = end > start ? 1 : -1;
  for (let i = start; i !== end; i += step) {
    const part = pairFare(stops[i], stops[i + step]);
    if (part === null) return sleeper ? defaultPrice : (stops.length === 2 ? defaultPrice : null);
    total += part;
  }
  return total;
}
function holdIsActive(data) {
  if (!data || !data.holdExpiresAt) return false;
  const expires = data.holdExpiresAt.toDate ? data.holdExpiresAt.toDate() : new Date(data.holdExpiresAt);
  return Number.isFinite(expires.getTime()) && expires.getTime() > Date.now();
}
function isExpiredTemporaryHold(data) {
  const status = String(data?.status || "").toLowerCase();
  return Boolean(data?.holdBookingId && ["pendingpayment", "femaleonly"].includes(status) && !holdIsActive(data));
}


function bookingClosed(bus, date, isReturnTrip = false) {
  if (bus.manualBookingClosed === true) return true;

  const timeValue = isReturnTrip
    ? bus.returnDepartureTime
    : bus.departureTime;

  let mins = null;

  // Outbound trip ke liye valid departureMinutes use karein.
  if (
    !isReturnTrip &&
    typeof bus.departureMinutes === "number" &&
    Number.isInteger(bus.departureMinutes) &&
    bus.departureMinutes >= 0 &&
    bus.departureMinutes < 1440
  ) {
    mins = bus.departureMinutes;
  }

  // Time string se minutes calculate karein.
  if (mins === null) {
    const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(
      String(timeValue ?? "").trim()
    );

    if (match) {
      let hour = Number(match[1]);
      const minute = Number(match[2]);
      const period = (match[3] || "").toUpperCase();

      if (period) {
        if (hour < 1 || hour > 12) return false;
        if (hour === 12) hour = 0;
        if (period === "PM") hour += 12;
      }

      if (
        hour >= 0 &&
        hour <= 23 &&
        minute >= 0 &&
        minute <= 59
      ) {
        mins = hour * 60 + minute;
      }
    }
  }

  // Time missing ya invalid hai to use midnight na samjhein.
  if (mins === null) return false;

  const departure = new Date(date.getTime() + mins * 60000);
  return Date.now() >= departure.getTime();
}


// Cancellation refund policy (India local journey time): >24h = 90%, >6h to 24h = 50%, <=6h = 0%.
function cancellationDeparture(bus, booking, date) {
  const isReturn = booking.isReturnTrip === true;
  const direct = booking.departureDateTime || booking.departureAt;
  if (direct && typeof direct.toDate === "function") return direct.toDate();
  if (direct) { const d = new Date(direct); if (Number.isFinite(d.getTime())) return d; }
  const timeValue = isReturn
    ? (bus?.returnDepartureTime || booking.returnDepartureTime)
    : (bus?.departureTime || booking.departureTime);
  let mins = null;
  if (!isReturn && Number.isInteger(bus?.departureMinutes) && bus.departureMinutes >= 0 && bus.departureMinutes < 1440) {
    mins = bus.departureMinutes;
  }
  if (mins === null) {
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(timeValue ?? "").trim());
    if (!m) return null;
    let h = Number(m[1]); const minute = Number(m[2]); const period = (m[3] || "").toUpperCase();
    if (period) { if (h < 1 || h > 12) return null; if (h === 12) h = 0; if (period === "PM") h += 12; }
    if (h > 23 || minute > 59) return null;
    mins = h * 60 + minute;
  }
  return new Date(date.getTime() + mins * 60000);
}
function cancellationRefundAmount(paidAmountPaise, departure, now = new Date()) {
  const hours = (departure.getTime() - now.getTime()) / 3600000;
  const percentage = hours > 24 ? 90 : (hours > 6 ? 50 : 0);
  return { percentage, amountPaise: Math.floor(paidAmountPaise * percentage / 100), hoursToDeparture: hours };
}


// Shared quote logic for the pre-cancellation screen and actual cancellation.
// The actual cancellation always recalculates this server-side.
function cancellationQuoteFor(booking, bus, journeyDate) {
  const paymentId = cleanString(booking.razorpayPaymentId || booking.paymentId, 100);
  const paidAmount = Number(booking.total ?? booking.amount ?? booking.fare ?? 0);
  const paidAmountPaise = Number.isFinite(paidAmount) && paidAmount > 0
    ? Math.round(paidAmount * 100) : 0;
  const method = String(booking.paymentMethod || "").trim().toLowerCase();
  const paid = String(booking.paymentStatus || "").trim().toLowerCase() === "paid";
  const onlinePaid = paid && (method === "razorpay" || Boolean(booking.razorpayOrderId));
  const departure = cancellationDeparture(bus, booking, journeyDate);

  let refundStatus = "not_applicable";
  let refundPercentage = 0;
  let refundAmountPaise = 0;
  if (onlinePaid) {
    if (!departure || paidAmountPaise <= 0) {
      // Never silently classify a paid Razorpay booking as non-refundable
      // merely because a field needed to automate the refund is missing.
      refundStatus = "needs_review";
    } else {
      const calc = cancellationRefundAmount(paidAmountPaise, departure);
      refundPercentage = calc.percentage;
      refundAmountPaise = calc.amountPaise;
      if (refundAmountPaise <= 0) refundStatus = "not_eligible";
      else refundStatus = paymentId ? "initiating" : "needs_review";
    }
  }
  return { paymentId, paidAmountPaise, onlinePaid, departure,
    refundStatus, refundPercentage, refundAmountPaise };
}

function cancellationStatusMessage(status) {
  switch (status) {
    case "successful": return "Razorpay marked the refund processed. The bank may take additional time to reflect the credit.";
    case "processing": return "Refund request accepted by Razorpay and is processing; the money is not yet confirmed credited.";
    case "initiating": return "Refund initiation is underway. Refresh the status shortly.";
    case "needs_review":
    case "pending_review":
    case "failed": return "Booking cancelled, but refund needs manual verification in Razorpay Dashboard. Contact support. Do not repeat the refund request.";
    case "not_eligible": return "Booking cancelled. The policy gives no refund within 6 hours of departure.";
    case "not_applicable": return "Booking cancelled. An automatic Razorpay refund is not applicable to this payment method.";
    default: return "Refund status is not yet confirmed; please check again or contact support.";
  }
}


async function requireFirebaseUser(req, res, next) {
  try {
    if (!auth) return res.status(503).json({ success: false, message: "Firebase authentication is not configured." });
    const header = req.headers.authorization || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return res.status(401).json({ success: false, message: "Please sign in again and retry." });
    req.firebaseUser = await auth.verifyIdToken(match[1], true);
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Your login session is invalid or expired. Please sign in again." });
  }
}

app.get("/", (_req, res) => res.json({ success: true, message: "Bus Yatra Payment Backend is running", firebaseConfigured: Boolean(db && auth), razorpayConfigured: Boolean(razorpay), ticketVerificationConfigured: Boolean(process.env.TICKET_VERIFY_SECRET && process.env.TICKET_VERIFY_SECRET.length >= 32), tripScheduleEnforced: tripScheduleEnforced() }));

// ---------------------------------------------------------------------------
// BUS YATRA VERIFIED E-TICKET - read-only endpoints.
// QR tokens are signed server-side; no payment signature or phone is in the QR.
// Configure TICKET_VERIFY_SECRET (32+ strong random chars) in Render.
// ---------------------------------------------------------------------------
const TICKET_VERIFY_SECRET = process.env.TICKET_VERIFY_SECRET || "";
const TICKET_VERIFY_BASE = (process.env.TICKET_VERIFY_BASE_URL ||
  "https://bus-yatra-payment-backend-1.onrender.com").replace(/\/+$/, "");
const ticketServiceReady = () => Boolean(db && auth && TICKET_VERIFY_SECRET.length >= 32);
const ticketIdValid = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{3,80}$/.test(id);
function signedTicketToken(bookingId) {
  return crypto.createHmac("sha256", TICKET_VERIFY_SECRET)
    .update(`bus-yatra-ticket-v1:${bookingId}`, "utf8")
    .digest("hex");
}
function htmlEscape(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function ticketDate(booking) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(booking.journeyDateString || ""))) {
    return booking.journeyDateString;
  }
  const date = booking.journeyDate?.toDate?.();
  if (!date) return "Date not available";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(date);
}
function ticketIsValid(booking) {
  return booking && String(booking.status || "").toLowerCase() === "confirmed" &&
    String(booking.paymentStatus || "").toLowerCase() === "paid";
}

// Customer requests an e-ticket package using their Firebase ID token.
// Return only the data required to render THEIR confirmed ticket.
app.post("/ticket-package", requireFirebaseUser, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!ticketServiceReady()) {
      return res.status(503).json({ success: false, message: "Ticket verification is not configured. Contact support before downloading." });
    }
    const bookingId = cleanString(req.body?.bookingId, 80);
    if (!ticketIdValid(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID." });
    }
    const snap = await db.collection("bookings").doc(bookingId).get();
    // Do not reveal whether another customer's booking exists.
    if (!snap.exists || snap.data()?.userId !== req.firebaseUser.uid) {
      return res.status(404).json({ success: false, message: "Ticket not found for this account." });
    }
    const b = snap.data();
    if (!ticketIsValid(b)) {
      return res.status(409).json({ success: false, message: "Only paid, confirmed bookings have a valid ticket." });
    }
    const seatIds = Array.isArray(b.selectedSeats) ? b.selectedSeats.map((x) => String(x)) : [];
    if (!seatIds.length || !b.busId) {
      return res.status(409).json({ success: false, message: "Booking seat information is incomplete; contact support." });
    }
    let seatLayout = [];
    try {
      const seatSnap = await db.collection("buses").doc(String(b.busId)).collection("seats").get();
      seatLayout = seatSnap.docs.map((seatDoc) => {
        const s = seatDoc.data();
        const row = Number(s.row);
        const position = Number(s.position);
        if (!Number.isInteger(row) || !Number.isInteger(position) || row < 0 || position < 0 || row > 40 || position > 3 ||
          s.row === undefined || s.position === undefined) return null;
        return {
          seatId: String(s.seatId || seatDoc.id),
          deck: String(s.deck || "lower").toLowerCase() === "upper" ? "upper" : "lower",
          type: String(s.seatType || "seater"), row, position,
        };
      }).filter(Boolean);
    } catch (layoutError) {
      console.error("Ticket layout unavailable:", layoutError.message);
      // A ticket remains downloadable even if the seat layout cannot load.
    }
    const verifyUrl = `${TICKET_VERIFY_BASE}/ticket-verify?id=${encodeURIComponent(bookingId)}&token=${signedTicketToken(bookingId)}`;
    return res.json({
      success: true,
      verifyUrl,
      ticket: {
        bookingId,
        busName: String(b.busName || ""), busType: String(b.busType || ""),
        from: String(b.from || ""), to: String(b.to || ""),
        date: ticketDate(b),
        departureTime: String(b.departureTime || ""), arrivalTime: String(b.arrivalTime || ""),
        passengerName: String(b.passengerName || ""),
        gender: String(b.gender || ""),
        mobile: String(b.mobile || ""),
        email: String(b.email || ""),
        seats: seatIds,
        total: Number(b.total) || 0,
        paymentMethod: String(b.paymentMethod || ""),
        status: "confirmed", paymentStatus: "paid",
      },
      seatLayout,
    });
  } catch (error) {
    console.error("Ticket package error:", error.message);
    return res.status(500).json({ success: false, message: "Ticket could not be prepared. Please retry." });
  }
});

// The QR is a signed public URL. Always check Firestore LIVE: a cancellation
// immediately invalidates the old printed QR. No personal phone/email displayed.
app.get("/ticket-verify", async (req, res) => {
  res.set({ "Cache-Control": "no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
  const page = (title, message, color, details = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bus Yatra Ticket Verification</title><style>body{margin:0;background:#fff3f3;font-family:Arial,sans-serif;color:#232323;padding:28px}.panel{max-width:520px;margin:30px auto;background:white;border-radius:20px;box-shadow:0 8px 25px #0001;padding:24px}.brand{background:#ba0d1e;color:white;padding:18px;border-radius:13px;font-size:25px;font-weight:800}h1{font-size:24px;color:${color}}p{line-height:1.6}dl{display:grid;grid-template-columns:120px 1fr;gap:12px}dt{color:#666}dd{margin:0;font-weight:bold}.note{color:#666;font-size:12px}</style></head><body><main class="panel"><div class="brand">BUS YATRA</div><h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p>${details}<p class="note">Live verification from Bus Yatra. Always compare booking details with the passenger's ticket.</p></main></body></html>`;
  try {
    if (!ticketServiceReady()) return res.status(503).send(page("Verification unavailable", "Ticket verification is temporarily unavailable.", "#b45309"));
    const id = cleanString(req.query.id, 80);
    const token = cleanString(req.query.token, 100);
    if (!ticketIdValid(id) || !safeEqualHex(signedTicketToken(id), token)) {
      return res.status(400).send(page("INVALID TICKET", "The ticket QR is invalid or has been modified.", "#b91c1c"));
    }
    const snap = await db.collection("bookings").doc(id).get();
    if (!snap.exists) return res.status(404).send(page("INVALID TICKET", "Booking does not exist.", "#b91c1c"));
    const b = snap.data();
    const valid = ticketIsValid(b);
    const detailRows = [
      ["Booking ID", id],
      ["Bus", b.busName],
      ["Route", `${b.from || ""} to ${b.to || ""}`],
      ["Journey", ticketDate(b)],
      ["Seats", Array.isArray(b.selectedSeats) ? b.selectedSeats.join(", ") : "N/A"],
      ["Booking", String(b.status || "unknown").toUpperCase()],
      ["Payment", String(b.paymentStatus || "unknown").toUpperCase()],
    ];
    const details = `<dl>${detailRows.map(([label, value]) => `<dt>${htmlEscape(label)}</dt><dd>${htmlEscape(value)}</dd>`).join("")}</dl>`;
    return res.status(200).send(page(valid ? "VALID TICKET" : "NOT VALID FOR BOARDING", valid ? "Confirmed booking and paid payment verified." : "This booking is no longer confirmed and paid. Do not board using this ticket.", valid ? "#15803d" : "#b91c1c", details));
  } catch (error) {
    console.error("Ticket verify error:", error.message);
    return res.status(503).send(page("Verification unavailable", "Could not check current booking status. Please retry.", "#b45309"));
  }
});

app.get("/razorpay-key", (_req, res) => {
  if (!razorpay || !process.env.RAZORPAY_KEY_ID) return res.status(503).json({ success: false, message: "Razorpay is not configured." });
  return res.json({ success: true, keyId: process.env.RAZORPAY_KEY_ID });
});

// Published schedules for the customer search results. Does not expose personal data.
app.get("/trip-schedules", async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  try {
    if (!db) return res.status(503).json({ success: false, message: "Schedule service unavailable." });
    const date = serviceDateString(req.query.date);
    if (!date) return res.status(400).json({ success: false, message: "Date must be YYYY-MM-DD." });
    const snap = await db.collection("journeys").where("scheduleDate", "==", date).limit(1000).get();
    if (snap.size === 1000) return res.status(503).json({ success: false,
      message: "Schedule list is too large for a safe complete result. Contact support." });
    const publishedKeys = snap.docs.filter(d => isPublishedTrip(d.data())).map(d => d.id);
    return res.json({ success: true, enforced: tripScheduleEnforced(), publishedKeys });
  } catch (error) {
    console.error("Schedule list failed:", error.message);
    return res.status(503).json({ success: false, message: "Could not check bus schedules." });
  }
});

// Per-trip availability: used by the admin planner and for debugging.
app.get("/trip-schedule-status", async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  try {
    if (!db) return res.status(503).json({ success: false, message: "Schedule service unavailable." });
    const busId = cleanString(req.query.busId, 150);
    const date = serviceDateString(req.query.date);
    const isReturnTrip = req.query.isReturnTrip === "true";
    if (!isValidBusId(busId) || !date) return res.status(400).json({ success: false, message: "Invalid bus/date." });
    const snap = await db.collection("journeys").doc(journeyKeyFor(busId, date, isReturnTrip)).get();
    const data = snap.exists ? snap.data() : {};
    return res.json({ success: true, enforced: tripScheduleEnforced(),
      status: data.serviceStatus || "not_scheduled", salesStarted: data.salesStarted === true,
      date, isReturnTrip });
  } catch (error) {
    console.error("Trip status failed:", error.message);
    return res.status(503).json({ success: false, message: "Could not read trip schedule." });
  }
});

// Only a Firestore-confirmed admin can publish dates or mark dates as not running.
// One document per journey; booking/order transactions read/write the same doc.
app.post("/admin/trip-schedule", requireFirebaseUser, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ success: false, message: "Database unavailable." });
    const admin = await db.collection("users").doc(req.firebaseUser.uid).get();
    if (!admin.exists || String(admin.data().role || "").toLowerCase() !== "admin") {
      return res.status(403).json({ success: false, message: "Admin access required." });
    }
    const busId = cleanString(req.body?.busId, 150);
    const date = serviceDateString(req.body?.date);
    const isReturnTrip = req.body?.isReturnTrip === true;
    const status = cleanString(req.body?.status, 30);
    if (!isValidBusId(busId) || !date || !["scheduled", "not_running"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid bus, date or status." });
    }
    const todayIndia = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (date < todayIndia) return res.status(400).json({ success: false, message: "Past service dates cannot be edited." });
    const busSnap = await db.collection("buses").doc(busId).get();
    if (!busSnap.exists) return res.status(404).json({ success: false, message: "Bus not found." });
    const bus = busSnap.data();
    if (status === "scheduled" && bookingClosed(bus, parseDate(date), isReturnTrip)) {
      return res.status(409).json({ success: false, message: "Departure has passed or booking is closed; cannot publish this trip." });
    }
    if (isReturnTrip && !cleanString(bus.returnDepartureTime, 40)) {
      return res.status(409).json({ success: false, message: "Return-trip departure time is not configured." });
    }
    const key = journeyKeyFor(busId, date, isReturnTrip);
    const tripRef = db.collection("journeys").doc(key);
    // Legacy booked/held seats may exist before schedule rollout. Do not cancel
    // a service with those reservations: a separate trip-cancellation/refund flow is required.
    if (status !== "scheduled") {
      const seatDocs = await tripRef.collection("seats").where("status", "in", ["booked", "pendingPayment", "femaleOnly"]).limit(1).get();
      if (!seatDocs.empty) return res.status(409).json({ success: false, message: "This trip has existing seats/reservations. Do not mark No Service; use a managed trip-cancellation process." });
    }
    await db.runTransaction(async tx => {
      const snap = await tx.get(tripRef);
      if (status !== "scheduled" && snap.exists && snap.data().salesStarted === true) {
        throw new Error("Sales have already started for this trip. Contact support to cancel an existing service safely.");
      }
      tx.set(tripRef, {
        busId, scheduleDate: date, isReturnTrip, serviceStatus: status,
        scheduleUpdatedBy: req.firebaseUser.uid, scheduleUpdatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    return res.json({ success: true, journeyKey: key, status,
      message: status === "scheduled" ? "Trip published for this date." : "No service recorded for this date." });
  } catch (error) {
    console.error("Admin trip schedule failed:", error.message);
    return res.status(409).json({ success: false, message: error.message || "Could not update trip." });
  }
});

// Create an authenticated order. Amount is calculated from Firestore, never trusted from Flutter.
app.post("/create-order", requireFirebaseUser, async (req, res) => {
  let reservationCreated = false;
  let reservationContext = null;
  let createdGatewayOrder = null;
  let orderRecordSaved = false;
  try {
    if (!dependenciesReady()) return res.status(503).json({ success: false, message: "Payment service is not fully configured." });
    const body = req.body || {};
    const bookingId = cleanString(body.bookingId, 40);
    const busId = cleanString(body.busId, 150);
    const from = cleanString(body.from, 100); const to = cleanString(body.to, 100);
    const journeyDateString = cleanString(body.journeyDate, 10);
    const journeyDate = parseDate(journeyDateString);
    const isReturnTrip = body.isReturnTrip === true;
    const gender = cleanString(body.gender, 20).toLowerCase();
    const passengerName = cleanString(body.passengerName, 150);
    const mobile = cleanString(body.mobile, 30);
    const selectedSeats = Array.isArray(body.selectedSeats) ? [...new Set(body.selectedSeats.map((s) => cleanString(s, 40)).filter(Boolean))] : [];
    if (!bookingId || !busId || !from || !to || !journeyDate || !passengerName || !mobile || !["female", "male", "other"].includes(gender) || !selectedSeats.length || selectedSeats.length > 10) {
      return res.status(400).json({ success: false, message: "Booking details are incomplete or invalid." });
    }
    if (selectedSeats.some((s) => !/^[a-zA-Z0-9_-]+$/.test(s))) return res.status(400).json({ success: false, message: "One or more seat IDs are invalid." });
    const busRef = db.collection("buses").doc(busId);
    const busSnap = await busRef.get();
    if (!busSnap.exists) return res.status(400).json({ success: false, message: "Selected bus was not found." });
    const bus = busSnap.data();
    if (bookingClosed(bus, journeyDate, isReturnTrip)) {
  return res.status(409).json({
    success: false,
    message: "Booking is closed for this bus or it has already departed."
  });
}
    const fareBySeat = {};
    let totalRupees = 0;
    const busSeatsRef = busRef.collection("seats");
    const journeyKey = journeyKeyFor(busId, journeyDateString, isReturnTrip);
    const tripScheduleRef = db.collection("journeys").doc(journeyKey);
    if (tripScheduleEnforced()) {
      const tripSnap = await tripScheduleRef.get();
      if (!tripSnap.exists || !isPublishedTrip(tripSnap.data())) {
        return res.status(409).json({ success: false,
          message: "This bus is not scheduled on the selected date. Please select another date." });
      }
    }
    const journeySeatsRef = tripScheduleRef.collection("seats");
    const seatSnapshots = await Promise.all(selectedSeats.map((id) => busSeatsRef.doc(id).get()));
    const journeySnapshots = await Promise.all(selectedSeats.map((id) => journeySeatsRef.doc(id).get()));
    const pairIds = new Set();
    for (let i = 0; i < selectedSeats.length; i++) {
      const seatId = selectedSeats[i]; const seatSnap = seatSnapshots[i]; const journeySnap = journeySnapshots[i];
      if (!seatSnap.exists) return res.status(409).json({ success: false, message: `Seat ${seatId} does not exist on this bus.` });
      const seat = seatSnap.data(); const journey = journeySnap.exists ? journeySnap.data() : {};
      const status = String(journey.status || "available").toLowerCase();
      if (["booked", "blocked"].includes(status) || (status === "pendingpayment" && holdIsActive(journey))) return res.status(409).json({ success: false, message: `Seat ${seatId} is not available. Please select seats again.` });
      if ((status === "femaleonly" || journey.femaleOnly === true) && gender !== "female" && !isExpiredTemporaryHold(journey)) return res.status(409).json({ success: false, message: `Seat ${seatId} is reserved for female passengers.` });
      if (seat.blocked === true || String(seat.status || "").toLowerCase() === "blocked") return res.status(409).json({ success: false, message: `Seat ${seatId} is permanently blocked.` });
      const isSleeper = String(seat.seatType || "seater").toLowerCase() === "sleeper";
      const fare = routeFareFor(bus, from, to, isSleeper);
      if (!Number.isInteger(fare) || fare < 0) return res.status(400).json({ success: false, message: `Fare is not configured for ${from} to ${to}. Please contact the bus operator.` });
      fareBySeat[seatId] = fare; totalRupees += fare;
      const pairId = cleanString(seat.pairSeatId, 40); if (pairId) pairIds.add(pairId);
    }
    if (!Number.isSafeInteger(totalRupees) || totalRupees <= 0) return res.status(400).json({ success: false, message: "The calculated fare is invalid." });
    const clientTotal = body.clientTotal;
    if (typeof clientTotal !== "number" || !Number.isSafeInteger(clientTotal) || clientTotal !== totalRupees) {
      return res.status(409).json({ success: false, message: `The fare has changed. Current fare is ₹${totalRupees}. Please go back and review your booking.` });
    }
    // Female passenger booking may protect the paired seat; never override an already occupied/blocked pair.
    const protectedSeatIds = [];
    if (gender === "female") {
      for (const pairId of pairIds) {
        if (selectedSeats.includes(pairId)) continue;
        const pairSnap = await journeySeatsRef.doc(pairId).get();
        const pair = pairSnap.exists ? pairSnap.data() : {};
        const pairStatus = String(pair.status || "available").toLowerCase();
        if (!["booked", "blocked"].includes(pairStatus) && !(pairStatus === "pendingpayment" && holdIsActive(pair)) && !((pairStatus === "femaleonly" || pair.femaleOnly === true) && !isExpiredTemporaryHold(pair))) protectedSeatIds.push(pairId);
      }
    }
    const holdExpiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));
    const bookingRef = db.collection("bookings").doc(bookingId);
    reservationContext = { bookingId, userId: req.firebaseUser.uid, journeyKey, selectedSeats, protectedSeatIds };

    // Atomically claim all requested seats before creating the gateway order.
    await db.runTransaction(async (tx) => {
      const existingBooking = await tx.get(bookingRef);
      if (existingBooking.exists) throw new Error("This booking ID has already been used. Please retry checkout.");
      const tripScheduleSnap = await tx.get(tripScheduleRef);
      if (tripScheduleEnforced() && (!tripScheduleSnap.exists || !isPublishedTrip(tripScheduleSnap.data()))) {
        throw new Error("No bus service is published for this date. Payment has not started.");
      }
      const selectedSnaps = {};
      const pairSnaps = {};
      for (const id of selectedSeats) {
        selectedSnaps[id] = await tx.get(journeySeatsRef.doc(id));
      }
      for (const id of protectedSeatIds) {
        pairSnaps[id] = await tx.get(journeySeatsRef.doc(id));
      }
      for (const id of selectedSeats) {
        const current = selectedSnaps[id].exists ? selectedSnaps[id].data() : {};
        const status = String(current.status || "available").toLowerCase();
        if (["booked", "blocked"].includes(status) || (status === "pendingpayment" && holdIsActive(current)) || ((status === "femaleonly" || current.femaleOnly === true) && gender !== "female" && !isExpiredTemporaryHold(current))) {
          throw new Error(`Seat ${id} was just taken by another customer or is unavailable. Please select again.`);
        }
        if ((status === "femaleonly" || current.femaleOnly === true) && gender !== "female" && !isExpiredTemporaryHold(current)) {
          throw new Error(`Seat ${id} is reserved for female passengers.`);
        }
      }
      for (const id of protectedSeatIds) {
        const current = pairSnaps[id].exists ? pairSnaps[id].data() : {};
        const status = String(current.status || "available").toLowerCase();
        if (["booked", "blocked"].includes(status) || ((status === "femaleonly" || current.femaleOnly === true) && !isExpiredTemporaryHold(current)) || (status === "pendingpayment" && holdIsActive(current))) {
          throw new Error(`A paired seat (${id}) is no longer available. Please select seats again.`);
        }
      }
      for (const id of selectedSeats) {
        tx.set(journeySeatsRef.doc(id), {
          seatId: id, status: "pendingPayment", holdBookingId: bookingId, holdUserId: req.firebaseUser.uid,
          holdExpiresAt, femaleOnly: FieldValue.delete(), protectedByBookingId: FieldValue.delete(),
          busId, journeyDate: Timestamp.fromDate(journeyDate),
        }, { merge: true });
        tx.set(publicSeatRef(journeyKey, id), {
          seatId: id, status: "pendingPayment", holdExpiresAt, updatedAt: FieldValue.serverTimestamp(),
          femaleOnly: FieldValue.delete(),
        }, { merge: true });
      }
      for (const id of protectedSeatIds) {
        tx.set(journeySeatsRef.doc(id), {
          seatId: id, status: "femaleOnly", femaleOnly: true, protectedByBookingId: bookingId,
          holdBookingId: bookingId, holdUserId: req.firebaseUser.uid, holdExpiresAt, busId,
          journeyDate: Timestamp.fromDate(journeyDate),
        }, { merge: true });
        tx.set(publicSeatRef(journeyKey, id), {
          seatId: id, status: "femaleOnly", femaleOnly: true, holdExpiresAt,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      // A sale was initiated; prevents an admin from silently unpublishing
      // this trip while its payment is in flight or after it has been sold.
      tx.set(tripScheduleRef, { salesStarted: true, lastSaleAttemptAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    reservationCreated = true;

// Razorpay Orders API has no documented expire_by parameter.
// The 10-minute seat hold is enforced by Firestore during verification.
// Important: an order may still be paid after that hold expires;
// such a captured payment goes to manual reconciliation, never an unverified booking.
const order = await razorpay.orders.create({
  amount: totalRupees * 100,
  currency: "INR",
  receipt: bookingId,
  partial_payment: false,
});

createdGatewayOrder = order;

await db.collection("razorpay_orders").doc(order.id).set({
  orderId: order.id,
  bookingId,
  userId: req.firebaseUser.uid,
  amount: order.amount,
  currency: order.currency,
  status: "created",
  verified: false,

  busId,
  busName: cleanString(bus.busName || bus.name || "Bus Yatra Bus", 150),
  from,
  to,
  journeyDate: journeyDateString,
  journeyKey,
  isReturnTrip,
  scheduleRequiredAtOrder: tripScheduleEnforced(),
  passengerName,
  mobile,
  email: cleanString(req.firebaseUser.email || body.email, 200),
  gender,

  selectedSeats,
  fareBySeat,
  protectedSeatIds,
  total: totalRupees,
  busType: cleanString(bus.busType, 100),
  departureTime: cleanString(bus.departureTime, 50),
  arrivalTime: cleanString(bus.arrivalTime, 50),

  holdExpiresAt,

  createdAt: FieldValue.serverTimestamp(),
});

    orderRecordSaved = true;
    return res.status(200).json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency, bookingId, total: totalRupees, holdExpiresAt: holdExpiresAt.toDate().toISOString() });
  } catch (error) {
    console.error("Create order failed:", error.message);
    // If Razorpay created an order but Firestore failed to save its metadata,
    // persist a reconciliation record before releasing the reservation. The orderId
    // is not returned to Flutter on this failed request, so checkout cannot proceed
    // through this response; still keep an audit trail for operational recovery.
    if (createdGatewayOrder && !orderRecordSaved && db && reservationContext) {
      try {
        await db.collection("payment_recovery").doc(`order-create-${createdGatewayOrder.id}`).set({
          recoveryType: "gateway_order_metadata_save_failed",
          orderId: createdGatewayOrder.id,
          bookingId: reservationContext.bookingId,
          userId: reservationContext.userId,
          journeyKey: reservationContext.journeyKey,
          selectedSeats: reservationContext.selectedSeats,
          protectedSeatIds: reservationContext.protectedSeatIds,
          amount: createdGatewayOrder.amount,
          currency: createdGatewayOrder.currency,
          reason: cleanString(error.message, 500),
          status: "needs_review",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (recoveryError) {
        console.error("CRITICAL: gateway order recovery record could not be saved:", recoveryError.message);
      }
    }
    if (reservationCreated && reservationContext && db) {
      try {
        const journeySeatsRef = db.collection("journeys").doc(reservationContext.journeyKey).collection("seats");
        await db.runTransaction(async (tx) => {
          const refs = [...reservationContext.selectedSeats, ...reservationContext.protectedSeatIds].map((id) => journeySeatsRef.doc(id));
          const snaps = [];
          for (const ref of refs) snaps.push(await tx.get(ref));
          refs.forEach((ref, i) => {
            if (snaps[i].exists && snaps[i].data().holdBookingId === reservationContext.bookingId) {
              tx.set(ref, { status: "available", femaleOnly: FieldValue.delete(), protectedByBookingId: FieldValue.delete(), holdBookingId: FieldValue.delete(), holdUserId: FieldValue.delete(), holdExpiresAt: FieldValue.delete() }, { merge: true });
              tx.set(publicSeatRef(reservationContext.journeyKey, refs[i].id), { status: "available", femaleOnly: FieldValue.delete(), holdExpiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
            }
          });
        });
      } catch (releaseError) {
        console.error("Could not release failed checkout reservation:", releaseError.message);
      }
    }
    const conflict = /taken by another customer|no longer available|already been used|reserved for female/i.test(error.message || "");
    return res.status(conflict ? 409 : 500).json({ success: false, message: error.message || "Unable to create payment order." });
  }
});

// Verify gateway signature/captured payment, then create booking and update seats atomically on the server.

// Used by both the Checkout success callback and recovery of a missing
// callback after an in-Checkout retry, network interruption or dismissal.
// Recovery authenticates the booking owner and reads the payment from Razorpay;
// it does not trust a client-provided payment ID or payment status.
async function verifyCapturedPaymentAndBook(req, res, reconciliation = false) {
  let orderId = "";
  let paymentId = "";
  let savedOrder = null;
  let paymentCaptured = false;

  try {
    if (!dependenciesReady()) {
      return res.status(503).json({
        success: false,
        verified: false,
        bookingSaved: false,
        message: "Payment service is not fully configured.",
      });
    }

    const body = req.body || {};
    orderId = cleanString(reconciliation ? body.orderId : body.razorpay_order_id, 100);
    paymentId = cleanString(body.razorpay_payment_id, 100);
    let signature = cleanString(body.razorpay_signature, 200);

    if (reconciliation) {
      if (!orderId) {
        return res.status(400).json({ success: false, message: "Order ID is required." });
      }
      const recoveryOrderSnap = await db.collection("razorpay_orders").doc(orderId).get();
      if (!recoveryOrderSnap.exists) {
        return res.status(404).json({ success: false, message: "Payment order not found." });
      }
      const recoveryOrder = recoveryOrderSnap.data();
      if (recoveryOrder.userId !== req.firebaseUser.uid) {
        return res.status(403).json({ success: false, message: "This payment belongs to another account." });
      }

      // Always check the gateway, including when the user's web callback was
      // lost or the order is already marked paid in Firestore.
      const [gatewayOrder, attempts] = await Promise.all([
        razorpay.orders.fetch(orderId),
        razorpay.orders.fetchPayments(orderId),
      ]);
      const payments = Array.isArray(attempts?.items) ? attempts.items : [];
      const captured = payments.filter((p) =>
        p && p.order_id === orderId && p.status === "captured" &&
        p.amount === recoveryOrder.amount && p.currency === "INR"
      );
      if (captured.length > 1) {
        return res.status(202).json({ success: false, paymentReview: true,
          bookingSaved: false, orderId,
          message: "Multiple captured payments need manual reconciliation. Do not pay again." });
      }
      if (captured.length === 0) {
        // Fail closed if the gateway thinks this order is paid but does not
        // return a matching captured payment, or authorization is pending.
        const hasAuthorized = payments.some((p) => p && p.order_id === orderId && p.status === "authorized");
        if (hasAuthorized || gatewayOrder.status === "paid" || recoveryOrder.status === "paid" || recoveryOrder.paymentCaptured === true) {
          return res.status(202).json({ success: false, paymentReview: true,
            bookingSaved: false, orderId,
            message: "Payment is processing or needs review. Do not pay again; check its status shortly." });
        }
        const mayRetry = recoveryOrder.status === "created" && holdIsActive(recoveryOrder);
        return res.status(200).json({ success: false, status: "unpaid", bookingSaved: false,
          paymentCaptured: false, mayRetry, orderId, amount: recoveryOrder.amount,
          message: mayRetry
            ? "No captured payment found yet. You can retry safely using the same Razorpay order."
            : "No captured payment found and the seat hold has expired. Select seats again after checking payment status." });
      }
      paymentId = cleanString(captured[0].id, 100);
      // An authenticated recovery uses the payment ID obtained directly from
      // Razorpay, so the normal verification path can be safely reused.
      signature = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`).digest("hex");
    }

    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({
        success: false,
        verified: false,
        bookingSaved: false,
        message: "Payment verification data is incomplete.",
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    if (!safeEqualHex(expectedSignature, signature)) {
      return res.status(400).json({
        success: false,
        verified: false,
        bookingSaved: false,
        message: "Payment signature verification failed.",
      });
    }

    const orderRef = db.collection("razorpay_orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({
        success: false,
        verified: false,
        bookingSaved: false,
        message: "Payment order record not found.",
      });
    }

    savedOrder = orderSnap.data();

    if (savedOrder.userId !== req.firebaseUser.uid) {
      return res.status(403).json({
        success: false,
        verified: false,
        bookingSaved: false,
        message: "This payment order belongs to another account.",
      });
    }

    // Idempotent success: same payment must already have a saved booking.
    if (savedOrder.status === "paid" && savedOrder.paymentId === paymentId) {
      const existing = await db.collection("bookings")
        .doc(savedOrder.bookingId).get();

      if (
        existing.exists &&
        existing.data().status === "confirmed" &&
        existing.data().razorpayPaymentId === paymentId
      ) {
        return res.status(200).json({
          success: true,
          verified: true,
          bookingSaved: true,
          alreadyConfirmed: true,
          bookingId: savedOrder.bookingId,
          orderId,
          paymentId,
          message: "Payment and booking are already confirmed.",
        });
      }

      // Paid order without a matching confirmed booking needs reconciliation.
      return res.status(202).json({
        success: false,
        verified: true,
        bookingSaved: false,
        paymentReview: true,
        bookingId: savedOrder.bookingId,
        orderId,
        message: "Payment is recorded, but booking confirmation needs review. Please do not pay again.",
      });
    }

    if (savedOrder.status !== "created") {
      return res.status(409).json({
        success: false,
        verified: false,
        bookingSaved: false,
        message: "Order is invalid or already processed.",
      });
    }

    const [gatewayOrder, payment] = await Promise.all([
      razorpay.orders.fetch(orderId),
      razorpay.payments.fetch(paymentId),
    ]);

    if (
      gatewayOrder.id !== orderId ||
      payment.order_id !== orderId ||
      gatewayOrder.currency !== "INR" ||
      payment.currency !== "INR" ||
      savedOrder.currency !== "INR" ||
      gatewayOrder.amount !== savedOrder.amount ||
      payment.amount !== savedOrder.amount ||
      payment.status !== "captured"
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        bookingSaved: false,
        message: "Captured payment amount, currency, or order does not match.",
      });
    }

    // From this point, payment is confirmed captured by Razorpay.
    paymentCaptured = true;

    const date = parseDate(savedOrder.journeyDate);
    if (!date) {
      throw new Error("Payment captured, but the saved journey date is invalid.");
    }

    if (
      !Array.isArray(savedOrder.selectedSeats) ||
      savedOrder.selectedSeats.length === 0 ||
      !savedOrder.bookingId ||
      !savedOrder.busId ||
      !savedOrder.journeyKey
    ) {
      throw new Error("Payment captured, but saved booking details are incomplete.");
    }

    const bookingRef = db.collection("bookings").doc(savedOrder.bookingId);
    const busRef = db.collection("buses").doc(savedOrder.busId);
    const journeySeatsRef = db.collection("journeys")
      .doc(savedOrder.journeyKey).collection("seats");
    const busSeatsRef = busRef.collection("seats");
    const seatIds = savedOrder.selectedSeats;
    const pairIds = [...new Set(savedOrder.protectedSeatIds || [])];

    const result = await db.runTransaction(async (tx) => {
      const currentOrderSnap = await tx.get(orderRef);

      if (!currentOrderSnap.exists) {
        throw new Error("Payment order record not found.");
      }

      const currentOrder = currentOrderSnap.data();

      // Concurrent duplicate request: only accept if booking really exists.
      if (
        currentOrder.status === "paid" &&
        currentOrder.paymentId === paymentId
      ) {
        const existing = await tx.get(bookingRef);

        if (
          existing.exists &&
          existing.data().status === "confirmed" &&
          existing.data().razorpayPaymentId === paymentId
        ) {
          return { alreadyDone: true };
        }

        throw new Error("Payment is marked paid but booking needs reconciliation.");
      }

      if (
        currentOrder.status !== "created" ||
        currentOrder.userId !== req.firebaseUser.uid
      ) {
        throw new Error("Payment order is no longer available.");
      }

      const existingBooking = await tx.get(bookingRef);
      if (existingBooking.exists) {
        throw new Error("Booking ID already exists; manual reconciliation is required.");
      }

      const busSnap = await tx.get(busRef);
      if (!busSnap.exists) {
        throw new Error("Bus no longer exists.");
      }

      const bus = busSnap.data();
      if (bookingClosed(bus, date, savedOrder.isReturnTrip === true)) {
        throw new Error("Bus departure has passed or booking has closed.");
      }
      const scheduleSnap = await tx.get(db.collection("journeys").doc(savedOrder.journeyKey));
      // Honor orders created while the operator was still in legacy setup mode;
      // otherwise enabling enforcement mid-checkout could strand captured funds.
      const orderRequiresSchedule = savedOrder.scheduleRequiredAtOrder === true;
      if (orderRequiresSchedule && (!scheduleSnap.exists || !isPublishedTrip(scheduleSnap.data()))) {
        throw new Error("Payment captured, but no published trip exists for this date. Manual refund/review required.");
      }

      const selectedBusSnaps = {};
      const selectedJourneySnaps = {};
      const pairJourneySnaps = {};

      for (const id of seatIds) {
        selectedBusSnaps[id] = await tx.get(busSeatsRef.doc(id));
        selectedJourneySnaps[id] = await tx.get(journeySeatsRef.doc(id));
      }

      for (const id of pairIds) {
        pairJourneySnaps[id] = await tx.get(journeySeatsRef.doc(id));
      }

      // A captured payment may arrive after hold expiry. Confirm only when
      // the seat is STILL reserved by this exact order/user and has not been
      // reclaimed. Expiry alone is not a reason to reject a paid customer.
      for (const id of seatIds) {
        const busSeatSnap = selectedBusSnaps[id];
        const journeySnap = selectedJourneySnaps[id];

        if (!busSeatSnap.exists || !journeySnap.exists) {
          throw new Error(`Seat ${id} is missing.`);
        }

        const seat = busSeatSnap.data();
        const journey = journeySnap.data();

        if (
          String(journey.status || "").toLowerCase() !== "pendingpayment" ||
          journey.holdBookingId !== savedOrder.bookingId ||
          journey.holdUserId !== savedOrder.userId ||
          seat.blocked === true ||
          String(seat.status || "").toLowerCase() === "blocked"
        ) {
          throw new Error(`Seat ${id} reservation is expired or changed.`);
        }

        if (
          (journey.femaleOnly === true ||
            String(journey.status || "").toLowerCase() === "femaleonly") &&
          savedOrder.gender !== "female"
        ) {
          throw new Error(`Seat ${id} is reserved for female passengers.`);
        }
      }

      // A protected paired seat must still be held by this booking.
      for (const id of pairIds) {
        if (seatIds.includes(id)) {
          throw new Error(`Invalid paired-seat configuration for seat ${id}.`);
        }

        const snap = pairJourneySnaps[id];
        if (!snap.exists) {
          throw new Error(`Protected paired seat ${id} is missing.`);
        }

        const pair = snap.data();

        if (
          savedOrder.gender !== "female" ||
          String(pair.status || "").toLowerCase() !== "femaleonly" ||
          pair.femaleOnly !== true ||
          pair.protectedByBookingId !== savedOrder.bookingId ||
          pair.holdBookingId !== savedOrder.bookingId ||
          pair.holdUserId !== savedOrder.userId
        ) {
          throw new Error(`Protected paired seat ${id} reservation is expired or changed.`);
        }
      }

      const bookingDate = Timestamp.fromDate(date);

      tx.set(bookingRef, {
        bookingId: savedOrder.bookingId,
        bookingType: "online",
        userId: savedOrder.userId,
        email: savedOrder.email || "",
        busId: savedOrder.busId,
        busName: savedOrder.busName,
        from: savedOrder.from,
        to: savedOrder.to,
        isReturnTrip: savedOrder.isReturnTrip === true,
        passengerName: savedOrder.passengerName,
        mobile: savedOrder.mobile,
        gender: savedOrder.gender,
        selectedSeats: seatIds,
        protectedSeatIds: pairIds,
        total: savedOrder.total,
        paymentMethod: "Razorpay",
        paymentStatus: "paid",
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        status: "confirmed",
        busType: savedOrder.busType,
        departureTime: savedOrder.departureTime,
        arrivalTime: savedOrder.arrivalTime,
        journeyDate: bookingDate,
        journeyDateString: savedOrder.journeyDate,
        createdAt: FieldValue.serverTimestamp(),
      });

      for (const id of seatIds) {
        tx.set(journeySeatsRef.doc(id), {
          seatId: id,
          status: "booked",
          bookingId: savedOrder.bookingId,
          bookingType: "online",
          customerName: savedOrder.passengerName,
          customerMobile: savedOrder.mobile,
          gender: savedOrder.gender,
          femaleBooked: savedOrder.gender === "female",
          paymentMethod: "Razorpay",
          paymentStatus: "paid",
          razorpayPaymentId: paymentId,
          journeyDate: bookingDate,
          createdAt: FieldValue.serverTimestamp(),
          holdBookingId: FieldValue.delete(),
          holdUserId: FieldValue.delete(),
          holdExpiresAt: FieldValue.delete(),
        }, { merge: true });

        tx.set(publicSeatRef(savedOrder.journeyKey, id), {
          seatId: id,
          status: "booked",
          femaleOnly: FieldValue.delete(),
          holdExpiresAt: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      for (const id of pairIds) {
        tx.set(journeySeatsRef.doc(id), {
          status: "femaleOnly",
          femaleOnly: true,
          holdBookingId: FieldValue.delete(),
          holdUserId: FieldValue.delete(),
          holdExpiresAt: FieldValue.delete(),
        }, { merge: true });

        tx.set(publicSeatRef(savedOrder.journeyKey, id), {
          seatId: id,
          status: "femaleOnly",
          femaleOnly: true,
          holdExpiresAt: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      tx.update(orderRef, {
        verified: true,
        status: "paid",
        paymentId,
        verifiedAt: FieldValue.serverTimestamp(),
        bookingSaved: true,
        paymentReview: false,
      });

      return { alreadyDone: false };
    });

    return res.status(200).json({
      success: true,
      verified: true,
      bookingSaved: true,
      alreadyConfirmed: result.alreadyDone === true,
      bookingId: savedOrder.bookingId,
      orderId,
      paymentId,
      message: result.alreadyDone
        ? "Payment and booking are already confirmed."
        : "Payment verified and booking confirmed.",
    });
  } catch (error) {
    console.error("Payment verification/booking failed:", error.message);

    // Payment captured but booking transaction failed: persist a review record.
    if (paymentCaptured && db && orderId && savedOrder) {
      const reviewData = {
        orderId,
        paymentId,
        bookingId: savedOrder.bookingId || "",
        userId: savedOrder.userId || "",
        busId: savedOrder.busId || "",
        journeyKey: savedOrder.journeyKey || "",
        selectedSeats: Array.isArray(savedOrder.selectedSeats)
          ? savedOrder.selectedSeats
          : [],
        total: savedOrder.total ?? null,
        reason: cleanString(error.message, 500),
        status: "needs_review",
        updatedAt: FieldValue.serverTimestamp(),
      };

      try {
        await db.collection("payment_recovery").doc(orderId).set({
          ...reviewData,
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        await db.collection("razorpay_orders").doc(orderId).set({
          paymentCaptured: true,
          paymentId,
          paymentReview: true,
          bookingSaved: false,
          recoveryStatus: "needs_review",
          recoveryReason: cleanString(error.message, 500),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (recoveryError) {
        console.error(
          "CRITICAL: Could not persist payment recovery record:",
          recoveryError.message
        );
      }

      return res.status(202).json({
        success: false,
        verified: true,
        bookingSaved: false,
        paymentReview: true,
        bookingId: savedOrder.bookingId || "",
        orderId,
        paymentId,
        message: "Payment was captured, but booking confirmation needs review. Please do not pay again; contact support.",
      });
    }

    return res.status(409).json({
      success: false,
      verified: false,
      bookingSaved: false,
      message: error.message || "Unable to verify payment.",
    });
  }
}

app.post("/verify-payment", requireFirebaseUser, (req, res) =>
  verifyCapturedPaymentAndBook(req, res, false));
app.post("/reconcile-payment", requireFirebaseUser, (req, res) =>
  verifyCapturedPaymentAndBook(req, res, true));

// One-time admin migration: copy only safe availability fields from legacy journey seats.
app.post("/admin/migrate-seat-status", requireFirebaseUser, async (req, res) => {
  try {
    if (!db || !auth) return res.status(503).json({ success: false, message: "Database service is not configured." });
    const userSnap = await db.collection("users").doc(req.firebaseUser.uid).get();
    if (!userSnap.exists || userSnap.data().role !== "admin") return res.status(403).json({ success: false, message: "Admin access required." });
    const pageSize = 300;
    let cursor = null;
    let migrated = 0;
    while (true) {
      let query = db.collectionGroup("seats").orderBy("__name__").limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      const batch = db.batch();
      let batchCount = 0;
      for (const doc of page.docs) {
        const path = doc.ref.path.split("/");
        if (path.length !== 4 || path[0] !== "journeys" || path[2] !== "seats") continue;
        const data = doc.data();
        const expiredHold = isExpiredTemporaryHold(data);
        let status = String(data.status || "available");
        if (expiredHold) status = "available";
        const publicRef = db.collection("journeys").doc(path[1]).collection("seat_status").doc(path[3]);
        const publicData = { seatId: path[3], status, updatedAt: FieldValue.serverTimestamp() };
        if (expiredHold) {
          // Repair both copies so an expired temporary hold cannot remain stale
          // in the canonical journey-seat record after migration.
          batch.set(doc.ref, {
            status: "available",
            femaleOnly: FieldValue.delete(),
            protectedByBookingId: FieldValue.delete(),
            holdBookingId: FieldValue.delete(),
            holdUserId: FieldValue.delete(),
            holdExpiresAt: FieldValue.delete(),
          }, { merge: true });
          batch.set(publicRef, {
            seatId: path[3], status: "available", femaleOnly: FieldValue.delete(),
            holdExpiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          batchCount++;
          continue;
        }
        if (status.toLowerCase() === "femaleonly" && data.femaleOnly === true) publicData.femaleOnly = true;
        else publicData.femaleOnly = FieldValue.delete();
        if (status.toLowerCase() === "pendingpayment" && holdIsActive(data)) publicData.holdExpiresAt = data.holdExpiresAt;
        else publicData.holdExpiresAt = FieldValue.delete();
        batch.set(publicRef, publicData, { merge: true });
        batchCount++;
      }
      if (batchCount) { await batch.commit(); migrated += batchCount; }
      cursor = page.docs[page.docs.length - 1];
      if (page.size < pageSize) break;
    }
    return res.status(200).json({ success: true, migrated, message: "Public seat availability migration completed." });
  } catch (error) {
    console.error("Seat status migration failed:", error.message);
    return res.status(500).json({ success: false, message: "Seat status migration failed." });
  }
});

// Returns an estimate only. It neither cancels a booking nor starts a refund.
app.post("/cancellation-quote", requireFirebaseUser, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!db || !auth) return res.status(503).json({ success: false, message: "Database unavailable." });
    const bookingId = cleanString(req.body?.bookingId, 80);
    if (!bookingId) return res.status(400).json({ success: false, message: "Booking ID required." });
    const snap = await db.collection("bookings").doc(bookingId).get();
    if (!snap.exists) return res.status(404).json({ success: false, message: "Booking not found." });
    const booking = snap.data();
    const userSnap = await db.collection("users").doc(req.firebaseUser.uid).get();
    const isAdmin = userSnap.exists && userSnap.data()?.role === "admin";
    if (booking.userId !== req.firebaseUser.uid && !isAdmin) {
      return res.status(403).json({ success: false, message: "Cannot access this booking." });
    }
    if (String(booking.status || "").toLowerCase() !== "confirmed") {
      return res.status(409).json({ success: false, message: "Only confirmed bookings can be cancelled." });
    }
    const busId = cleanString(booking.busId, 150);
    const dateRaw = booking.journeyDate;
    const date = dateRaw?.toDate ? dateRaw.toDate() : new Date(dateRaw);
    if (!busId || !Number.isFinite(date.getTime())) {
      return res.status(409).json({ success: false, message: "Journey details are incomplete. Contact support." });
    }
    const busSnap = await db.collection("buses").doc(busId).get();
    const bus = busSnap.exists ? busSnap.data() : {};
    if (!isAdmin && bookingClosed(bus, date, booking.isReturnTrip === true)) {
      return res.status(403).json({ success: false, message: "Cancellation is closed for this journey." });
    }
    const quote = cancellationQuoteFor(booking, bus, date);
    return res.status(200).json({
      success: true, bookingId,
      refundStatus: quote.refundStatus,
      refundAmountPaise: quote.refundAmountPaise,
      refundPercentage: quote.refundPercentage,
      paymentMethod: quote.onlinePaid ? "Razorpay" : String(booking.paymentMethod || "Other"),
      warning: quote.refundStatus === "needs_review"
        ? "Payment/refund fields are incomplete. Cancellation will require manual refund review."
        : quote.refundStatus === "not_eligible"
          ? "No refund is due within 6 hours of departure."
          : "Refund is an estimate. Final eligibility is recalculated when you confirm. Razorpay processing is separate from booking cancellation.",
    });
  } catch (error) {
    console.error("Cancellation quote failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to calculate refund estimate. Contact support before cancellation." });
  }
});

// Authenticated cancellation + automatic partial Razorpay refund.
// A Firestore claim prevents repeat initiation. If the gateway outcome is uncertain,
// status becomes needs_review and is NEVER retried automatically.
app.post("/cancel-booking", requireFirebaseUser, async (req, res) => {
  try {
    if (!db || !auth) return res.status(503).json({ success: false, message: "Database service is not configured." });
    const bookingId = cleanString((req.body || {}).bookingId, 80);
    if (!bookingId) return res.status(400).json({ success: false, message: "Booking ID is required." });
    const bookingRef = db.collection("bookings").doc(bookingId);
    const refundRef = db.collection("refunds").doc(`${bookingId}_cancellation`);

    const outcome = await db.runTransaction(async (tx) => {
      const bookingSnap = await tx.get(bookingRef);
      if (!bookingSnap.exists) throw new Error("Booking not found.");
      const booking = bookingSnap.data();
      const userSnap = await tx.get(db.collection("users").doc(req.firebaseUser.uid));
      const isAdmin = userSnap.exists && userSnap.data().role === "admin";
      if (booking.userId !== req.firebaseUser.uid && !isAdmin) throw new Error("You cannot cancel this booking.");
      const refundSnap = await tx.get(refundRef);
      if (String(booking.status || "").toLowerCase() === "cancelled") {
        return { alreadyCancelled: true, refundStatus: refundSnap.exists ? refundSnap.data().status : "not_created", refundAmountPaise: refundSnap.exists ? refundSnap.data().refundAmountPaise : 0 };
      }
      if (String(booking.status || "").toLowerCase() !== "confirmed") throw new Error("Only confirmed bookings can be cancelled.");
      if (refundSnap.exists) throw new Error("A cancellation/refund request already exists. Please contact support; do not retry.");

      const busId = cleanString(booking.busId, 150);
      const dateValue = booking.journeyDate;
      const date = dateValue?.toDate ? dateValue.toDate() : (dateValue instanceof Date ? dateValue : new Date(dateValue));
      if (!busId || !Number.isFinite(date.getTime())) throw new Error("Booking route or date is missing.");
      const busRef = db.collection("buses").doc(busId);
      const busSnap = await tx.get(busRef);
      const bus = busSnap.exists ? busSnap.data() : {};
      const yyyy = /^\d{4}-\d{2}-\d{2}$/.test(String(booking.journeyDateString || ""))
        ? booking.journeyDateString
        : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
      const journeyKey = journeyKeyFor(busId, yyyy, booking.isReturnTrip === true);
      const seatCollection = db.collection("journeys").doc(journeyKey).collection("seats");
      const selected = Array.isArray(booking.selectedSeats) ? booking.selectedSeats.map((x) => cleanString(x, 40)).filter(Boolean) : [];
      const protectedIds = Array.isArray(booking.protectedSeatIds) ? booking.protectedSeatIds.map((x) => cleanString(x, 40)).filter(Boolean) : [];
      const ids = [...new Set([...selected, ...protectedIds])];
      const refs = ids.map((id) => seatCollection.doc(id));
      const seatSnaps = [];
      for (const ref of refs) seatSnaps.push(await tx.get(ref));

      const quote = cancellationQuoteFor(booking, bus, date);
      const { paymentId, paidAmountPaise, onlinePaid, departure,
        refundStatus, refundAmountPaise, refundPercentage } = quote;

      // Preserve the app's existing rule: customers cannot cancel after departure; admin may override.
      if (!isAdmin && bookingClosed(bus, date, booking.isReturnTrip === true)) throw new Error("Cancellation is closed because the bus has departed or booking is manually closed.");

      tx.update(bookingRef, {
        status: "cancelled", cancelledAt: FieldValue.serverTimestamp(),
        refundStatus, refundAmountPaise, refundPercentage,
      });
      if (onlinePaid) {
        tx.create(refundRef, {
          bookingId, userId: booking.userId, paymentId, paidAmountPaise,
          refundAmountPaise, refundPercentage, currency: "INR",
          status: refundStatus, mode: "automatic_with_manual_review_fallback",
          reason: "booking_cancellation", policyVersion: "cancellation_v1_90_50_0",
          departureAt: departure ? Timestamp.fromDate(departure) : null,
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          note: departure ? (refundAmountPaise > 0 ? "Refund initiation claimed; gateway result pending." : "No refund: cancellation is within 6 hours of departure.") : "Departure time unavailable; manual review required. No gateway request sent.",
        });
      }
      refs.forEach((ref, i) => {
        if (!seatSnaps[i].exists) return;
        const seat = seatSnaps[i].data();
        if (selected.includes(ids[i]) && String(seat.status || "").toLowerCase() === "booked" && seat.bookingId === bookingId) {
          tx.set(ref, { status: "available", bookingId: FieldValue.delete(), bookingType: FieldValue.delete(), customerName: FieldValue.delete(), customerMobile: FieldValue.delete(), gender: FieldValue.delete(), femaleBooked: FieldValue.delete(), paymentMethod: FieldValue.delete(), paymentStatus: FieldValue.delete(), razorpayPaymentId: FieldValue.delete(), journeyDate: FieldValue.delete(), createdAt: FieldValue.delete() }, { merge: true });
          tx.set(publicSeatRef(journeyKey, ids[i]), { seatId: ids[i], status: "available", femaleOnly: FieldValue.delete(), holdExpiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        } else if (protectedIds.includes(ids[i]) && String(seat.status || "").toLowerCase() === "femaleonly" && seat.protectedByBookingId === bookingId) {
          tx.set(ref, { status: "available", femaleOnly: FieldValue.delete(), protectedByBookingId: FieldValue.delete(), bookingType: FieldValue.delete(), busId: FieldValue.delete(), journeyDate: FieldValue.delete(), createdAt: FieldValue.delete() }, { merge: true });
          tx.set(publicSeatRef(journeyKey, ids[i]), { seatId: ids[i], status: "available", femaleOnly: FieldValue.delete(), holdExpiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        }
      });
      return { alreadyCancelled: false, refundStatus, refundAmountPaise, paymentId, refundPercentage };
    });

    if (outcome.alreadyCancelled) {
      return res.status(200).json({ success: true, alreadyCancelled: true, refundStatus: outcome.refundStatus, refundAmountPaise: outcome.refundAmountPaise || 0, message: "Booking was already cancelled. Existing refund status has been preserved; no second refund was sent." });
    }

    if (outcome.refundStatus === "initiating") {
      if (!razorpay) {
        await refundRef.set({ status: "pending_review", note: "Razorpay is not configured; manual review required.", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await bookingRef.set({ refundStatus: "pending_review" }, { merge: true });
        return res.status(200).json({ success: true, refundStatus: "pending_review", refundAmountPaise: outcome.refundAmountPaise, message: "Booking cancelled. Refund requires manual review because the gateway is unavailable." });
      }
      try {
        const gatewayRefund = await razorpay.payments.refund(outcome.paymentId, {
          amount: outcome.refundAmountPaise,
          speed: "normal",
          notes: { bookingId, reason: "booking_cancellation", policyVersion: "cancellation_v1_90_50_0" },
        });
        const gatewayStatus = String(gatewayRefund.status || "").toLowerCase();
        const mappedStatus = gatewayStatus === "processed" ? "successful" : gatewayStatus === "failed" ? "failed" : "processing";
        await refundRef.set({ status: mappedStatus, razorpayRefundId: gatewayRefund.id || null, gatewayStatus: gatewayStatus || "unknown", gatewayResponse: { id: gatewayRefund.id || null, status: gatewayStatus || "unknown", amount: gatewayRefund.amount ?? outcome.refundAmountPaise }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await bookingRef.set({ refundStatus: mappedStatus, razorpayRefundId: gatewayRefund.id || null }, { merge: true });
        return res.status(200).json({ success: true, alreadyCancelled: false, refundStatus: mappedStatus, refundAmountPaise: outcome.refundAmountPaise, refundPercentage: outcome.refundPercentage, razorpayRefundId: gatewayRefund.id || null, message: mappedStatus === "successful" ? "Booking cancelled and refund processed by Razorpay." : "Booking cancelled. Refund request accepted by Razorpay and is being processed." });
      } catch (gatewayError) {
        console.error("Razorpay refund initiation failed or outcome is uncertain:", gatewayError.message);
        await refundRef.set({ status: "needs_review", gatewayError: cleanString(gatewayError.message, 500), updatedAt: FieldValue.serverTimestamp(), note: "Gateway outcome may be uncertain. Automatic retry is disabled to prevent duplicate refunds; reconcile in Razorpay Dashboard." }, { merge: true });
        await bookingRef.set({ refundStatus: "needs_review" }, { merge: true });
        return res.status(200).json({ success: true, refundStatus: "needs_review", refundAmountPaise: outcome.refundAmountPaise, message: "Booking cancelled, but refund initiation needs manual verification in Razorpay Dashboard. Do not retry automatically." });
      }
    }

    const msg = cancellationStatusMessage(outcome.refundStatus);
    return res.status(200).json({ success: true, alreadyCancelled: false, refundStatus: outcome.refundStatus, refundAmountPaise: outcome.refundAmountPaise || 0, refundPercentage: outcome.refundPercentage || 0, message: msg });
  } catch (error) {
    console.error("Cancellation failed:", error.message);
    const message = error.message || "Unable to cancel booking.";
    const status = /cannot cancel/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 409;
    return res.status(status).json({ success: false, message });
  }
});


// Read-only reconciliation: safely refresh status of an existing Razorpay refund.
// NEVER creates/retries a refund, preventing duplicate credits after timeouts.
app.post("/refund-status", requireFirebaseUser, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!db || !auth) return res.status(503).json({ success: false, message: "Database unavailable." });
    const bookingId = cleanString(req.body?.bookingId, 80);
    if (!bookingId) return res.status(400).json({ success: false, message: "Booking ID required." });
    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) return res.status(404).json({ success: false, message: "Booking not found." });
    const booking = bookingSnap.data();
    const userSnap = await db.collection("users").doc(req.firebaseUser.uid).get();
    const isAdmin = userSnap.exists && userSnap.data()?.role === "admin";
    if (booking.userId !== req.firebaseUser.uid && !isAdmin) {
      return res.status(403).json({ success: false, message: "Cannot access this booking." });
    }
    if (String(booking.status || "").toLowerCase() !== "cancelled") {
      return res.status(409).json({ success: false, message: "Booking is not cancelled." });
    }
    const refundRef = db.collection("refunds").doc(`${bookingId}_cancellation`);
    const refundSnap = await refundRef.get();
    const refund = refundSnap.exists ? refundSnap.data() : null;
    let status = String(refund?.status || booking.refundStatus || "not_created");
    const amountPaise = Math.max(0, Number(refund?.refundAmountPaise ?? booking.refundAmountPaise ?? 0) || 0);
    const refundId = cleanString(refund?.razorpayRefundId || booking.razorpayRefundId, 120);
    const paymentMethod = String(booking.paymentMethod || "").toLowerCase();
    const hadRazorpayPayment = String(booking.paymentStatus || "").toLowerCase() === "paid" &&
      (paymentMethod === "razorpay" || Boolean(booking.razorpayOrderId));
    if (!refund && hadRazorpayPayment && ["not_created", "not_applicable"].includes(status)) {
      // Older app versions may have cancelled an online booking without a
      // refund record. Never silently report such a case as no refund due.
      // A human must check the actual cancellation time and gateway refunds.
      status = "needs_review";
      await bookingRef.set({ refundStatus: "needs_review" }, { merge: true });
    }

    if (razorpay && refundId) {
      try {
        const gateway = await razorpay.refunds.fetch(refundId);
        const gatewayPaymentId = cleanString(gateway?.payment_id, 120);
        const recordedPaymentId = cleanString(refund?.paymentId || booking.razorpayPaymentId || booking.paymentId, 120);
        const gatewayAmount = Number(gateway?.amount);
        // Do not accept data from a different payment or an unexpected refund amount.
        // Only mirror gateway details when refund ID, payment and amount match.
        let verifiedGatewayDetails = null;
        if (gateway?.id !== refundId || (recordedPaymentId && gatewayPaymentId !== recordedPaymentId)
            || !Number.isFinite(gatewayAmount) || gatewayAmount !== amountPaise) {
          status = "needs_review";
        } else {
          const gatewayStatus = String(gateway?.status || "").toLowerCase();
          status = gatewayStatus === "processed" ? "successful"
            : gatewayStatus === "failed" ? "failed"
            : ["pending", "created"].includes(gatewayStatus) ? "processing" : "needs_review";
          verifiedGatewayDetails = {
            gatewayStatus: gatewayStatus || "unknown",
            gatewayResponse: {
              id: gateway.id,
              status: gatewayStatus || "unknown",
              amount: gatewayAmount,
            },
          };
        }
        if (refund) {
          await refundRef.set({
            status,
            ...(verifiedGatewayDetails || {}),
            checkedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        await bookingRef.set({ refundStatus: status }, { merge: true });
      } catch (error) {
        console.error("Refund status gateway lookup failed:", error.message);
        // Preserve last known state; do not invent success or initiate another refund.
      }
    }
    return res.status(200).json({ success: true, bookingId, refundStatus: status,
      refundAmountPaise: amountPaise, refundPercentage: refund?.refundPercentage ?? booking.refundPercentage ?? 0,
      message: cancellationStatusMessage(status),
    });
  } catch (error) {
    console.error("Refund status check failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to verify refund status. Contact support." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bus Yatra backend running on port ${PORT}`));
