/**
 * @file webhookRoutes.js
 * @description Globalized Checkout Orchestrator — Payment Provider Webhook Handler
 *
 * Route:   POST /webhook/payment-callback
 *
 * Flow:
 *   1. Verify webhook signature   (provider authenticity guard)
 *   2. Parse & validate payload   (structural guard)
 *   3. Look up checkout by ID     (existence guard)
 *   4. Idempotency check          (already COMPLETED → ack, skip email)
 *   5. Route by payment status
 *        SUCCESS  → transition FSM to COMPLETED → send confirmation email
 *        FAILURE  → transition FSM to FAILED    → send failure notification
 *   6. Persist updated state
 *   7. Acknowledge provider       (always 200 — prevents provider retries on our logic errors)
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  POST /webhook/payment-callback                                 │
 * │        │                                                        │
 * │        ▼                                                        │
 * │  verifyWebhookSignature()  ──fail──▶  401 Unauthorized          │
 * │        │                                                        │
 * │        ▼                                                        │
 * │  validatePayload()  ────────fail──▶  400 Bad Request            │
 * │        │                                                        │
 * │        ▼                                                        │
 * │  lookupCheckout()  ─────────fail──▶  404 Not Found              │
 * │        │                                                        │
 * │        ▼                                                        │
 * │  isAlreadyCompleted()?  ───true──▶  200 (idempotent ack)        │
 * │        │ false                                                  │
 * │        ▼                                                        │
 * │  status === 'Success' ?                                         │
 * │    ├── yes → transitionTo(COMPLETED) → sendConfirmationEmail()  │
 * │    └── no  → transitionTo(FAILED)    → sendFailureEmail()       │
 * │        │                                                        │
 * │        ▼                                                        │
 * │  persistCheckout()  →  200 Acknowledged                        │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Production swap checklist:
 *   - verifyWebhookSignature : plug in provider HMAC / RSA verification
 *   - lookupCheckout         : replace Map read with DB query (Postgres / Dynamo)
 *   - persistCheckout        : replace Map write with DB upsert
 *   - sendConfirmationEmail  : plug in SES / SendGrid / Postmark SDK
 *   - sendFailureEmail       : same email service, different template
 */

'use strict';

const express    = require('express');
const crypto     = require('crypto');
const { CHECKOUT_STATE } = require('./checkoutManager');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Mock Checkout Store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared in-memory checkout store.
 *
 * In production: replace all store.get() / store.set() calls with your ORM / DB client.
 * The interface is intentionally kept Map-like so the swap is a drop-in.
 *
 * Schema per entry:
 * {
 *   checkoutID  : string,
 *   finalState  : CHECKOUT_STATE,
 *   order       : { orderId, ... },
 *   address     : { email, name, countryCode, ... },
 *   pricing     : { tax: { totalAmount }, ... },
 *   history     : [{ state, timestamp }, ...],
 *   updatedAt   : ISO string,
 * }
 */
const checkoutStore = new Map([
  // Seeded entry so the demo route resolves without running the full checkout pipeline
  ['CHK-DEMO-001', {
    checkoutID : 'CHK-DEMO-001',
    finalState : CHECKOUT_STATE.PAYMENT_PENDING,
    order      : { orderId: 'ORD-DEMO-001' },
    address    : { email: 'rohan@example.com', name: 'Rohan Mehta', countryCode: 'IN' },
    pricing    : { tax: { totalAmount: 236 } },
    history    : [
      { state: CHECKOUT_STATE.START,             timestamp: new Date().toISOString() },
      { state: CHECKOUT_STATE.ADDRESS_VALIDATED, timestamp: new Date().toISOString() },
      { state: CHECKOUT_STATE.TAX_CALCULATED,    timestamp: new Date().toISOString() },
      { state: CHECKOUT_STATE.PAYMENT_PENDING,   timestamp: new Date().toISOString() },
    ],
    updatedAt  : new Date().toISOString(),
  }],
  ['CHK-DEMO-002', {
    checkoutID : 'CHK-DEMO-002',
    finalState : CHECKOUT_STATE.COMPLETED,          // ← Already completed (idempotency test seed)
    order      : { orderId: 'ORD-DEMO-002' },
    address    : { email: 'jane@example.com', name: 'Jane Doe', countryCode: 'US' },
    pricing    : { tax: { totalAmount: 762.12 } },
    history    : [],
    updatedAt  : new Date().toISOString(),
  }],
]);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Webhook Signature Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the authenticity of an inbound webhook using HMAC-SHA256.
 *
 * Both Stripe and Razorpay use this pattern:
 *   - Provider signs the raw request body with your webhook secret
 *   - You recompute the HMAC and compare against the provider's header value
 *
 * Current behaviour : Permissive mock (logs, never blocks) — safe for local dev.
 * Production swap   : Set WEBHOOK_SECRET env var, uncomment the signature check.
 *
 * @param {import('express').Request} req
 * @returns {{ valid: boolean, reason?: string }}
 */
