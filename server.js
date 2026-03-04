/**
 * @file server.js
 * @description Globalized Checkout Orchestrator — Composition Root & HTTP Server
 *
 * This is the single entry point that wires all four modules together:
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  server.js  (Composition Root)                                  │
 *   │                                                                 │
 *   │  POST /api/checkout                                             │
 *   │    │                                                            │
 *   │    ├─1─▶ CheckoutManager.processCheckout()                      │
 *   │    │       └─▶ Validates address, calculates tax (GST/VAT/etc.) │
 *   │    │           Advances FSM → PAYMENT_PENDING                   │
 *   │    │                                                            │
 *   │    ├─2─▶ PaymentOrchestrator.processPayment()                   │
 *   │    │       └─▶ Routes IN → Razorpay, all others → Stripe        │
 *   │    │           Returns mock transactionId + provider info       │
 *   │    │                                                            │
 *   │    ├─3─▶ Registers checkout in webhookStore (shared Map)        │
 *   │    │       └─▶ Enables POST /webhook/payment-callback to find   │
 *   │    │           and finalise this checkout by checkoutID         │
 *   │    │                                                            │
 *   │    └─4─▶ Returns clean JSON response to client                  │
 *   │                                                                 │
 *   │  POST /webhook/payment-callback  (mounted from webhookRoutes)   │
 *   │    └─▶ Verifies signature → advances FSM → sends email         │
 *   │                                                                 │
 *   │  GET  /health                                                   │
 *   │  GET  /api/checkout/:checkoutID  (lookup by ID)                 │
 *   │  static  /public/*                                              │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Key architectural decision:
 *   CheckoutManager.processCheckout() internally runs the FULL pipeline to
 *   COMPLETED (including a mock payment stub). For this orchestrated flow we
 *   use the checkout result purely for its tax + address data, then drive the
 *   REAL payment routing through PaymentOrchestrator. The checkout record
 *   written into the webhook store is keyed to a fresh checkoutID and left in
 *   PAYMENT_PENDING so the webhook handler can finalise it correctly.
 */

'use strict';

const path    = require('path');
const crypto  = require('crypto');
const express = require('express');

// ── Module imports ─────────────────────────────────────────────────────────
const { CheckoutManager, CHECKOUT_STATE }    = require('./checkoutManager');
const { PaymentOrchestrator }                = require('./paymentOrchestrator');
const { router: webhookRouter, checkoutStore } = require('./webhookRoutes');

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Service Singletons
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single shared instances for the lifetime of the process.
 * In production these would be dependency-injected; here they are module-level
 * singletons which is idiomatic for small Node services.
 */
const checkoutManager    = new CheckoutManager();
const paymentOrchestrator = new PaymentOrchestrator();

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Currency helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a countryCode to the ISO 4217 currency code expected by the payment provider.
 * Extend this map as you add new countries to TaxService.
 *
 * In production: drive this from a locale / currency configuration service.
 */
const COUNTRY_CURRENCY_MAP = Object.freeze({
  IN : 'INR',
  US : 'USD',
  EU : 'EUR',
  GB : 'GBP',
  // ── Expanded markets ─────────────────────────────────────────────────────
  BR : 'BRL',
  JP : 'JPY',
  NG : 'NGN',
  NL : 'EUR',  // Netherlands transacts in EUR (Adyen / iDEAL)
});

/**
 * Resolves the ISO currency code for a given country.
 * Falls back to 'USD' for any unmapped country — Stripe accepts it globally.
 *
 * @param {string} countryCode
 * @returns {string} ISO 4217 currency code
 */
const resolveCurrency = (countryCode) =>
  COUNTRY_CURRENCY_MAP[countryCode?.toUpperCase()] ?? 'USD';

/**
 * Currencies that are zero-decimal (no subunit) — pass amount as-is to provider.
 * Source: ISO 4217 + Stripe zero-decimal currency list.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'UGX', 'GNF', 'PYG', 'RWF']);

/**
 * Converts a localised amount to the provider's required smallest currency unit.
 *
 *   Zero-decimal currencies (JPY, KRW, …) : multiply by 1  (already whole units)
 *   All other currencies (USD, INR, BRL…)  : multiply by 100 (cents / paise / kobo)
 *
 * @param {number} amount       - Amount in the target currency (e.g. 248.98 BRL or 37185 JPY)
 * @param {string} currencyCode - ISO 4217 currency code
 * @returns {number} Integer amount in smallest unit, ready for the payment provider API
 */
