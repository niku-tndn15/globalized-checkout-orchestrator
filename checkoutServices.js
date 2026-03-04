/**
 * @file checkoutServices.js
 * @description Globalized Checkout Orchestrator — TaxService & CurrencyService
 * @architecture Strategy Pattern
 *
 *  ┌─────────────────────────────────────────────────────┐
 *  │  TaxService                                         │
 *  │   └── TaxStrategyRegistry → { IN, US, EU, ... }    │
 *  │         └── TaxStrategy { name, rate, label, calc } │
 *  ├─────────────────────────────────────────────────────┤
 *  │  CurrencyService                                    │
 *  │   └── CurrencyStrategyRegistry → { INR, EUR, GBP } │
 *  │         └── CurrencyStrategy { code, rate, symbol } │
 *  └─────────────────────────────────────────────────────┘
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Core Strategy Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an immutable Tax Strategy.
 * @param {{ countryCode: string, name: string, rate: number, taxLabel: string }} config
 * @returns {Readonly<object>}
 */
const createTaxStrategy = ({ countryCode, name, rate, taxLabel }) => {
  if (typeof rate !== 'number' || rate < 0 || rate > 1) {
    throw new RangeError(`[TaxStrategy] Rate must be a decimal 0–1. Got: ${rate}`);
  }

  return Object.freeze({
    countryCode,
    name,
    rate,
    taxLabel,

    /**
     * Computes tax and returns a structured, immutable breakdown.
     * @param {number} baseAmountUSD
     * @returns {Readonly<object>}
     */
    calculate(baseAmountUSD) {
      if (typeof baseAmountUSD !== 'number' || baseAmountUSD < 0) {
        throw new TypeError(
          `[TaxStrategy:${countryCode}] baseAmountUSD must be a non-negative number.`
        );
      }

      const taxAmount   = parseFloat((baseAmountUSD * rate).toFixed(2));
      const totalAmount = parseFloat((baseAmountUSD + taxAmount).toFixed(2));

      return Object.freeze({
        country    : name,
        taxLabel,
        rate       : `${(rate * 100).toFixed(1)}%`,
        baseAmount : baseAmountUSD,
        taxAmount,
        totalAmount,
      });
    },
  });
};

/**
 * Creates an immutable Currency Strategy.
 * @param {{ code: string, symbol: string, rateFromUSD: number }} config
 * @returns {Readonly<object>}
 */