const verifyWebhookSignature = (req) => {
  const providerSignature = req.headers['x-webhook-signature'];
  const webhookSecret     = process.env.WEBHOOK_SECRET;

  // ── MOCK BOUNDARY — permissive in dev, strict in production ─────────────
  if (!webhookSecret) {
    console.warn('[Webhook] WEBHOOK_SECRET not set — signature verification skipped (dev mode).');
    return { valid: true };
  }
  // ── END MOCK BOUNDARY ────────────────────────────────────────────────────

  // ── PRODUCTION SIGNATURE CHECK ───────────────────────────────────────────
  if (!providerSignature) {
    return { valid: false, reason: 'Missing x-webhook-signature header.' };
  }

  const rawBody        = JSON.stringify(req.body);           // Requires express.json() upstream
  const computedHmac   = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
  const signaturesMatch = crypto.timingSafeEqual(
    Buffer.from(providerSignature, 'hex'),
    Buffer.from(computedHmac,      'hex'),
  );

  return signaturesMatch
    ? { valid: true }
    : { valid: false, reason: 'Signature mismatch — possible replay or spoofed request.' };
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Payload Validation
// ─────────────────────────────────────────────────────────────────────────────

/** Accepted status values from the payment provider. */
const PROVIDER_STATUS = Object.freeze({
  SUCCESS : 'Success',
  FAILURE : 'Failure',
});

/**
 * Validates the inbound webhook payload structure.
 * @param {object} body
 * @returns {{ valid: boolean, errors: string[] }}
 */
const validatePayload = (body) => {
  const errors   = [];
  const required = ['checkoutID', 'status', 'transactionID', 'provider'];

  required.forEach(field => {
    if (!body[field] || typeof body[field] !== 'string' || !body[field].trim()) {
      errors.push(`Missing or invalid field: "${field}"`);
    }
  });

  if (body.status && !Object.values(PROVIDER_STATUS).includes(body.status)) {
    errors.push(`Invalid status: "${body.status}". Accepted: ${Object.values(PROVIDER_STATUS).join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Email Notification Stubs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends an order confirmation email to the customer.
 *
 * Production swap: replace with SES / SendGrid / Postmark SDK call.
 * The function signature and the data shape it receives will not change.
 *
 * @param {{ name: string, email: string }} address
 * @param {{ orderId: string }}             order
 * @param {{ tax: { totalAmount: number }}} pricing
 * @returns {Promise<void>}
 */
const sendConfirmationEmail = async (address, order, pricing) => {
  // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
  console.info(
    `[EmailService] ✉  Confirmation email sent` +
    ` | To: ${address.email}` +
    ` | Order: ${order.orderId}` +
    ` | Amount: $${pricing.tax.totalAmount}`
  );
  // ── END MOCK BOUNDARY ────────────────────────────────────────────────────

  // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
  // await emailClient.send({
  //   to      : address.email,
  //   from    : process.env.EMAIL_FROM,
  //   subject : `Order Confirmed — ${order.orderId}`,
  //   template: 'ORDER_CONFIRMATION',
  //   data    : { name: address.name, orderId: order.orderId, total: pricing.tax.totalAmount },
  // });
  // ─────────────────────────────────────────────────────────────────────────
};

/**
 * Sends a payment failure notification to the customer.
 *
 * @param {{ name: string, email: string }} address
 * @param {{ orderId: string }}             order
 * @param {string}                          transactionID
 * @returns {Promise<void>}
 */
const sendFailureEmail = async (address, order, transactionID) => {
  // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
  console.warn(
    `[EmailService] ✉  Failure notification sent` +
    ` | To: ${address.email}` +
    ` | Order: ${order.orderId}` +
    ` | TxnID: ${transactionID}`
  );
  // ── END MOCK BOUNDARY ────────────────────────────────────────────────────

  // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
  // await emailClient.send({
  //   to      : address.email,
  //   from    : process.env.EMAIL_FROM,
  //   subject : `Payment Failed — Please Retry`,
  //   template: 'PAYMENT_FAILURE',
  //   data    : { name: address.name, orderId: order.orderId, transactionID },
  // });
  // ─────────────────────────────────────────────────────────────────────────
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — FSM State Updater
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transitions a checkout record to a new FSM state and appends to its history trail.
 * Mutates the checkout object in-place (safe since we own the store).
 *
 * @param {object}          checkout   - Live checkout record from the store
 * @param {CHECKOUT_STATE}  nextState  - Target FSM state
 * @param {object}          [meta]     - Optional extra fields to merge (e.g. transactionID)
 * @returns {object} The mutated checkout record
 */
const applyStateTransition = (checkout, nextState, meta = {}) => {
  checkout.finalState = nextState;
  checkout.updatedAt  = new Date().toISOString();
  checkout.history.push({ state: nextState, timestamp: checkout.updatedAt });
  Object.assign(checkout, meta);
  return checkout;
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Webhook Route Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /webhook/payment-callback
 *
 * Expected payload:
 * {
 *   "checkoutID"   : "CHK-DEMO-001",
 *   "status"       : "Success" | "Failure",
 *   "transactionID": "pi_mock_...",
 *   "provider"     : "Stripe" | "Razorpay",
 *   "amount"       : 23600,          // optional — provider's confirmed amount
 *   "currency"     : "INR"           // optional
 * }
 *
 * Always responds 200 to the provider — any non-200 triggers provider retries.
 * Business logic errors are logged internally and surfaced in the response body.
 */
router.post('/payment-callback', async (req, res) => {

  // ── Step 1: Verify webhook signature ────────────────────────────────────
  const { valid: sigValid, reason: sigReason } = verifyWebhookSignature(req);
  if (!sigValid) {
    console.error(`[Webhook] Signature verification failed: ${sigReason}`);
    return res.status(401).json({ acknowledged: false, error: sigReason });
  }

  // ── Step 2: Validate payload structure ──────────────────────────────────
  const { valid: payloadValid, errors: payloadErrors } = validatePayload(req.body);
  if (!payloadValid) {
    console.error('[Webhook] Invalid payload:', payloadErrors);
    return res.status(400).json({ acknowledged: false, errors: payloadErrors });
  }

  const { checkoutID, status, transactionID, provider, amount, currency } = req.body;

  console.info(`[Webhook] Received | checkoutID: ${checkoutID} | status: ${status} | provider: ${provider}`);

  // ── Step 3: Look up checkout record ─────────────────────────────────────
  const checkout = checkoutStore.get(checkoutID);
  if (!checkout) {
    console.error(`[Webhook] Checkout not found: ${checkoutID}`);
    return res.status(404).json({ acknowledged: false, error: `Checkout "${checkoutID}" not found.` });
  }

  // ── Step 4: Idempotency — skip side-effects if already in a terminal state
  const isTerminal = checkout.finalState === CHECKOUT_STATE.COMPLETED
                  || checkout.finalState === CHECKOUT_STATE.FAILED;

  if (isTerminal) {
    console.info(
      `[Webhook] Idempotent hit — checkout "${checkoutID}" is already "${checkout.finalState}".` +
      ` Email suppressed. Acknowledging without reprocessing.`
    );
    return res.status(200).json({
      acknowledged : true,
      idempotent   : true,
      checkoutID,
      finalState   : checkout.finalState,
      message      : `Checkout already in terminal state "${checkout.finalState}". No action taken.`,
    });
  }

  // ── Step 5: Route by payment status and advance FSM ─────────────────────
  try {
    if (status === PROVIDER_STATUS.SUCCESS) {

      // Transition FSM: PAYMENT_PENDING → COMPLETED
      applyStateTransition(checkout, CHECKOUT_STATE.COMPLETED, { transactionID, provider });

      // Persist updated state
      checkoutStore.set(checkoutID, checkout);

      // Send confirmation email — only reached on first successful callback
      await sendConfirmationEmail(checkout.address, checkout.order, checkout.pricing);

      console.info(`[Webhook] ✓ Checkout "${checkoutID}" transitioned to COMPLETED.`);

      return res.status(200).json({
        acknowledged : true,
        idempotent   : false,
        checkoutID,
        finalState   : CHECKOUT_STATE.COMPLETED,
        orderId      : checkout.order?.orderId,
        message      : 'Payment confirmed. Order completed and confirmation email dispatched.',
      });

    } else {

      // Transition FSM: PAYMENT_PENDING → FAILED
      applyStateTransition(checkout, CHECKOUT_STATE.FAILED, { transactionID, provider });

      // Persist updated state
      checkoutStore.set(checkoutID, checkout);

      // Send failure notification
      await sendFailureEmail(checkout.address, checkout.order, transactionID);

      console.warn(`[Webhook] ✗ Checkout "${checkoutID}" transitioned to FAILED.`);

      return res.status(200).json({       // Still 200 — we received the callback successfully
        acknowledged : true,
        idempotent   : false,
        checkoutID,
        finalState   : CHECKOUT_STATE.FAILED,
        message      : 'Payment failure recorded. Customer notified.',
      });
    }

  } catch (err) {
    // Internal error (e.g. email service down) — log, but still ack the provider
    // so it doesn't retry and cause duplicate state transitions.
    console.error(`[Webhook] Internal error processing "${checkoutID}":`, err.message);

    return res.status(200).json({
      acknowledged  : true,
      internalError : true,
      checkoutID,
      message       : 'Callback acknowledged. Internal processing error logged for investigation.',
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — App Bootstrap (self-contained demo server)
// ─────────────────────────────────────────────────────────────────────────────

const app  = express();
app.use(express.json());
app.use('/webhook', router);

// Health check — confirms the server is alive
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.info(`\n${'─'.repeat(60)}`);
  console.info(`  Payment Webhook Server running on :${PORT}`);
  console.info(`${'─'.repeat(60)}`);
  console.info(`  POST /webhook/payment-callback`);
  console.info(`  GET  /health`);
  console.info(`${'─'.repeat(60)}\n`);
  console.info('  Test payloads:\n');
  console.info('  ✓ Success (triggers email + COMPLETED transition):');
  console.info(`    curl -X POST http://localhost:${PORT}/webhook/payment-callback \\`);
  console.info(`      -H "Content-Type: application/json" \\`);
  console.info(`      -d '{"checkoutID":"CHK-DEMO-001","status":"Success","transactionID":"pi_mock_abc123","provider":"Razorpay"}'\n`);
  console.info('  ✗ Failure:');
  console.info(`    curl -X POST http://localhost:${PORT}/webhook/payment-callback \\`);
  console.info(`      -H "Content-Type: application/json" \\`);
  console.info(`      -d '{"checkoutID":"CHK-DEMO-001","status":"Failure","transactionID":"pi_mock_xyz","provider":"Razorpay"}'\n`);
  console.info('  ⟳ Idempotency (CHK-DEMO-002 is pre-seeded as COMPLETED):');
  console.info(`    curl -X POST http://localhost:${PORT}/webhook/payment-callback \\`);
  console.info(`      -H "Content-Type: application/json" \\`);
  console.info(`      -d '{"checkoutID":"CHK-DEMO-002","status":"Success","transactionID":"pi_mock_dup","provider":"Stripe"}'\n`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Exports — for integration into a parent Express app or test suite
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  router,          // Mount: app.use('/webhook', router)
  checkoutStore,   // Expose store so CheckoutManager can share the same Map in production
};