const toSmallestUnit = (amount, currencyCode) => {
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(currencyCode?.toUpperCase()) ? 1 : 100;
  return Math.round(amount * multiplier);
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Request Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the POST /api/checkout request body.
 *
 * Expected shape:
 * {
 *   "cart": {
 *     "items": [
 *       { "name": "Mechanical Keyboard", "priceUSD": 120, "qty": 1 }
 *     ]
 *   },
 *   "userAddress": {
 *     "name"       : "Rohan Mehta",
 *     "email"      : "rohan@example.com",
 *     "street"     : "12 MG Road",
 *     "city"       : "Bengaluru",
 *     "countryCode": "IN"
 *   }
 * }
 *
 * @param {object} body
 * @returns {{ valid: boolean, errors: string[] }}
 */
const validateCheckoutRequest = (body) => {
  const errors = [];

  // Cart validation
  if (!body.cart || typeof body.cart !== 'object') {
    errors.push('Missing required field: "cart".');
  } else if (!Array.isArray(body.cart.items) || body.cart.items.length === 0) {
    errors.push('"cart.items" must be a non-empty array.');
  } else {
    body.cart.items.forEach((item, i) => {
      if (!item.name)                                    errors.push(`cart.items[${i}]: "name" is required.`);
      if (typeof item.priceUSD !== 'number' || item.priceUSD <= 0) errors.push(`cart.items[${i}]: "priceUSD" must be a positive number.`);
      if (typeof item.qty      !== 'number' || item.qty      <= 0) errors.push(`cart.items[${i}]: "qty" must be a positive number.`);
    });
  }

  // Address validation
  if (!body.userAddress || typeof body.userAddress !== 'object') {
    errors.push('Missing required field: "userAddress".');
  } else {
    ['name', 'email', 'street', 'city', 'countryCode'].forEach(field => {
      if (!body.userAddress[field]?.trim()) errors.push(`userAddress.${field} is required.`);
    });
  }

  return { valid: errors.length === 0, errors };
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — POST /api/checkout  Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full checkout pipeline handler.
 *
 * Pipeline:
 *   1. Validate request body
 *   2. Generate a unique requestID (idempotency key for CheckoutManager)
 *   3. Run CheckoutManager → validate address, calculate tax, get FSM snapshot
 *   4. Derive amount + currency from tax total
 *   5. Run PaymentOrchestrator → route to correct gateway, get transactionId
 *   6. Register the checkout in the shared webhook store (PAYMENT_PENDING)
 *   7. Return clean JSON to the client
 *
 * @type {import('express').RequestHandler}
 */
const handleCheckout = async (req, res) => {
  // ── Step 1: Validate ──────────────────────────────────────────────────────
  const { valid, errors } = validateCheckoutRequest(req.body);
  if (!valid) {
    return res.status(400).json({ success: false, errors });
  }

  const { cart, userAddress } = req.body;

  // ── Step 2: Generate unique requestID ────────────────────────────────────
  // Format: CHK-<timestamp>-<8 random hex chars>
  // Deterministic prefix makes logs scannable; suffix ensures global uniqueness.
  const requestID  = `CHK-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const checkoutID = requestID; // checkoutID and requestID are the same key in this system

  console.info(`\n[Checkout] ─── New request ────────────────────────────────`);
  console.info(`[Checkout] requestID   : ${requestID}`);
  console.info(`[Checkout] country     : ${userAddress.countryCode.toUpperCase()}`);
  console.info(`[Checkout] items       : ${cart.items.length}`);

  // ── Step 3: Run CheckoutManager pipeline ─────────────────────────────────
  // This validates the address, calculates regional tax (GST / VAT / Sales Tax),
  // converts totals to multi-currency, and advances the FSM.
  //
  // Note: CheckoutManager internally also runs a mock initiatePayment and
  // completeOrder to reach COMPLETED in its own idempotency store. We use its
  // result only for the tax + address data. The webhook store entry we create
  // below is independent and correctly left in PAYMENT_PENDING.
  let checkoutSnapshot;
  try {
    checkoutSnapshot = checkoutManager.processCheckout(cart, userAddress, requestID);
  } catch (err) {
    console.error(`[Checkout] CheckoutManager failed:`, err.message);
    return res.status(422).json({
      success    : false,
      checkoutID,
      stage      : 'CHECKOUT_PROCESSING',
      error      : err.message,
    });
  }

  // Bail out if the FSM ended in FAILED (e.g. unsupported country, bad cart)
  if (checkoutSnapshot.finalState === CHECKOUT_STATE.FAILED) {
    console.error(`[Checkout] FSM reached FAILED:`, checkoutSnapshot.error);
    return res.status(422).json({
      success    : false,
      checkoutID,
      finalState : CHECKOUT_STATE.FAILED,
      stage      : checkoutSnapshot.error?.failedAt ?? 'UNKNOWN',
      error      : checkoutSnapshot.error?.message  ?? 'Checkout pipeline failed.',
    });
  }

  const { pricing, address } = checkoutSnapshot;
  const countryCode          = address.countryCode;

  console.info(`[Checkout] Tax total   : $${pricing.tax.totalAmount} USD (${pricing.tax.taxLabel} @ ${pricing.tax.rate})`);

  // ── Step 4: Resolve localised currency amount + convert to smallest unit ──
  // CRITICAL: we must NOT send the USD total to the provider. Each market must
  // receive an amount in its own currency:
  //   - Find the pre-computed conversion for the target currency in pricing.conversions
  //     (calculated by CurrencyService during CheckoutManager.processCheckout)
  //   - Fall back to the USD total only if no conversion entry exists (e.g. US/USD)
  //   - Then convert to the provider's smallest unit, respecting zero-decimal currencies (JPY)
  const currency = resolveCurrency(countryCode);

  const conversionEntry = pricing.conversions.find(c => c.to.currency === currency);
  const localisedAmount = conversionEntry
    ? conversionEntry.to.amount          // e.g. 248.98 BRL, 37185 JPY, 20415 NGN
    : pricing.tax.totalAmount;           // USD fallback (US, or any unmapped country)

  const amountSmallest = toSmallestUnit(localisedAmount, currency);

  console.info(`[Checkout] Currency    : ${localisedAmount} ${currency} → ${amountSmallest} (smallest unit)`);
  console.info(`[Checkout] Routing     : ${countryCode} → ${currency}`);

  // ── Step 5: Run PaymentOrchestrator ──────────────────────────────────────
  // Resolves correct gateway (Razorpay for IN, Stripe for all others),
  // and returns a normalised PaymentResult with a mock transactionId.
  let paymentResult;
  try {
    paymentResult = await paymentOrchestrator.processPayment(amountSmallest, currency, countryCode);
  } catch (err) {
    console.error(`[Checkout] PaymentOrchestrator failed:`, err.message);
    return res.status(502).json({
      success    : false,
      checkoutID,
      stage      : 'PAYMENT_ROUTING',
      error      : err.message,
    });
  }

  console.info(`[Checkout] Gateway     : ${paymentResult.provider} | txn: ${paymentResult.transactionId}`);

  // ── Step 6: Register in the shared webhook store (PAYMENT_PENDING) ───────
  // This is the critical handshake between /api/checkout and
  // POST /webhook/payment-callback. When the provider fires its callback,
  // webhookRoutes.js looks up the checkoutID here to advance the FSM.
  checkoutStore.set(checkoutID, {
    checkoutID,
    finalState    : CHECKOUT_STATE.PAYMENT_PENDING,
    order         : { orderId: checkoutID },       // Use checkoutID as orderId for traceability
    address       : { ...address, email: userAddress.email },
    pricing       : pricing,
    transactionID : paymentResult.transactionId,
    provider      : paymentResult.provider,
    history       : checkoutSnapshot.history,
    createdAt     : new Date().toISOString(),
    updatedAt     : new Date().toISOString(),
  });

  console.info(`[Checkout] Registered checkoutID "${checkoutID}" in webhook store as PAYMENT_PENDING`);
  console.info(`[Checkout] ──────────────────────────────────────────────────\n`);

  // ── Step 7: Return clean response ────────────────────────────────────────
  return res.status(201).json({
    success    : true,
    checkoutID,

    gateway    : {
      provider      : paymentResult.provider,
      transactionId : paymentResult.transactionId,
      status        : paymentResult.status,
      amount        : paymentResult.amount,
      currency      : paymentResult.currency,
    },

    order      : {
      orderId     : checkoutID,
      finalState  : CHECKOUT_STATE.PAYMENT_PENDING,
      customer    : address.name,
      email       : userAddress.email,
      countryCode,
    },

    pricing    : {
      baseAmount  : pricing.tax.baseAmount,
      taxLabel    : pricing.tax.taxLabel,
      taxRate     : pricing.tax.rate,
      taxAmount   : pricing.tax.taxAmount,
      totalUSD    : pricing.tax.totalAmount,
      conversions : pricing.conversions.map(({ to }) => ({
        currency : to.currency,
        symbol   : to.symbol,
        amount   : to.amount,
      })),
    },

    nextStep   : {
      description : 'Awaiting payment provider confirmation via webhook.',
      webhookUrl  : `POST /webhook/payment-callback`,
      checkoutID,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — GET /api/checkout/:checkoutID  (Lookup route)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the current state of a checkout by its ID.
 * Useful for polling from a client after payment redirect, or for debugging.
 *
 * @type {import('express').RequestHandler}
 */
const handleCheckoutLookup = (req, res) => {
  const { checkoutID } = req.params;

  if (!checkoutID?.trim()) {
    return res.status(400).json({ success: false, error: 'checkoutID is required.' });
  }

  const record = checkoutStore.get(checkoutID.trim());

  if (!record) {
    return res.status(404).json({
      success    : false,
      checkoutID,
      error      : `Checkout "${checkoutID}" not found.`,
    });
  }

  return res.status(200).json({
    success    : true,
    checkoutID : record.checkoutID,
    finalState : record.finalState,
    provider   : record.provider   ?? null,
    orderId    : record.order?.orderId ?? null,
    updatedAt  : record.updatedAt,
    history    : record.history,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Express App Assembly
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

// ── Global middleware ─────────────────────────────────────────────────────────
app.use(express.json());                                    // Parse JSON bodies
app.use(express.urlencoded({ extended: false }));           // Parse URL-encoded bodies
app.use(express.static(path.join(__dirname, 'public')));    // Serve static files from /public

// ── Request logger (lightweight — replace with morgan/pino in production) ────
app.use((req, _res, next) => {
  console.info(`[HTTP] ${req.method} ${req.originalUrl}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check — load balancer / k8s liveness probe target
app.get('/health', (_req, res) => res.json({
  status  : 'ok',
  version : process.env.npm_package_version ?? '1.0.0',
  uptime  : `${process.uptime().toFixed(2)}s`,
}));

// Core checkout pipeline
app.post('/api/checkout',           handleCheckout);
app.get('/api/checkout/:checkoutID', handleCheckoutLookup);

// Webhook router — mounts POST /webhook/payment-callback
app.use('/webhook', webhookRouter);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
// Must be defined with 4 parameters so Express identifies it as an error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(`[UnhandledError] ${req.method} ${req.originalUrl}:`, err.message);
  res.status(500).json({ success: false, error: 'Internal server error. Please try again.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Server Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3005;

app.listen(PORT, () => {
  const divider = '─'.repeat(62);

  console.info(`\n${divider}`);
  console.info(`  🚀  Checkout Orchestrator Server`);
  console.info(divider);
  console.info(`  PORT    : ${PORT}`);
  console.info(`  NODE_ENV: ${process.env.NODE_ENV ?? 'development'}`);
  console.info(`  Static  : ${path.join(__dirname, 'public')}`);
  console.info(divider);
  console.info(`  Routes:`);
  console.info(`    GET  /health`);
  console.info(`    POST /api/checkout`);
  console.info(`    GET  /api/checkout/:checkoutID`);
  console.info(`    POST /webhook/payment-callback`);
  console.info(divider);
  console.info(`\n  Quick test — full pipeline (India, GST → Razorpay):\n`);
  console.info(`  curl -s -X POST http://localhost:${PORT}/api/checkout \\`);
  console.info(`    -H "Content-Type: application/json" \\`);
  console.info(`    -d '{`);
  console.info(`      "cart": { "items": [{ "name": "Laptop Stand", "priceUSD": 49.99, "qty": 2 }] },`);
  console.info(`      "userAddress": {`);
  console.info(`        "name": "Rohan Mehta", "email": "rohan@example.com",`);
  console.info(`        "street": "12 MG Road", "city": "Bengaluru", "countryCode": "IN"`);
  console.info(`      }`);
  console.info(`    }' | jq\n`);
  console.info(`  Then complete the payment via webhook callback:`);
  console.info(`  curl -s -X POST http://localhost:${PORT}/webhook/payment-callback \\`);
  console.info(`    -H "Content-Type: application/json" \\`);
  console.info(`    -d '{"checkoutID":"<id from above>","status":"Success","transactionID":"pi_mock_001","provider":"Razorpay"}' | jq`);
  console.info(`\n${divider}\n`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Exports — for integration testing (supertest, vitest, jest)
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { app };