const createCurrencyStrategy = ({ code, symbol, rateFromUSD }) => {
  if (typeof rateFromUSD !== 'number' || rateFromUSD <= 0) {
    throw new RangeError(`[CurrencyStrategy] rateFromUSD must be a positive number. Got: ${rateFromUSD}`);
  }

  return Object.freeze({
    code,
    symbol,
    rateFromUSD,

    /**
     * Converts a USD amount to this strategy's currency.
     * @param {number} amountUSD
     * @returns {Readonly<object>}
     */
    convert(amountUSD) {
      if (typeof amountUSD !== 'number' || amountUSD < 0) {
        throw new TypeError(`[CurrencyStrategy:${code}] amountUSD must be a non-negative number.`);
      }

      const converted = parseFloat((amountUSD * rateFromUSD).toFixed(2));

      return Object.freeze({
        from : { amount: amountUSD, currency: 'USD', symbol: '$' },
        to   : { amount: converted, currency: code, symbol },
        rate : rateFromUSD,
      });
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Strategy Registries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central Tax Strategy Registry.
 * To add a country: add ONE entry here. No service logic changes required.
 */
const TAX_STRATEGIES = Object.freeze({
  IN : createTaxStrategy({ countryCode: 'IN', name: 'India',          rate: 0.18,  taxLabel: 'GST'              }),
  US : createTaxStrategy({ countryCode: 'US', name: 'United States',  rate: 0.088, taxLabel: 'Sales Tax'        }),
  EU : createTaxStrategy({ countryCode: 'EU', name: 'European Union', rate: 0.20,  taxLabel: 'VAT'              }),
  // ── Expanded markets ──────────────────────────────────────────────────────
  BR : createTaxStrategy({ countryCode: 'BR', name: 'Brazil',         rate: 0.17,  taxLabel: 'ICMS'             }),
  JP : createTaxStrategy({ countryCode: 'JP', name: 'Japan',          rate: 0.10,  taxLabel: 'Consumption Tax'  }),
  NG : createTaxStrategy({ countryCode: 'NG', name: 'Nigeria',        rate: 0.075, taxLabel: 'VAT'              }),
  NL : createTaxStrategy({ countryCode: 'NL', name: 'Netherlands',    rate: 0.21,  taxLabel: 'BTW'              }),
  // ── Further extension (zero service changes needed) ───────────────────────
  // GB : createTaxStrategy({ countryCode: 'GB', name: 'United Kingdom', rate: 0.20,  taxLabel: 'VAT' }),
  // AU : createTaxStrategy({ countryCode: 'AU', name: 'Australia',      rate: 0.10,  taxLabel: 'GST' }),
  // SG : createTaxStrategy({ countryCode: 'SG', name: 'Singapore',      rate: 0.09,  taxLabel: 'GST' }),
});

/**
 * Central Currency Strategy Registry.
 * Rates are mock/hardcoded — swap rateFromUSD with a live FX API call in production.
 */
const CURRENCY_STRATEGIES = Object.freeze({
  INR : createCurrencyStrategy({ code: 'INR', symbol: '₹',    rateFromUSD: 83.50   }),
  EUR : createCurrencyStrategy({ code: 'EUR', symbol: '€',    rateFromUSD: 0.92    }),
  GBP : createCurrencyStrategy({ code: 'GBP', symbol: '£',    rateFromUSD: 0.79    }),
  // ── Expanded markets ────────────────────────────────────────────
  // NL uses EUR — routed via EUR above; no separate currency entry needed.
  BRL : createCurrencyStrategy({ code: 'BRL', symbol: 'R$',  rateFromUSD: 4.97    }),
  JPY : createCurrencyStrategy({ code: 'JPY', symbol: '¥',    rateFromUSD: 149.50  }),
  NGN : createCurrencyStrategy({ code: 'NGN', symbol: '₦',   rateFromUSD: 1540.00 }),
  // ── Further extension ────────────────────────────────────────────────
  // CAD : createCurrencyStrategy({ code: 'CAD', symbol: 'C$',  rateFromUSD: 1.36   }),
  // AED : createCurrencyStrategy({ code: 'AED', symbol: 'د.إ', rateFromUSD: 3.67   }),
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — TaxService
// ─────────────────────────────────────────────────────────────────────────────

class TaxService {
  #registry; // Private field: strategy lookup table

  /** @param {object} registry - Map of countryCode → TaxStrategy */
  constructor(registry = TAX_STRATEGIES) {
    this.#registry = registry;
  }

  /**
   * Resolves the correct strategy and computes tax for a given country.
   * @param {string} countryCode - e.g. 'IN' | 'US' | 'EU'
   * @param {number} baseAmountUSD
   * @returns {Readonly<object>} Tax breakdown
   * @throws {Error} If countryCode is unsupported
   */
  calculate(countryCode, baseAmountUSD) {
    const strategy = this.#registry[countryCode?.toUpperCase()];

    if (!strategy) {
      const supported = Object.keys(this.#registry).join(', ');
      throw new Error(
        `[TaxService] Unsupported country: "${countryCode}". Supported codes: ${supported}`
      );
    }

    return strategy.calculate(baseAmountUSD);
  }

  /**
   * Calculates tax for ALL registered countries in one pass.
   * Useful for multi-region pricing pages or quote comparisons.
   * @param {number} baseAmountUSD
   * @returns {Readonly<object>[]}
   */
  calculateAll(baseAmountUSD) {
    return Object.values(this.#registry).map(strategy => strategy.calculate(baseAmountUSD));
  }

  /** @returns {string[]} All registered country codes */
  getSupportedCountries() {
    return Object.keys(this.#registry);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — CurrencyService
// ─────────────────────────────────────────────────────────────────────────────

class CurrencyService {
  #registry; // Private field: strategy lookup table

  /** @param {object} registry - Map of currencyCode → CurrencyStrategy */
  constructor(registry = CURRENCY_STRATEGIES) {
    this.#registry = registry;
  }

  /**
   * Converts a USD amount to the specified target currency.
   * @param {number} amountUSD
   * @param {string} targetCurrency - e.g. 'INR' | 'EUR' | 'GBP'
   * @returns {Readonly<object>} Conversion result
   * @throws {Error} If currency is unsupported
   */
  convert(amountUSD, targetCurrency) {
    const strategy = this.#registry[targetCurrency?.toUpperCase()];

    if (!strategy) {
      const supported = Object.keys(this.#registry).join(', ');
      throw new Error(
        `[CurrencyService] Unsupported currency: "${targetCurrency}". Supported: ${supported}`
      );
    }

    return strategy.convert(amountUSD);
  }

  /**
   * Converts a USD amount to ALL registered currencies in one pass.
   * @param {number} amountUSD
   * @returns {Readonly<object>[]}
   */
  convertAll(amountUSD) {
    return Object.values(this.#registry).map(strategy => strategy.convert(amountUSD));
  }

  /** @returns {string[]} All registered currency codes */
  getSupportedCurrencies() {
    return Object.keys(this.#registry);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — CheckoutOrchestrator
// ─────────────────────────────────────────────────────────────────────────────

class CheckoutOrchestrator {
  #taxService;
  #currencyService;

  /**
   * Accepts injected service instances — enables testing with mock registries.
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
   * Produces a complete checkout quote:
   *   1. Applies the correct regional tax to baseAmountUSD
   *   2. Converts the tax-inclusive total to all (or selected) currencies
   *
   * @param {object}    params
   * @param {number}    params.baseAmountUSD  - Pre-tax price in USD
   * @param {string}    params.countryCode    - ISO country/region code e.g. 'IN'
   * @param {string[]} [params.currencies]    - Target currencies (defaults to all registered)
   * @returns {Readonly<object>} Full checkout quote
   */
  getQuote({ baseAmountUSD, countryCode, currencies }) {
    const tax              = this.#taxService.calculate(countryCode, baseAmountUSD);
    const targetCurrencies = currencies ?? this.#currencyService.getSupportedCurrencies();
    const conversions      = targetCurrencies.map(c =>
      this.#currencyService.convert(tax.totalAmount, c)
    );

    return Object.freeze({
      input       : { baseAmountUSD, countryCode },
      tax,
      conversions,
      generatedAt : new Date().toISOString(),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Demonstration
// ─────────────────────────────────────────────────────────────────────────────

const demo = () => {
  const orchestrator = new CheckoutOrchestrator();
  const divider = (label) =>
    console.log(`\n${'─'.repeat(60)}\n  ${label}\n${'─'.repeat(60)}`);

  // 1. India GST — convert to all currencies
  divider('Quote: India (GST) — $200 USD');
  const indiaQuote = orchestrator.getQuote({ baseAmountUSD: 200, countryCode: 'IN' });
  console.log('Tax Breakdown :', indiaQuote.tax);
  console.log('Conversions   :', indiaQuote.conversions);

  // 2. USA Sales Tax — EUR only
  divider('Quote: USA (Sales Tax) — $500 USD → EUR only');
  const usaQuote = orchestrator.getQuote({
    baseAmountUSD: 500,
    countryCode  : 'US',
    currencies   : ['EUR'],
  });
  console.log('Tax Breakdown :', usaQuote.tax);
  console.log('Conversions   :', usaQuote.conversions);

  // 3. EU VAT — all currencies
  divider('Quote: EU (VAT) — $1,200 USD');
  const euQuote = orchestrator.getQuote({ baseAmountUSD: 1200, countryCode: 'EU' });
  console.log('Tax Breakdown :', euQuote.tax);
  console.log('Conversions   :', euQuote.conversions);

  // 4. Cross-country tax comparison table
  divider('TaxService.calculateAll — $300 USD across all regions');
  const taxService = new TaxService();
  console.table(taxService.calculateAll(300));

  // 5. Full currency conversion snapshot
  divider('CurrencyService.convertAll — $750 USD');
  const currencyService = new CurrencyService();
  console.table(
    currencyService.convertAll(750).map(({ from, to, rate }) => ({
      from : `$${from.amount} ${from.currency}`,
      to   : `${to.symbol}${to.amount} ${to.currency}`,
      rate,
    }))
  );

  // 6. Graceful error for unsupported region
  divider('Error Handling — Unsupported country "ZZ"');
  try {
    orchestrator.getQuote({ baseAmountUSD: 100, countryCode: 'ZZ' });
  } catch (err) {
    console.error('Caught expected error:', err.message);
  }
};

demo();

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Factories — for custom registry injection in tests or runtime config
  createTaxStrategy,
  createCurrencyStrategy,
  // Default registries
  TAX_STRATEGIES,
  CURRENCY_STRATEGIES,
  // Services
  TaxService,
  CurrencyService,
  CheckoutOrchestrator,
};