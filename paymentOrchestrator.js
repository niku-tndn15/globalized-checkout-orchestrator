/**
 * @file paymentOrchestrator.js
 * @description Globalized Checkout Orchestrator — PaymentOrchestrator
 * @architecture Strategy Pattern
 *
 * Routing Logic:
 *   countryCode === 'IN'  →  RazorpayStrategy  (lowest INR transaction fees)
 *   all other countries   →  StripeStrategy     (global coverage)
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  PaymentOrchestrator                                         │
 * │   └── PaymentStrategyResolver                                │
 * │         ├── RazorpayStrategy  (IN)                           │
 * │         └── StripeStrategy    (default)                      │
 * │                                                              │
 * │  Each strategy implements the PaymentStrategy interface:     │
 * │    processPayment(amount, currency)  → PaymentResult         │
 * │    refund(transactionId, amount)     → RefundResult          │
 * │    getProviderName()                 → string                │
 * └──────────────────────────────────────────────────────────────┘
 *
 * Production swap checklist (per strategy):
 *   1. npm install razorpay  /  npm install stripe
 *   2. Replace the mock body in processPayment() with the real SDK call
 *   3. Pass credentials via environment variables (never hardcode)
 *   4. Replace the mock body in refund() with the real SDK call
 *   5. Remove the ── MOCK BOUNDARY ── blocks; everything else stays
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — PaymentStrategy Interface Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base that enforces the PaymentStrategy interface.
 *
 * Every concrete strategy MUST extend this class and implement:
 *   - processPayment(amount, currency)
 *   - refund(transactionId, amount)
 *   - getProviderName()
 *
 * This is the only place in the codebase that describes the contract —
 * downstream consumers (PaymentOrchestrator) program against this shape,
 * not against any concrete strategy.
 */
