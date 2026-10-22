
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const fs = require("fs");

const {
  initializeApp,
  getApps,
  cert,
} = require("firebase-admin/app");

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));

// ============================================================
// FIREBASE ADMIN
// Render Secret File:
// /etc/secrets/firebase-service-account.json
// ============================================================

const firebaseServiceAccountPath =
  "/etc/secrets/firebase-service-account.json";

let db = null;

try {
  if (!fs.existsSync(firebaseServiceAccountPath)) {
    throw new Error(
      "Firebase service-account secret file not found."
    );
  }

  const serviceAccount = JSON.parse(
    fs.readFileSync(firebaseServiceAccountPath, "utf8")
  );

  if (
    serviceAccount.type !== "service_account" ||
    typeof serviceAccount.project_id !== "string" ||
    typeof serviceAccount.client_email !== "string" ||
    typeof serviceAccount.private_key !== "string" ||
    !serviceAccount.project_id ||
    !serviceAccount.client_email ||
    !serviceAccount.private_key
  ) {
    throw new Error(
      "Firebase service-account required fields are missing."
    );
  }

  const firebaseCredential = cert({
    projectId: serviceAccount.project_id,
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key.replace(/\\n/g, "\n"),
  });

  const firebaseApp =
    getApps().length === 0
      ? initializeApp({
          credential: firebaseCredential,
          projectId: serviceAccount.project_id,
        })
      : getApps()[0];

  db = getFirestore(firebaseApp);

  console.log("Firebase Admin initialized successfully.");
} catch (error) {
  db = null;
  console.error(
    "Firebase initialization failed:",
    error.message
  );
}

// ============================================================
// RAZORPAY
// ============================================================

let razorpay = null;

if (
  process.env.RAZORPAY_KEY_ID &&
  process.env.RAZORPAY_KEY_SECRET
) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

function dependenciesReady() {
  return Boolean(razorpay && db);
}

function safeEqualHex(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    !/^[a-f0-9]{64}$/i.test(a) ||
    !/^[a-f0-9]{64}$/i.test(b)
  ) {
    return false;
  }

  const first = Buffer.from(a, "hex");
  const second = Buffer.from(b, "hex");

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Bus Yatra Payment Backend is running",
    firebaseConfigured: Boolean(db),
    razorpayConfigured: Boolean(razorpay),
  });
});

// ============================================================
// RAZORPAY PUBLIC KEY
// ============================================================

app.get("/razorpay-key", (req, res) => {
  const keyId = process.env.RAZORPAY_KEY_ID;

  if (!keyId || !razorpay) {
    return res.status(503).json({
      success: false,
      message: "Razorpay is not configured.",
    });
  }

  return res.json({
    success: true,
    keyId,
  });
});

// ============================================================
// CREATE RAZORPAY ORDER
// NOTE: Amount still comes from Flutter.
// Server-side fare validation is required before live payments.
// ============================================================

app.post("/create-order", async (req, res) => {
  try {
    if (!dependenciesReady()) {
      return res.status(503).json({
        success: false,
        message: "Payment service is not fully configured.",
      });
    }

    const { amount, bookingId } = req.body;
    const rupees = Number(amount);

    if (
      amount === undefined ||
      amount === null ||
      typeof amount === "boolean" ||
      !Number.isFinite(rupees) ||
      rupees <= 0 ||
      Math.round(rupees * 100) !== rupees * 100
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount.",
      });
    }

    if (
      bookingId !== undefined &&
      (
        typeof bookingId !== "string" ||
        bookingId.length === 0 ||
        bookingId.length > 40
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID.",
      });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(rupees * 100),
      currency: "INR",
      receipt: bookingId || `BY_${Date.now()}`,
    });

    await db.collection("razorpay_orders").doc(order.id).set({
      bookingId: bookingId || null,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      verified: false,
      status: "created",
      createdAt: FieldValue.serverTimestamp(),
    });

    console.log("Razorpay order created:", order.id);

    return res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (error) {
    console.error("Create order failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to create payment order.",
    });
  }
});

// ============================================================
// VERIFY RAZORPAY PAYMENT
// ============================================================

app.post("/verify-payment", async (req, res) => {
  try {
    if (!dependenciesReady()) {
      return res.status(503).json({
        success: false,
        verified: false,
        message: "Payment service is not fully configured.",
      });
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (
      typeof razorpay_order_id !== "string" ||
      typeof razorpay_payment_id !== "string" ||
      typeof razorpay_signature !== "string" ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment verification data is incomplete.",
      });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;

    if (!secret) {
      return res.status(503).json({
        success: false,
        verified: false,
        message: "Razorpay secret is not configured.",
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (!safeEqualHex(expectedSignature, razorpay_signature)) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment signature verification failed.",
      });
    }

    const orderRef = db
      .collection("razorpay_orders")
      .doc(razorpay_order_id);

    const orderSnapshot = await orderRef.get();

    if (!orderSnapshot.exists) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Order record not found.",
      });
    }

    const savedOrder = orderSnapshot.data();

    if (
      savedOrder.orderId !== razorpay_order_id ||
      savedOrder.status !== "created"
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Order is invalid or has already been processed.",
      });
    }

    const [gatewayOrder, payment] = await Promise.all([
      razorpay.orders.fetch(razorpay_order_id),
      razorpay.payments.fetch(razorpay_payment_id),
    ]);

    if (
      gatewayOrder.id !== razorpay_order_id ||
      payment.order_id !== razorpay_order_id
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment does not match the requested order.",
      });
    }

    if (
      gatewayOrder.currency !== "INR" ||
      payment.currency !== "INR" ||
      savedOrder.currency !== "INR" ||
      gatewayOrder.amount !== savedOrder.amount ||
      payment.amount !== savedOrder.amount
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment amount or currency does not match.",
      });
    }

    if (payment.status !== "captured") {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment has not been captured.",
      });
    }

    await orderRef.update({
      verified: true,
      status: "paid",
      paymentId: razorpay_payment_id,
      verifiedAt: FieldValue.serverTimestamp(),
    });

    console.log(
      "Captured payment verified:",
      razorpay_payment_id
    );

    return res.status(200).json({
      success: true,
      verified: true,
      message: "Payment verified successfully.",
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
    });
  } catch (error) {
    console.error(
      "Payment verification failed:",
      error.message
    );

    return res.status(500).json({
      success: false,
      verified: false,
      message:
        "Unable to verify payment. Contact support if money was deducted.",
    });
  }
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Bus Yatra backend running on port ${PORT}`);
});
