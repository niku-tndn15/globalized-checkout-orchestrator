/**
 * @file checkoutManager.js
 * @description Globalized Checkout Orchestrator — CheckoutManager (FSM + Idempotency)
 *
 * FSM State Machine:
 *
 *   ┌─────────┐     ┌──────────────────┐     ┌─────────────────┐
 *   │  START  │────▶│ ADDRESS_VALIDATED │────▶│ TAX_CALCULATED  │
 *   └─────────┘     └──────────────────┘     └─────────────────┘
 *                                                      │
 *                                                      ▼
 *                   ┌──────────┐          ┌─────────────────────┐
 *                   │ COMPLETED│◀─────────│   PAYMENT_PENDING   │
 *                   └──────────┘          └─────────────────────┘
 *
 *   Any step failure → FAILED
 *
 * Idempotency:
 *   A Map (mock DB) keyed by requestID. Duplicate calls return the cached result.
 */

'use strict';

const { TaxService, CurrencyService } = require('./checkoutServices');

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — FSM State & Transition Definitions
// ─────────────────────────────────────────────────────────────────────────────

/** Exhaustive enum of all valid checkout states. */
const CHECKOUT_STATE = Object.freeze({
  START             : 'START',
  ADDRESS_VALIDATED : 'ADDRESS_VALIDATED',
  TAX_CALCULATED    : 'TAX_CALCULATED',
  PAYMENT_PENDING   : 'PAYMENT_PENDING',
  COMPLETED         : 'COMPLETED',
  FAILED            : 'FAILED',
});

/**
 * Legal transitions map.
 * Key   = current state
 * Value = the ONE valid next state (linear pipeline)
 *
 * Terminal states (COMPLETED, FAILED) have no outbound transitions.
 */