class PaymentStrategy {
  /**
   * Process a payment for the given amount in the specified currency.
   * @param {number} amount    - The charge amount (in the currency's smallest unit where applicable)
   * @param {string} currency  - ISO 4217 currency code e.g. 'INR', 'USD', 'EUR'
   * @returns {Promise<PaymentResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async processPayment(amount, currency) {
    throw new Error(`[PaymentStrategy] processPayment() must be implemented by ${this.constructor.name}`);
  }

  /**
   * Issue a full or partial refund for a prior transaction.
   * @param {string} transactionId  - Provider-issued transaction / charge ID
   * @param {number} amount         - Amount to refund (must be ≤ original charge)
   * @returns {Promise<RefundResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async refund(transactionId, amount) {
    throw new Error(`[PaymentStrategy] refund() must be implemented by ${this.constructor.name}`);
  }

  /** @returns {string} Human-readable provider name for logging / receipts */
  getProviderName() {
    throw new Error(`[PaymentStrategy] getProviderName() must be implemented by ${this.constructor.name}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Result Shape Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a normalised, immutable PaymentResult.
 * Both strategies produce this exact shape — callers never inspect provider internals.
 *
 * @param {object} params
 * @returns {Readonly<PaymentResult>}
 */
const createPaymentResult = ({
  provider,
  transactionId,
  amount,
  currency,
  status,
  providerResponse = {},
}) =>
  Object.freeze({
    provider,
    transactionId,
    amount,
    currency,
    status,               // 'SUCCESS' | 'FAILED' | 'PENDING'
    providerResponse,     // Raw provider payload — kept for reconciliation / debugging
    processedAt : new Date().toISOString(),
  });

/**
 * Creates a normalised, immutable RefundResult.
 * @param {object} params
 * @returns {Readonly<RefundResult>}
 */
const createRefundResult = ({
  provider,
  refundId,
  originalTransactionId,
  amount,
  currency,
  status,
  providerResponse = {},
}) =>
  Object.freeze({
    provider,
    refundId,
    originalTransactionId,
    amount,
    currency,
    status,               // 'SUCCESS' | 'FAILED' | 'PENDING'
    providerResponse,
    refundedAt : new Date().toISOString(),
  });

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — RazorpayStrategy  (India — INR-optimised)
// ─────────────────────────────────────────────────────────────────────────────

class RazorpayStrategy extends PaymentStrategy {
  #client; // Razorpay SDK instance — injected or lazily initialised

  /**
   * @param {{ client?: object }} options
   *   client — pre-built Razorpay SDK instance (for testing / DI).
   *            If omitted, initialised from environment variables in production.
   */
  constructor({ client = null } = {}) {
    super();
    this.#client = client;

    // ── PRODUCTION INIT (uncomment when going live) ──────────────────────────
    // const Razorpay = require('razorpay');
    // this.#client = new Razorpay({
    //   key_id    : process.env.RAZORPAY_KEY_ID,
    //   key_secret: process.env.RAZORPAY_KEY_SECRET,
    // });
    // ─────────────────────────────────────────────────────────────────────────
  }

  getProviderName() { return 'Razorpay'; }

  /**
   * Routes a payment through Razorpay.
   *
   * Current behaviour  : Mock — logs routing intent, returns a simulated result.
   * Production swap    : Replace the MOCK BOUNDARY block with the Razorpay SDK call.
   *
   * @param {number} amount   - Amount in paise (INR smallest unit). e.g. ₹500 → 50000
   * @param {string} currency - Should be 'INR' for domestic; Razorpay also supports multi-currency
   * @returns {Promise<Readonly<PaymentResult>>}
   */
  async processPayment(amount, currency) {
    this.#validateArgs(amount, currency);

    console.info(
      `[RazorpayStrategy] Routing to Razorpay to minimize transaction fees` +
      ` | Amount: ${amount} ${currency}`
    );

    // ── MOCK BOUNDARY — replace everything below with real SDK call ──────────
    const mockTransactionId  = `rzp_mock_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const mockProviderResponse = {
      id       : mockTransactionId,
      entity   : 'payment',
      amount,
      currency,
      status   : 'captured',
      method   : 'upi',            // Razorpay supports UPI, netbanking, cards, wallets
      captured : true,
    };
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────

    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const order = await this.#client.orders.create({ amount, currency, receipt: `rcpt_${Date.now()}` });
    // const mockProviderResponse = order;          // persist order.id for webhook verification
    // const mockTransactionId    = order.id;
    // ─────────────────────────────────────────────────────────────────────────

    return createPaymentResult({
      provider          : this.getProviderName(),
      transactionId     : mockTransactionId,
      amount,
      currency,
      status            : 'SUCCESS',
      providerResponse  : mockProviderResponse,
    });
  }

  /**
   * Issues a refund via Razorpay.
   *
   * @param {string} transactionId  - Razorpay payment_id (rzp_...)
   * @param {number} amount         - Amount in paise to refund
   * @returns {Promise<Readonly<RefundResult>>}
   */
  async refund(transactionId, amount) {
    if (!transactionId) throw new TypeError('[RazorpayStrategy] transactionId is required for refund.');
    if (typeof amount !== 'number' || amount <= 0) throw new RangeError('[RazorpayStrategy] Refund amount must be a positive number.');

    console.info(`[RazorpayStrategy] Initiating refund | txn: ${transactionId} | amount: ${amount}`);

    // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
    const mockRefundId       = `rfd_mock_${Date.now()}`;
    const mockProviderResponse = { id: mockRefundId, payment_id: transactionId, amount, status: 'processed' };
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────

    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const refund            = await this.#client.payments.refund(transactionId, { amount });
    // const mockRefundId      = refund.id;
    // const mockProviderResponse = refund;
    // ─────────────────────────────────────────────────────────────────────────

    return createRefundResult({
      provider              : this.getProviderName(),
      refundId              : mockRefundId,
      originalTransactionId : transactionId,
      amount,
      currency              : 'INR',
      status                : 'SUCCESS',
      providerResponse      : mockProviderResponse,
    });
  }

  /** @private */
  #validateArgs(amount, currency) {
    if (typeof amount !== 'number' || amount <= 0)
      throw new RangeError(`[RazorpayStrategy] amount must be a positive number. Got: ${amount}`);
    if (!currency || typeof currency !== 'string')
      throw new TypeError(`[RazorpayStrategy] currency must be a non-empty string. Got: ${currency}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — StripeStrategy  (Global default)
// ─────────────────────────────────────────────────────────────────────────────

class StripeStrategy extends PaymentStrategy {
  #client; // Stripe SDK instance — injected or lazily initialised

  /**
   * @param {{ client?: object }} options
   *   client — pre-built Stripe SDK instance (for testing / DI).
   *            If omitted, initialised from environment variables in production.
   */
  constructor({ client = null } = {}) {
    super();
    this.#client = client;

    // ── PRODUCTION INIT (uncomment when going live) ──────────────────────────
    // const Stripe = require('stripe');
    // this.#client = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
    // ─────────────────────────────────────────────────────────────────────────
  }

  getProviderName() { return 'Stripe'; }

  /**
   * Routes a payment through Stripe.
   *
   * Current behaviour  : Mock — logs routing intent, returns a simulated result.
   * Production swap    : Replace the MOCK BOUNDARY block with the Stripe SDK call.
   *
   * @param {number} amount   - Amount in the currency's smallest unit. e.g. $10.00 → 1000
   * @param {string} currency - ISO 4217 lowercase currency code e.g. 'usd', 'eur', 'gbp'
   * @returns {Promise<Readonly<PaymentResult>>}
   */
  async processPayment(amount, currency) {
    this.#validateArgs(amount, currency);

    console.info(
      `[StripeStrategy] Routing to Stripe to minimize transaction fees` +
      ` | Amount: ${amount} ${currency.toUpperCase()}`
    );

    // ── MOCK BOUNDARY — replace everything below with real SDK call ──────────
    const mockTransactionId    = `pi_mock_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const mockProviderResponse = {
      id                   : mockTransactionId,
      object               : 'payment_intent',
      amount,
      currency             : currency.toLowerCase(),
      status               : 'succeeded',
      payment_method_types : ['card'],
      capture_method       : 'automatic',
    };
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────

    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const paymentIntent = await this.#client.paymentIntents.create({
    //   amount,
    //   currency          : currency.toLowerCase(),
    //   payment_method    : paymentMethodId,   // passed in from client
    //   confirm           : true,
    //   return_url        : process.env.STRIPE_RETURN_URL,
    // });
    // const mockTransactionId    = paymentIntent.id;
    // const mockProviderResponse = paymentIntent;
    // ─────────────────────────────────────────────────────────────────────────

    return createPaymentResult({
      provider         : this.getProviderName(),
      transactionId    : mockTransactionId,
      amount,
      currency         : currency.toUpperCase(),
      status           : 'SUCCESS',
      providerResponse : mockProviderResponse,
    });
  }

  /**
   * Issues a refund via Stripe.
   *
   * @param {string} transactionId  - Stripe PaymentIntent ID (pi_...)
   * @param {number} amount         - Amount in smallest currency unit to refund
   * @returns {Promise<Readonly<RefundResult>>}
   */
  async refund(transactionId, amount) {
    if (!transactionId) throw new TypeError('[StripeStrategy] transactionId is required for refund.');
    if (typeof amount !== 'number' || amount <= 0) throw new RangeError('[StripeStrategy] Refund amount must be a positive number.');

    console.info(`[StripeStrategy] Initiating refund | txn: ${transactionId} | amount: ${amount}`);

    // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
    const mockRefundId         = `re_mock_${Date.now()}`;
    const mockProviderResponse = { id: mockRefundId, payment_intent: transactionId, amount, status: 'succeeded' };
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────

    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const refund            = await this.#client.refunds.create({ payment_intent: transactionId, amount });
    // const mockRefundId      = refund.id;
    // const mockProviderResponse = refund;
    // ─────────────────────────────────────────────────────────────────────────

    return createRefundResult({
      provider              : this.getProviderName(),
      refundId              : mockRefundId,
      originalTransactionId : transactionId,
      amount,
      currency              : 'USD',
      status                : 'SUCCESS',
      providerResponse      : mockProviderResponse,
    });
  }

  /** @private */
  #validateArgs(amount, currency) {
    if (typeof amount !== 'number' || amount <= 0)
      throw new RangeError(`[StripeStrategy] amount must be a positive number. Got: ${amount}`);
    if (!currency || typeof currency !== 'string')
      throw new TypeError(`[StripeStrategy] currency must be a non-empty string. Got: ${currency}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — MercadoPagoStrategy  (Brazil — BRL / PIX-optimised)
// ─────────────────────────────────────────────────────────────────────────────

class MercadoPagoStrategy extends PaymentStrategy {
  #client;

  /**
   * @param {{ client?: object }} options
   * Production init:
   *   const { MercadoPagoConfig, Payment } = require('mercadopago');
   *   this.#client = new Payment(new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN }));
   */
  constructor({ client = null } = {}) { super(); this.#client = client; }

  getProviderName() { return 'MercadoPago'; }

  /**
   * Routes a payment through Mercado Pago (PIX / Boleto / Cards).
   * @param {number} amount   - Amount in BRL (Mercado Pago accepts decimals, no subunit conversion)
   * @param {string} currency - 'BRL'
   * @returns {Promise<Readonly<PaymentResult>>}
   */
  async processPayment(amount, currency) {
    this.#validateArgs(amount, currency);
    console.info(`[MercadoPagoStrategy] Routing to MercadoPago to minimize transaction fees | Amount: ${amount} ${currency}`);

    // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
    const mockTransactionId    = `mp_mock_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const mockProviderResponse = { id: mockTransactionId, status: 'approved', payment_method_id: 'pix', currency_id: currency, transaction_amount: amount };
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────

    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const payment = await this.#client.create({ body: { transaction_amount: amount / 100, currency_id: currency, payment_method_id: 'pix', payer: { email: payerEmail } } });
    // const mockTransactionId = String(payment.id);
    // const mockProviderResponse = payment;
    // ─────────────────────────────────────────────────────────────────────────

    return createPaymentResult({ provider: this.getProviderName(), transactionId: mockTransactionId, amount, currency, status: 'SUCCESS', providerResponse: mockProviderResponse });
  }

  async refund(transactionId, amount) {
    if (!transactionId) throw new TypeError('[MercadoPagoStrategy] transactionId is required for refund.');
    if (typeof amount !== 'number' || amount <= 0) throw new RangeError('[MercadoPagoStrategy] Refund amount must be a positive number.');
    console.info(`[MercadoPagoStrategy] Initiating refund | txn: ${transactionId} | amount: ${amount}`);

    // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
    const mockRefundId = `mp_rfd_${Date.now()}`;
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────
    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const refund = await this.#client.refunds.create({ payment_id: transactionId, body: { amount } });
    // const mockRefundId = String(refund.id);
    // ─────────────────────────────────────────────────────────────────────────

    return createRefundResult({ provider: this.getProviderName(), refundId: mockRefundId, originalTransactionId: transactionId, amount, currency: 'BRL', status: 'SUCCESS', providerResponse: { id: mockRefundId, payment_id: transactionId, amount, status: 'approved' } });
  }

  #validateArgs(amount, currency) {
    if (typeof amount !== 'number' || amount <= 0) throw new RangeError(`[MercadoPagoStrategy] amount must be a positive number. Got: ${amount}`);
    if (!currency || typeof currency !== 'string') throw new TypeError(`[MercadoPagoStrategy] currency must be a non-empty string. Got: ${currency}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — KomojuStrategy  (Japan — JPY / Konbini / Cards)
// ─────────────────────────────────────────────────────────────────────────────

class KomojuStrategy extends PaymentStrategy {
  #client;

  /**
   * @param {{ client?: object }} options
   * Production init:
   *   const Komoju = require('komoju-node');
   *   this.#client = new Komoju.Client({ secretKey: process.env.KOMOJU_SECRET_KEY });
   */
  constructor({ client = null } = {}) { super(); this.#client = client; }

  getProviderName() { return 'Komoju'; }

  /**
   * Routes a payment through Komoju (Konbini / bank_transfer / credit_card).
   * @param {number} amount   - Amount in JPY (no subunit — JPY is zero-decimal)
   * @param {string} currency - 'JPY'
   * @returns {Promise<Readonly<PaymentResult>>}
   */
  async processPayment(amount, currency) {
    this.#validateArgs(amount, currency);
    console.info(`[KomojuStrategy] Routing to Komoju to minimize transaction fees | Amount: ${amount} ${currency}`);

    // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
    const mockTransactionId    = `kmj_mock_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const mockProviderResponse = { id: mockTransactionId, status: 'captured', payment_method: 'konbini', currency, amount };
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────

    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const session = await this.#client.sessions.create({ amount, currency, payment_types: ['konbini', 'credit_card'], return_url: process.env.KOMOJU_RETURN_URL });
    // const mockTransactionId = session.id;
    // const mockProviderResponse = session;
    // ─────────────────────────────────────────────────────────────────────────

    return createPaymentResult({ provider: this.getProviderName(), transactionId: mockTransactionId, amount, currency, status: 'SUCCESS', providerResponse: mockProviderResponse });
  }

  async refund(transactionId, amount) {
    if (!transactionId) throw new TypeError('[KomojuStrategy] transactionId is required for refund.');
    if (typeof amount !== 'number' || amount <= 0) throw new RangeError('[KomojuStrategy] Refund amount must be a positive number.');
    console.info(`[KomojuStrategy] Initiating refund | txn: ${transactionId} | amount: ${amount}`);

    // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
    const mockRefundId = `kmj_rfd_${Date.now()}`;
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────
    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const refund = await this.#client.payments.refund(transactionId, { amount });
    // const mockRefundId = refund.id;
    // ─────────────────────────────────────────────────────────────────────────

    return createRefundResult({ provider: this.getProviderName(), refundId: mockRefundId, originalTransactionId: transactionId, amount, currency: 'JPY', status: 'SUCCESS', providerResponse: { id: mockRefundId, payment_id: transactionId, amount, status: 'refunded' } });
  }

  #validateArgs(amount, currency) {
    if (typeof amount !== 'number' || amount <= 0) throw new RangeError(`[KomojuStrategy] amount must be a positive number. Got: ${amount}`);
    if (!currency || typeof currency !== 'string') throw new TypeError(`[KomojuStrategy] currency must be a non-empty string. Got: ${currency}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — PaystackStrategy  (Nigeria — NGN / Cards / Bank Transfer)
// ─────────────────────────────────────────────────────────────────────────────

class PaystackStrategy extends PaymentStrategy {
  #client;

  /**
   * @param {{ client?: object }} options
   * Production init:
   *   const Paystack = require('paystack-node');
   *   this.#client = new Paystack(process.env.PAYSTACK_SECRET_KEY);
   */
  constructor({ client = null } = {}) { super(); this.#client = client; }

  getProviderName() { return 'Paystack'; }

  /**
   * Routes a payment through Paystack (Cards / Bank Transfer / USSD).
   * @param {number} amount   - Amount in kobo (NGN smallest unit). e.g. ₦100 → 10000
   * @param {string} currency - 'NGN'
   * @returns {Promise<Readonly<PaymentResult>>}
   */
  async processPayment(amount, currency) {
    this.#validateArgs(amount, currency);
    console.info(`[PaystackStrategy] Routing to Paystack to minimize transaction fees | Amount: ${amount} ${currency}`);

    // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
    const mockTransactionId    = `pstk_mock_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const mockProviderResponse = { id: mockTransactionId, status: 'success', channel: 'card', currency, amount, gateway_response: 'Approved' };
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────

    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const txn = await this.#client.transaction.initialize({ email: payerEmail, amount, currency });
    // // After redirect & confirmation via webhook:
    // const verification = await this.#client.transaction.verify(txn.data.reference);
    // const mockTransactionId = verification.data.id;
    // const mockProviderResponse = verification.data;
    // ─────────────────────────────────────────────────────────────────────────

    return createPaymentResult({ provider: this.getProviderName(), transactionId: mockTransactionId, amount, currency, status: 'SUCCESS', providerResponse: mockProviderResponse });
  }

  async refund(transactionId, amount) {
    if (!transactionId) throw new TypeError('[PaystackStrategy] transactionId is required for refund.');
    if (typeof amount !== 'number' || amount <= 0) throw new RangeError('[PaystackStrategy] Refund amount must be a positive number.');
    console.info(`[PaystackStrategy] Initiating refund | txn: ${transactionId} | amount: ${amount}`);

    // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
    const mockRefundId = `pstk_rfd_${Date.now()}`;
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────
    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const refund = await this.#client.refund.create({ transaction: transactionId, amount });
    // const mockRefundId = String(refund.data.id);
    // ─────────────────────────────────────────────────────────────────────────

    return createRefundResult({ provider: this.getProviderName(), refundId: mockRefundId, originalTransactionId: transactionId, amount, currency: 'NGN', status: 'SUCCESS', providerResponse: { id: mockRefundId, transaction: transactionId, amount, status: 'processed' } });
  }

  #validateArgs(amount, currency) {
    if (typeof amount !== 'number' || amount <= 0) throw new RangeError(`[PaystackStrategy] amount must be a positive number. Got: ${amount}`);
    if (!currency || typeof currency !== 'string') throw new TypeError(`[PaystackStrategy] currency must be a non-empty string. Got: ${currency}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — AdyenStrategy  (Netherlands + global enterprise / iDEAL)
// ─────────────────────────────────────────────────────────────────────────────

class AdyenStrategy extends PaymentStrategy {
  #client;

  /**
   * @param {{ client?: object }} options
   * Production init:
   *   const { Client, Config, CheckoutAPI } = require('@adyen/api-library');
   *   const config = new Config({ apiKey: process.env.ADYEN_API_KEY, environment: 'TEST' });
   *   this.#client = new CheckoutAPI(new Client({ config }));
   */
  constructor({ client = null } = {}) { super(); this.#client = client; }

  getProviderName() { return 'Adyen'; }

  /**
   * Routes a payment through Adyen (iDEAL / SEPA / Cards / Klarna).
   * @param {number} amount   - Amount in eurocents. e.g. €10.00 → 1000
   * @param {string} currency - 'EUR' (Netherlands always transacts in EUR)
   * @returns {Promise<Readonly<PaymentResult>>}
   */
  async processPayment(amount, currency) {
    this.#validateArgs(amount, currency);
    console.info(`[AdyenStrategy] Routing to Adyen to minimize transaction fees | Amount: ${amount} ${currency}`);

    // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
    const mockTransactionId    = `adyen_mock_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const mockProviderResponse = { pspReference: mockTransactionId, resultCode: 'Authorised', paymentMethod: { type: 'ideal', name: 'iDEAL' }, amount: { value: amount, currency } };
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────

    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const response = await this.#client.PaymentsApi.payments({ amount: { value: amount, currency }, paymentMethod: { type: 'ideal' }, reference: `ORD-${Date.now()}`, returnUrl: process.env.ADYEN_RETURN_URL, merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT });
    // const mockTransactionId = response.pspReference;
    // const mockProviderResponse = response;
    // ─────────────────────────────────────────────────────────────────────────

    return createPaymentResult({ provider: this.getProviderName(), transactionId: mockTransactionId, amount, currency, status: 'SUCCESS', providerResponse: mockProviderResponse });
  }

  async refund(transactionId, amount) {
    if (!transactionId) throw new TypeError('[AdyenStrategy] transactionId is required for refund.');
    if (typeof amount !== 'number' || amount <= 0) throw new RangeError('[AdyenStrategy] Refund amount must be a positive number.');
    console.info(`[AdyenStrategy] Initiating refund | txn: ${transactionId} | amount: ${amount}`);

    // ── MOCK BOUNDARY ────────────────────────────────────────────────────────
    const mockRefundId = `adyen_rfd_${Date.now()}`;
    // ── END MOCK BOUNDARY ────────────────────────────────────────────────────
    // ── PRODUCTION REPLACEMENT ───────────────────────────────────────────────
    // const refund = await this.#client.ModificationsApi.refundCapturedPayment(transactionId, { amount: { value: amount, currency: 'EUR' }, merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT });
    // const mockRefundId = refund.pspReference;
    // ─────────────────────────────────────────────────────────────────────────

    return createRefundResult({ provider: this.getProviderName(), refundId: mockRefundId, originalTransactionId: transactionId, amount, currency: 'EUR', status: 'SUCCESS', providerResponse: { pspReference: mockRefundId, originalReference: transactionId, status: '[refund-received]' } });
  }

  #validateArgs(amount, currency) {
    if (typeof amount !== 'number' || amount <= 0) throw new RangeError(`[AdyenStrategy] amount must be a positive number. Got: ${amount}`);
    if (!currency || typeof currency !== 'string') throw new TypeError(`[AdyenStrategy] currency must be a non-empty string. Got: ${currency}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — PaymentStrategyResolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registry that maps country codes → PaymentStrategy instances.
 *
 * Design:
 *   - `_default` key is the fallback for any unregistered country code.
 *   - To add a new provider (e.g. PayU for Brazil):
 *       resolver.register('BR', new PayUStrategy())
 *   - No changes to PaymentOrchestrator are ever needed.
 *
 * Separation of concerns:
 *   The Orchestrator delegates ALL routing decisions here.
 *   The Resolver knows nothing about checkout flow, taxes, or idempotency.
 */
class PaymentStrategyResolver {
  #registry;

  /**
   * @param {object} strategyMap - { [countryCode]: PaymentStrategy, _default: PaymentStrategy }
   */
  constructor(strategyMap) {
    const hasDefault = strategyMap._default instanceof PaymentStrategy;
    if (!hasDefault) {
      throw new TypeError('[PaymentStrategyResolver] strategyMap must include a "_default" PaymentStrategy.');
    }
    // Validate all entries
    for (const [code, strategy] of Object.entries(strategyMap)) {
      if (!(strategy instanceof PaymentStrategy)) {
        throw new TypeError(`[PaymentStrategyResolver] Strategy for "${code}" must extend PaymentStrategy.`);
      }
    }
    this.#registry = { ...strategyMap };
  }

  /**
   * Resolves the optimal payment strategy for a given country code.
   * @param {string} countryCode - ISO 3166-1 alpha-2 e.g. 'IN', 'US', 'DE'
   * @returns {PaymentStrategy}
   */
  resolve(countryCode) {
    const key      = countryCode?.toUpperCase()?.trim();
    const strategy = this.#registry[key] ?? this.#registry._default;

    console.info(
      `[PaymentStrategyResolver] "${key}" → ${strategy.getProviderName()}` +
      `${this.#registry[key] ? ' (exact match)' : ' (default fallback)'}`
    );

    return strategy;
  }

  /**
   * Dynamically register a new country → strategy mapping at runtime.
   * Enables feature-flag driven rollouts (e.g. enable Adyen for DE without a redeploy).
   * @param {string}          countryCode
   * @param {PaymentStrategy} strategy
   */
  register(countryCode, strategy) {
    if (!(strategy instanceof PaymentStrategy)) {
      throw new TypeError(`[PaymentStrategyResolver] Provided strategy for "${countryCode}" must extend PaymentStrategy.`);
    }
    this.#registry[countryCode.toUpperCase()] = strategy;
    console.info(`[PaymentStrategyResolver] Registered new strategy: "${countryCode.toUpperCase()}" → ${strategy.getProviderName()}`);
  }

  /** @returns {string[]} All explicitly registered country codes (excludes _default) */
  getRegisteredCountries() {
    return Object.keys(this.#registry).filter(k => k !== '_default');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — Default Resolver Instance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-wired resolver with the full global routing table.
 * Import this directly, or override in tests by constructing a custom resolver.
 *
 * Routing logic (fee-optimised per market):
 *   IN → Razorpay    (UPI / netbanking, lowest INR fees)
 *   BR → MercadoPago (PIX / Boleto, dominant BR market share)
 *   JP → Komoju      (Konbini / convenience store, ~50% JP e-commerce)
 *   NG → Paystack    (Cards / USSD, built for African markets)
 *   NL → Adyen       (iDEAL, used by 70%+ Dutch online shoppers)
 *   *  → Stripe      (global fallback, 135+ currencies)
 *
 * Extend without touching PaymentOrchestrator:
 *   defaultResolver.register('MX', new ConektaStrategy());
 *   defaultResolver.register('AU', new StripeStrategy());
 */
const defaultResolver = new PaymentStrategyResolver({
  IN       : new RazorpayStrategy(),    // India      → Razorpay
  BR       : new MercadoPagoStrategy(), // Brazil     → Mercado Pago / PIX
  JP       : new KomojuStrategy(),      // Japan      → Komoju / Konbini
  NG       : new PaystackStrategy(),    // Nigeria    → Paystack
  NL       : new AdyenStrategy(),       // Netherlands→ Adyen / iDEAL
  _default : new StripeStrategy(),      // Rest of world → Stripe
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — PaymentOrchestrator
// ─────────────────────────────────────────────────────────────────────────────

class PaymentOrchestrator {
  #resolver;

  /**
   * @param {{ resolver?: PaymentStrategyResolver }} options
   *   resolver — custom resolver (e.g. test double with mock strategies).
   *              Defaults to the production routing table.
   */
  constructor({ resolver = defaultResolver } = {}) {
    if (!(resolver instanceof PaymentStrategyResolver)) {
      throw new TypeError('[PaymentOrchestrator] resolver must be an instance of PaymentStrategyResolver.');
    }
    this.#resolver = resolver;
  }

  /**
   * Primary entry point. Resolves the correct provider and processes the payment.
   *
   * @param {number} amount       - Charge amount in the currency's smallest unit
   * @param {string} currency     - ISO 4217 currency code
   * @param {string} countryCode  - ISO 3166-1 alpha-2 country code of the payer
   * @returns {Promise<Readonly<PaymentResult>>}
   */
  async processPayment(amount, currency, countryCode) {
    if (!countryCode || typeof countryCode !== 'string') {
      throw new TypeError('[PaymentOrchestrator] countryCode is required.');
    }

    const strategy = this.#resolver.resolve(countryCode);
    return strategy.processPayment(amount, currency);
  }

  /**
   * Issues a refund through the same provider that handled the original charge.
   * The caller is responsible for knowing which country / provider the original
   * payment used (store this on the order record in production).
   *
   * @param {string} transactionId  - Provider-issued transaction ID
   * @param {number} amount         - Refund amount in smallest currency unit
   * @param {string} countryCode    - Must match the country used at purchase time
   * @returns {Promise<Readonly<RefundResult>>}
   */
  async refund(transactionId, amount, countryCode) {
    if (!countryCode || typeof countryCode !== 'string') {
      throw new TypeError('[PaymentOrchestrator] countryCode is required for refunds.');
    }

    const strategy = this.#resolver.resolve(countryCode);
    return strategy.refund(transactionId, amount);
  }

  /**
   * Exposes the resolver for runtime strategy registration.
   * Use this to roll out a new provider without restarting the server:
   *   orchestrator.getResolver().register('MX', new ConektaStrategy());
   * @returns {PaymentStrategyResolver}
   */
  getResolver() { return this.#resolver; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12 — Demonstration
// ─────────────────────────────────────────────────────────────────────────────

const demo = async () => {
  const orchestrator = new PaymentOrchestrator();
  const divider      = (label) =>
    console.log(`\n${'─'.repeat(60)}\n  ${label}\n${'─'.repeat(60)}`);

  // ── 1. India → Razorpay ───────────────────────────────────────────────────
  divider('Payment: India (IN) — ₹21,240 INR');
  const indiaResult = await orchestrator.processPayment(2124000, 'INR', 'IN'); // amount in paise
  console.log('Provider     :', indiaResult.provider);
  console.log('Transaction  :', indiaResult.transactionId);
  console.log('Status       :', indiaResult.status);

  // ── 2. USA → Stripe (default) ─────────────────────────────────────────────
  divider('Payment: United States (US) — $254.40 USD');
  const usaResult = await orchestrator.processPayment(25440, 'USD', 'US'); // amount in cents
  console.log('Provider     :', usaResult.provider);
  console.log('Transaction  :', usaResult.transactionId);
  console.log('Status       :', usaResult.status);

  // ── 3. EU → Stripe (default fallback) ────────────────────────────────────
  divider('Payment: Germany (DE) — €288.00 EUR');
  const euResult = await orchestrator.processPayment(28800, 'EUR', 'DE');
  console.log('Provider     :', euResult.provider);
  console.log('Transaction  :', euResult.transactionId);
  console.log('Status       :', euResult.status);

  // ── 4. Refund via Razorpay ────────────────────────────────────────────────
  divider('Refund: India (IN) — partial refund ₹500');
  const refundResult = await orchestrator.refund(indiaResult.transactionId, 50000, 'IN');
  console.log('Refund ID    :', refundResult.refundId);
  console.log('Original Txn :', refundResult.originalTransactionId);
  console.log('Status       :', refundResult.status);

  // ── 5. Runtime strategy registration (e.g. PayU for Brazil) ───────────────
  divider('Runtime Registration — Brazil (BR) → Stripe (placeholder)');
  // In a real scenario: orchestrator.getResolver().register('BR', new PayUStrategy());
  orchestrator.getResolver().register('BR', new StripeStrategy());
  const brazilResult = await orchestrator.processPayment(15000, 'BRL', 'BR');
  console.log('Provider     :', brazilResult.provider);

  // ── 6. Registered countries overview ─────────────────────────────────────
  divider('Registered Country → Provider Mappings');
  console.log(orchestrator.getResolver().getRegisteredCountries());

  // ── 7. Error handling ─────────────────────────────────────────────────────
  divider('Error Handling — invalid amount');
  try {
    await orchestrator.processPayment(-500, 'USD', 'US');
  } catch (err) {
    console.error('Caught expected error:', err.message);
  }
};

demo();

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Abstract base — extend to create new providers
  PaymentStrategy,
  // Concrete strategies
  RazorpayStrategy,
  StripeStrategy,
  MercadoPagoStrategy,
  KomojuStrategy,
  PaystackStrategy,
  AdyenStrategy,
  // Routing
  PaymentStrategyResolver,
  defaultResolver,
  // Orchestrator
  PaymentOrchestrator,
  // Result factories — use in custom strategies to stay normalised
  createPaymentResult,
  createRefundResult,
};
