const { env } = require('../config/env');

const DEFAULT_ALLOWED_CURRENCIES = [
  'INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD',
  'NZD', 'MYR', 'THB', 'JPY', 'HKD', 'SAR', 'QAR', 'OMR',
  'KWD', 'BHD', 'ZAR', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN',
  'KRW', 'IDR', 'PHP', 'CNY', 'MXN', 'BRL'
];

const CURRENCY_MINOR_UNITS = {
  BHD: 3,
  IDR: 0,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  OMR: 3
};

const COUNTRY_TO_CURRENCY = {
  IN: 'INR',
  US: 'USD',
  CA: 'CAD',
  GB: 'GBP',
  AU: 'AUD',
  NZ: 'NZD',
  SG: 'SGD',
  AE: 'AED',
  SA: 'SAR',
  QA: 'QAR',
  OM: 'OMR',
  KW: 'KWD',
  BH: 'BHD',
  MY: 'MYR',
  TH: 'THB',
  JP: 'JPY',
  HK: 'HKD',
  ZA: 'ZAR',
  CH: 'CHF',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  PL: 'PLN',
  KR: 'KRW',
  ID: 'IDR',
  PH: 'PHP',
  CN: 'CNY',
  MX: 'MXN',
  BR: 'BRL'
};

const DEFAULT_EXCHANGE_RATES_FROM_INR = {
  INR: 1,
  USD: 0.014,
  EUR: 0.013,
  GBP: 0.011,
  AED: 0.052,
  SGD: 0.019,
  AUD: 0.021,
  CAD: 0.019,
  NZD: 0.023,
  MYR: 0.066,
  THB: 0.5,
  JPY: 2.15,
  HKD: 0.11,
  SAR: 0.052,
  QAR: 0.051,
  OMR: 0.0054,
  KWD: 0.0042,
  BHD: 0.0052,
  ZAR: 0.25,
  CHF: 0.012,
  SEK: 0.14,
  NOK: 0.15,
  DKK: 0.095,
  PLN: 0.052,
  KRW: 16.3,
  IDR: 195,
  PHP: 0.68,
  CNY: 0.086,
  MXN: 0.26,
  BRL: 0.071
};

function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : '';
}

function minorUnit(currency) {
  return CURRENCY_MINOR_UNITS[normalizeCurrency(currency)] ?? 2;
}

function allowedCurrencies() {
  const configured = (env.razorpayAllowedCurrencies || []).map(normalizeCurrency).filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_CURRENCIES;
}

function parseExchangeRates() {
  if (!env.razorpayExchangeRatesJson) return DEFAULT_EXCHANGE_RATES_FROM_INR;
  try {
    const parsed = JSON.parse(env.razorpayExchangeRatesJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_EXCHANGE_RATES_FROM_INR;
    return { ...DEFAULT_EXCHANGE_RATES_FROM_INR, ...parsed };
  } catch {
    return DEFAULT_EXCHANGE_RATES_FROM_INR;
  }
}

function detectCountry(req) {
  const candidates = [
    req?.body?.country,
    req?.body?.billing_country,
    req?.headers?.['cf-ipcountry'],
    req?.headers?.['x-vercel-ip-country'],
    req?.headers?.['x-country-code']
  ];

  for (const candidate of candidates) {
    const country = String(candidate || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(country) && country !== 'XX') return country;
  }

  const language = String(req?.headers?.['accept-language'] || '');
  const match = language.match(/[-_]([A-Za-z]{2})(?:[,;]|$)/);
  return match ? match[1].toUpperCase() : 'IN';
}

function detectCurrency(req) {
  const supported = allowedCurrencies();
  const requested = normalizeCurrency(req?.body?.currency || req?.query?.currency);
  if (requested && supported.includes(requested)) return requested;

  const country = detectCountry(req);
  const inferred = COUNTRY_TO_CURRENCY[country];
  if (inferred && supported.includes(inferred)) return inferred;

  const fallback = country === 'IN' ? 'INR' : 'USD';
  return supported.includes(fallback) ? fallback : normalizeCurrency(env.defaultCurrency) || 'INR';
}

function toMinor(major, currency) {
  const scale = 10 ** minorUnit(currency);
  return Math.max(Math.round(Number(major || 0) * scale), 0);
}

function fromInrMinor(amountMinor, currency) {
  const normalizedCurrency = normalizeCurrency(currency) || 'INR';
  const amount = Number(amountMinor || 0);
  if (normalizedCurrency === 'INR') return amount;

  const rates = parseExchangeRates();
  const rate = Number(rates[normalizedCurrency]);
  if (!Number.isFinite(rate) || rate <= 0) return amount;

  const inrMajor = amount / 100;
  const markedUpMajor = inrMajor * rate * (1 + Math.max(Number(env.razorpayInternationalMarkupBps || 0), 0) / 10000);
  return toMinor(markedUpMajor, normalizedCurrency);
}

function planPriceMinor(plan, billingCycle, currency) {
  const cycle = String(billingCycle || 'MONTHLY').toUpperCase();
  const inrMinor = cycle === 'YEARLY' ? plan.yearly_price_minor : plan.monthly_price_minor;
  return fromInrMinor(inrMinor, currency);
}

function serializePlanPrice(plan, currency) {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    plan_type: plan.plan_type,
    seat_limit: plan.seat_limit,
    monthly_price_minor: planPriceMinor(plan, 'MONTHLY', currency),
    yearly_price_minor: planPriceMinor(plan, 'YEARLY', currency),
    currency,
    base_currency: env.defaultCurrency,
    feature_limits_json: plan.feature_limits_json
  };
}

module.exports = {
  allowedCurrencies,
  detectCountry,
  detectCurrency,
  minorUnit,
  normalizeCurrency,
  planPriceMinor,
  serializePlanPrice
};
