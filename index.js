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

app.get("/", (_req, res) => res.json({ success: true, message: "Bus Yatra Payment Backend is running", firebaseConfigured: Boolean(db && auth), razorpayConfigured: Boolean(razorpay) }));
app.get("/razorpay-key", (_req, res) => {
  if (!razorpay || !process.env.RAZORPAY_KEY_ID) return res.status(503).json({ success: false, message: "Razorpay is not configured." });
  return res.json({ success: true, keyId: process.env.RAZORPAY_KEY_ID });
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
    const journeySeatsRef = db.collection("journeys").doc(journeyKey).collection("seats");
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
    });
    reservationCreated = true;

    const order = await razorpay.orders.create({ amount: totalRupees * 100, currency: "INR", receipt: bookingId });
    createdGatewayOrder = order;
    await db.collection("razorpay_orders").doc(order.id).set({
      orderId: order.id, bookingId, userId: req.firebaseUser.uid, amount: order.amount, currency: "INR", status: "created", verified: false,
      busId, busName: cleanString(bus.busName || bus.name || "Bus Yatra Bus", 150), from, to, journeyDate: journeyDateString,
      journeyKey, isReturnTrip, passengerName, mobile, email: cleanString(req.firebaseUser.email || body.email, 200), gender,
      selectedSeats, fareBySeat, protectedSeatIds, total: totalRupees, busType: cleanString(bus.busType, 100),
      departureTime: cleanString(bus.departureTime, 50), arrivalTime: cleanString(bus.arrivalTime, 50), holdExpiresAt,
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

app.post("/verify-payment", requireFirebaseUser, async (req, res) => {
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
    orderId = cleanString(body.razorpay_order_id, 100);
    paymentId = cleanString(body.razorpay_payment_id, 100);
    const signature = cleanString(body.razorpay_signature, 200);

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

      // Validate every selected seat and its unexpired hold.
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
          !holdIsActive(journey) ||
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
          pair.holdUserId !== savedOrder.userId ||
          !holdIsActive(pair)
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
});

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

// Authenticated cancellation: only the booking owner (or an admin) can cancel; seats release atomically.
app.post("/cancel-booking", requireFirebaseUser, async (req, res) => {
  try {
    if (!db || !auth) return res.status(503).json({ success: false, message: "Database service is not configured." });
    const bookingId = cleanString((req.body || {}).bookingId, 80);
    if (!bookingId) return res.status(400).json({ success: false, message: "Booking ID is required." });
    const bookingRef = db.collection("bookings").doc(bookingId);
    const outcome = await db.runTransaction(async (tx) => {
      const bookingSnap = await tx.get(bookingRef);
      if (!bookingSnap.exists) throw new Error("Booking not found.");
      const booking = bookingSnap.data();
      const userSnap = await tx.get(db.collection("users").doc(req.firebaseUser.uid));
      const isAdmin = userSnap.exists && userSnap.data().role === "admin";
      if (booking.userId !== req.firebaseUser.uid && !isAdmin) throw new Error("You cannot cancel this booking.");
      if (String(booking.status || "").toLowerCase() === "cancelled") return { alreadyCancelled: true };
      if (String(booking.status || "").toLowerCase() !== "confirmed") throw new Error("Only confirmed bookings can be cancelled.");
      const busId = cleanString(booking.busId, 150);
      const dateValue = booking.journeyDate;
      const date = dateValue?.toDate ? dateValue.toDate() : (dateValue instanceof Date ? dateValue : new Date(dateValue));
      if (!busId || !Number.isFinite(date.getTime())) throw new Error("Booking route or date is missing.");
      const yyyy = /^\d{4}-\d{2}-\d{2}$/.test(String(booking.journeyDateString || ""))
        ? booking.journeyDateString
        : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
      const journeyKey = journeyKeyFor(busId, yyyy, booking.isReturnTrip === true);
      const journeySeatsRef = db.collection("journeys").doc(journeyKey).collection("seats");
      const selected = Array.isArray(booking.selectedSeats) ? booking.selectedSeats.map((x) => cleanString(x,40)).filter(Boolean) : [];
      const protectedIds = Array.isArray(booking.protectedSeatIds) ? booking.protectedSeatIds.map((x) => cleanString(x,40)).filter(Boolean) : [];
      const ids = [...new Set([...selected, ...protectedIds])];
      const refs = ids.map((id) => journeySeatsRef.doc(id));
      const snaps = [];
      for (const ref of refs) snaps.push(await tx.get(ref));
      tx.update(bookingRef, { status: "cancelled", cancelledAt: FieldValue.serverTimestamp() });
      refs.forEach((ref, i) => {
        if (!snaps[i].exists) return;
        const seat = snaps[i].data();
        if (selected.includes(ids[i]) && String(seat.status || "").toLowerCase() === "booked" && seat.bookingId === bookingId) {
          tx.set(ref, { status: "available", bookingId: FieldValue.delete(), bookingType: FieldValue.delete(), customerName: FieldValue.delete(), customerMobile: FieldValue.delete(), gender: FieldValue.delete(), femaleBooked: FieldValue.delete(), paymentMethod: FieldValue.delete(), paymentStatus: FieldValue.delete(), razorpayPaymentId: FieldValue.delete(), journeyDate: FieldValue.delete(), createdAt: FieldValue.delete() }, { merge: true });
          tx.set(publicSeatRef(journeyKey, ids[i]), { seatId: ids[i], status: "available", femaleOnly: FieldValue.delete(), holdExpiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        } else if (protectedIds.includes(ids[i]) && String(seat.status || "").toLowerCase() === "femaleonly" && seat.protectedByBookingId === bookingId) {
          tx.set(ref, { status: "available", femaleOnly: FieldValue.delete(), protectedByBookingId: FieldValue.delete(), bookingType: FieldValue.delete(), busId: FieldValue.delete(), journeyDate: FieldValue.delete(), createdAt: FieldValue.delete() }, { merge: true });
          tx.set(publicSeatRef(journeyKey, ids[i]), { seatId: ids[i], status: "available", femaleOnly: FieldValue.delete(), holdExpiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        }
      });
      return { alreadyCancelled: false };
    });
    return res.status(200).json({ success: true, alreadyCancelled: outcome.alreadyCancelled === true, message: outcome.alreadyCancelled ? "Booking was already cancelled." : "Booking cancelled and seats released." });
  } catch (error) {
    const message = error.message || "Unable to cancel booking.";
    const status = /cannot cancel/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 409;
    return res.status(status).json({ success: false, message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bus Yatra backend running on port ${PORT}`));