const FSM_TRANSITIONS = Object.freeze({
  [CHECKOUT_STATE.START]             : CHECKOUT_STATE.ADDRESS_VALIDATED,
  [CHECKOUT_STATE.ADDRESS_VALIDATED] : CHECKOUT_STATE.TAX_CALCULATED,
  [CHECKOUT_STATE.TAX_CALCULATED]    : CHECKOUT_STATE.PAYMENT_PENDING,
  [CHECKOUT_STATE.PAYMENT_PENDING]   : CHECKOUT_STATE.COMPLETED,
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — FSM Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a lightweight, immutable FSM session for a single checkout run.
 * @param {string} initialState
 * @returns {{ getState, transition, isFailed, isTerminal }}
 */
const createFSM = (initialState = CHECKOUT_STATE.START) => {
  let currentState = initialState;

  return {
    getState() { return currentState; },

    /**
     * Moves to the next legal state.
     * @returns {string} The new state
     * @throws {Error} If the transition is illegal
     */
    transition() {
      const next = FSM_TRANSITIONS[currentState];
      if (!next) {
        throw new Error(
          `[FSM] No outbound transition from terminal state: "${currentState}"`
        );
      }
      currentState = next;
      return currentState;
    },

    /** Hard-sets the FSM to FAILED — callable from any non-terminal state. */
    fail() {
      currentState = CHECKOUT_STATE.FAILED;
      return currentState;
    },

    isFailed()   { return currentState === CHECKOUT_STATE.FAILED; },
    isTerminal() {
      return currentState === CHECKOUT_STATE.COMPLETED
          || currentState === CHECKOUT_STATE.FAILED;
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Step Processors (one per FSM transition)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates user address. Returns normalised address or throws.
 * @param {object} userAddress
 * @returns {object} Validated address payload
 */
const validateAddress = (userAddress) => {
  const required = ['name', 'street', 'city', 'countryCode'];
  const missing  = required.filter(k => !userAddress?.[k]?.trim());

  if (missing.length > 0) {
    throw new Error(`[AddressValidation] Missing required fields: ${missing.join(', ')}`);
  }

  return Object.freeze({
    ...userAddress,
    countryCode : userAddress.countryCode.toUpperCase(),
    validatedAt : new Date().toISOString(),
  });
};

/**
 * Calculates tax + multi-currency conversions from cart total.
 * @param {object} cart          - { items: [{ name, priceUSD, qty }], ... }
 * @param {string} countryCode   - e.g. 'IN' | 'US' | 'EU'
 * @param {TaxService} taxSvc
 * @param {CurrencyService} currencySvc
 * @returns {object} Tax + conversion breakdown
 */
const calculateTax = (cart, countryCode, taxSvc, currencySvc) => {
  if (!Array.isArray(cart.items) || cart.items.length === 0) {
    throw new Error('[TaxCalculation] Cart must contain at least one item.');
  }

  const baseAmountUSD = cart.items.reduce((sum, item) => {
    if (typeof item.priceUSD !== 'number' || typeof item.qty !== 'number') {
      throw new TypeError(`[TaxCalculation] Item "${item.name}" has invalid priceUSD or qty.`);
    }
    return sum + item.priceUSD * item.qty;
  }, 0);

  const tax         = taxSvc.calculate(countryCode, parseFloat(baseAmountUSD.toFixed(2)));
  const conversions = currencySvc.convertAll(tax.totalAmount);

  return Object.freeze({ tax, conversions, calculatedAt: new Date().toISOString() });
};

/**
 * Simulates payment authorisation. In production, call your payment gateway here.
 * @param {object} taxBreakdown  - Result from calculateTax
 * @returns {object} Payment intent/authorisation mock
 */
const initiatePayment = (taxBreakdown) => {
  // Mock: always authorises. Swap with Stripe / Razorpay / Adyen etc.
  const authCode = `AUTH-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

  return Object.freeze({
    status      : 'AUTHORISED',
    authCode,
    amountUSD   : taxBreakdown.tax.totalAmount,
    currency    : 'USD',
    authorisedAt: new Date().toISOString(),
  });
};

/**
 * Finalises the order. In production: persist to DB, emit events, send receipt.
 * @param {object} paymentResult
 * @returns {object} Order confirmation
 */
const completeOrder = (paymentResult) => {
  const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  return Object.freeze({
    orderId,
    paymentAuthCode : paymentResult.authCode,
    completedAt     : new Date().toISOString(),
    message         : 'Order confirmed. Thank you for your purchase.',
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Idempotency Store (mock in-memory DB)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In production: replace with Redis / DynamoDB / PostgreSQL.
 * Key   = requestID (string)
 * Value = Frozen checkout result snapshot
 */
const idempotencyStore = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — CheckoutManager
// ─────────────────────────────────────────────────────────────────────────────

class CheckoutManager {
  #taxService;
  #currencyService;

  /**
   * @param {{ taxService?: TaxService, currencyService?: CurrencyService }} deps
   */
  constructor({
    taxService      = new TaxService(),
    currencyService = new CurrencyService(),
  } = {}) {
    this.#taxService      = taxService;
    this.#currencyService = currencyService;
  }

  /**
   * Orchestrates a checkout through the FSM pipeline with idempotency guarantees.
   *
   * Idempotency contract:
   *   – First call with a given requestID: executes full pipeline, persists result.
   *   – Subsequent calls with same requestID: returns persisted result immediately.
   *
   * @param {object} cart         - { items: [{ name: string, priceUSD: number, qty: number }] }
   * @param {object} userAddress  - { name, street, city, countryCode, [zip], [state] }
   * @param {string} requestID    - Unique caller-supplied idempotency key
   * @returns {Readonly<object>}  - Full checkout result snapshot
   */
  processCheckout(cart, userAddress, requestID) {
    // ── Guard: requestID is mandatory ────────────────────────────────────────
    if (!requestID || typeof requestID !== 'string' || !requestID.trim()) {
      throw new TypeError('[CheckoutManager] requestID must be a non-empty string.');
    }

    const key = requestID.trim();

    // ── Idempotency check ────────────────────────────────────────────────────
    if (idempotencyStore.has(key)) {
      console.info(`[CheckoutManager] Idempotent hit — returning cached result for: "${key}"`);
      return idempotencyStore.get(key);
    }

    // ── Initialise FSM ───────────────────────────────────────────────────────
    const fsm     = createFSM(CHECKOUT_STATE.START);
    const history = [{ state: fsm.getState(), timestamp: new Date().toISOString() }];

    let validatedAddress = null;
    let taxBreakdown     = null;
    let paymentResult    = null;
    let orderResult      = null;
    let error            = null;

    /**
     * Attempts a single FSM step. On success advances state; on failure → FAILED.
     * @param {Function} stepFn - The unit of work for this transition
     * @returns {*} The return value of stepFn (or undefined on failure)
     */
    const runStep = (stepFn) => {
      if (fsm.isFailed()) return undefined;
      try {
        const result = stepFn();
        fsm.transition();
        history.push({ state: fsm.getState(), timestamp: new Date().toISOString() });
        return result;
      } catch (err) {
        error = { message: err.message, failedAt: fsm.getState(), timestamp: new Date().toISOString() };
        fsm.fail();
        history.push({ state: fsm.getState(), timestamp: new Date().toISOString() });
        console.error(`[CheckoutManager] Step failed at "${error.failedAt}": ${err.message}`);
        return undefined;
      }
    };

    // ── FSM Pipeline ─────────────────────────────────────────────────────────

    // START → ADDRESS_VALIDATED
    validatedAddress = runStep(() => validateAddress(userAddress));

    // ADDRESS_VALIDATED → TAX_CALCULATED
    taxBreakdown = runStep(() =>
      calculateTax(cart, validatedAddress.countryCode, this.#taxService, this.#currencyService)
    );

    // TAX_CALCULATED → PAYMENT_PENDING
    paymentResult = runStep(() => initiatePayment(taxBreakdown));

    // PAYMENT_PENDING → COMPLETED
    orderResult = runStep(() => completeOrder(paymentResult));

    // ── Build result snapshot ────────────────────────────────────────────────
    const result = Object.freeze({
      requestID,
      finalState : fsm.getState(),
      history,
      ...(validatedAddress && { address     : validatedAddress }),
      ...(taxBreakdown     && { pricing     : taxBreakdown     }),
      ...(paymentResult    && { payment     : paymentResult    }),
      ...(orderResult      && { order       : orderResult      }),
      ...(error            && { error                          }),
    });

    // ── Persist to idempotency store ─────────────────────────────────────────
    idempotencyStore.set(key, result);

    return result;
  }

  /**
   * Utility: inspect the idempotency store (useful for debugging/testing).
   * @returns {Map} The live idempotency store
   */
  getIdempotencyStore() {
    return idempotencyStore;
  }

  /**
   * Utility: clear a specific requestID from the store (e.g. for test teardown).
   * @param {string} requestID
   */
  clearIdempotencyKey(requestID) {
    idempotencyStore.delete(requestID);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Demonstration
// ─────────────────────────────────────────────────────────────────────────────

const demo = () => {
  const manager  = new CheckoutManager();
  const divider  = (label) =>
    console.log(`\n${'─'.repeat(60)}\n  ${label}\n${'─'.repeat(60)}`);

  const sampleCart = {
    items: [
      { name: 'Mechanical Keyboard', priceUSD: 120,  qty: 1 },
      { name: 'USB-C Hub',           priceUSD: 45.5, qty: 2 },
    ],
  };

  // ── 1. Happy Path — India ──────────────────────────────────────────────────
  divider('Happy Path — India (GST)');
  const result1 = manager.processCheckout(
    sampleCart,
    { name: 'Rohan Mehta', street: '12 MG Road', city: 'Bengaluru', countryCode: 'IN', zip: '560001' },
    'REQ-INDIA-001'
  );
  console.log('Final State :', result1.finalState);
  console.log('Order       :', result1.order);
  console.log('Tax         :', result1.pricing.tax);
  console.log('State Trail :', result1.history.map(h => h.state).join(' → '));

  // ── 2. Idempotency — same requestID, second call ───────────────────────────
  divider('Idempotency Check — REQ-INDIA-001 (duplicate call)');
  const result2 = manager.processCheckout(
    sampleCart,
    { name: 'Rohan Mehta', street: '12 MG Road', city: 'Bengaluru', countryCode: 'IN' },
    'REQ-INDIA-001'  // ← same requestID
  );
  console.log('Returned same order ID?', result1.order?.orderId === result2.order?.orderId);
  console.log('Cached result orderId  :', result2.order?.orderId);

  // ── 3. Happy Path — USA ───────────────────────────────────────────────────
  divider('Happy Path — USA (Sales Tax)');
  const result3 = manager.processCheckout(
    { items: [{ name: 'Standing Desk', priceUSD: 699, qty: 1 }] },
    { name: 'Jane Doe', street: '200 Market St', city: 'San Francisco', countryCode: 'US', state: 'CA' },
    'REQ-USA-002'
  );
  console.log('Final State :', result3.finalState);
  console.log('Tax         :', result3.pricing.tax);
  console.log('State Trail :', result3.history.map(h => h.state).join(' → '));

  // ── 4. Failure Path — missing address fields ───────────────────────────────
  divider('Failure Path — Invalid Address (missing city)');
  const result4 = manager.processCheckout(
    sampleCart,
    { name: 'Ghost User', street: '99 Unknown Lane', countryCode: 'EU' }, // city missing
    'REQ-EU-FAIL-003'
  );
  console.log('Final State :', result4.finalState);
  console.log('Error Detail:', result4.error);
  console.log('State Trail :', result4.history.map(h => h.state).join(' → '));

  // ── 5. Failure Path — unsupported country ─────────────────────────────────
  divider('Failure Path — Unsupported Country "ZZ"');
  const result5 = manager.processCheckout(
    sampleCart,
    { name: 'Test User', street: '1 Unknown St', city: 'Nowhere', countryCode: 'ZZ' },
    'REQ-ZZ-FAIL-004'
  );
  console.log('Final State :', result5.finalState);
  console.log('Error Detail:', result5.error);
  console.log('State Trail :', result5.history.map(h => h.state).join(' → '));

  // ── 6. Idempotency store snapshot ─────────────────────────────────────────
  divider('Idempotency Store — All keys');
  const store = manager.getIdempotencyStore();
  store.forEach((v, k) => console.log(`  ${k.padEnd(25)} → ${v.finalState}`));
};

demo();

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  CheckoutManager,
  CHECKOUT_STATE,
  FSM_TRANSITIONS,
  createFSM,
};