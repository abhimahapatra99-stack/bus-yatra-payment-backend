const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

require("dotenv").config();

const app = express();

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json());

// ============================================================
// RAZORPAY
// ============================================================

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Bus Yatra Payment Backend is running",
  });
});

// ============================================================
// RAZORPAY PUBLIC KEY
// ============================================================

app.get("/razorpay-key", (req, res) => {
  const keyId = process.env.RAZORPAY_KEY_ID;

  if (!keyId) {
    return res.status(500).json({
      success: false,
      message: "Razorpay Key ID is not configured.",
    });
  }

  res.json({
    success: true,
    keyId: keyId,
  });
});

// ============================================================
// CREATE RAZORPAY ORDER
// ============================================================

app.post("/create-order", async (req, res) => {
  try {
    const { amount, bookingId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount",
      });
    }

    const options = {
      amount: Math.round(Number(amount) * 100),
      currency: "INR",
      receipt: bookingId
        ? bookingId.toString()
        : `BY_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);

    console.log("Razorpay order created:", order.id);

    return res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (error) {
    console.error("Create order error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to create Razorpay order",
      error: error.message,
    });
  }
});

// ============================================================
// VERIFY RAZORPAY PAYMENT
// ============================================================

app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment verification data is incomplete",
      });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;

    if (!secret) {
      return res.status(500).json({
        success: false,
        verified: false,
        message: "Razorpay secret key is not configured.",
      });
    }

    const generatedSignature = crypto
      .createHmac("sha256", secret)
      .update(
        `${razorpay_order_id}|${razorpay_payment_id}`,
      )
      .digest("hex");

    const isValid =
      generatedSignature === razorpay_signature;

    if (!isValid) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment verification failed",
      });
    }

    console.log(
      "Payment verified successfully:",
      razorpay_payment_id,
    );

    return res.status(200).json({
      success: true,
      verified: true,
      message: "Payment verified successfully",
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
    });
  } catch (error) {
    console.error(
      "Payment verification error:",
      error,
    );

    return res.status(500).json({
      success: false,
      verified: false,
      message: "Payment verification failed",
      error: error.message,
    });
  }
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `Bus Yatra backend running on port ${PORT}`,
  );
});