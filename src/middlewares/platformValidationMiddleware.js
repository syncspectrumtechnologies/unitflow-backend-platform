const httpError = require('../utils/httpError');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_ID_PATTERN = /^[a-zA-Z0-9._-]{3,40}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_COLOR_PATTERN = /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/;
const ERP_MODULES = new Set([
  'dashboard',
  'orders',
  'inventory',
  'production',
  'purchases',
  'clients',
  'products',
  'categories',
  'invoices',
  'payments',
  'accounting',
  'tally',
  'chat',
  'broadcast',
  'messages',
  'factories'
]);
const FEATURE_FLAGS = new Set([
  'auto_deduct_inventory_on_dispatch',
  'keyboard_shortcuts',
  'simple_mode',
  'low_stock_suggestions',
  'order_shortage_warnings'
]);

function body(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw httpError(400, 'Request body must be a JSON object');
  }
  return req.body;
}

function trim(value) {
  return String(value ?? '').trim();
}

function optionalText(obj, key, max = 500) {
  if (obj[key] === undefined || obj[key] === null || obj[key] === '') return;
  const value = trim(obj[key]);
  if (value.length > max) throw httpError(400, `${key} is too long`);
  obj[key] = value;
}

function requiredText(obj, key, max = 500) {
  const value = trim(obj[key]);
  if (!value) throw httpError(400, `${key} is required`);
  if (value.length > max) throw httpError(400, `${key} is too long`);
  obj[key] = value;
}

function email(obj, key, required = true) {
  if (!required && (obj[key] === undefined || obj[key] === null || obj[key] === '')) return;
  const value = trim(obj[key]).toLowerCase();
  if (!value && required) throw httpError(400, `${key} is required`);
  if (value && (!EMAIL_PATTERN.test(value) || value.length > 254)) throw httpError(400, `${key} must be a valid email`);
  obj[key] = value;
}

function password(obj, key = 'password', min = 8) {
  const value = String(obj[key] ?? '');
  if (!value) throw httpError(400, `${key} is required`);
  if (value.length < min || value.length > 128) throw httpError(400, `${key} must be between ${min} and 128 characters`);
}

function id(obj, key, required = true) {
  if (!required && (obj[key] === undefined || obj[key] === null || obj[key] === '')) return;
  const value = trim(obj[key]);
  if (!value && required) throw httpError(400, `${key} is required`);
  if (value && !SAFE_ID_PATTERN.test(value)) throw httpError(400, `${key} is invalid`);
  obj[key] = value;
}

function bool(obj, key) {
  if (obj[key] === undefined) return;
  if (typeof obj[key] !== 'boolean') throw httpError(400, `${key} must be true or false`);
}

function enumValue(obj, key, values, required = false) {
  if (!required && (obj[key] === undefined || obj[key] === null || obj[key] === '')) return;
  const value = trim(obj[key]).toUpperCase();
  if (!values.includes(value)) throw httpError(400, `${key} must be one of: ${values.join(', ')}`);
  obj[key] = value;
}

function optionalUrl(obj, key) {
  if (obj[key] === undefined || obj[key] === null || obj[key] === '') return;
  const value = trim(obj[key]);
  if (value.length > 2000) throw httpError(400, `${key} is too long`);
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
  } catch {
    throw httpError(400, `${key} must be a valid http or https URL`);
  }
  obj[key] = value;
}

function optionalLogoUrl(obj, key) {
  if (obj[key] === undefined || obj[key] === null || obj[key] === '') return;
  const value = trim(obj[key]);
  const dataUrlMatch = value.match(/^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/);
  if (dataUrlMatch) {
    if (value.length > 700000) throw httpError(400, `${key} is too large`);
    obj[key] = value;
    return;
  }
  if (value.length > 2000) throw httpError(400, `${key} is too long`);
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
  } catch {
    throw httpError(400, `${key} must be a valid http/https URL or PNG/JPG data URL`);
  }
  obj[key] = value;
}

function validateBranding(branding = {}) {
  if (!branding || typeof branding !== 'object' || Array.isArray(branding)) throw httpError(400, 'branding must be an object');
  optionalText(branding, 'app_title', 160);
  optionalText(branding, 'invoice_header', 2000);
  optionalText(branding, 'invoice_footer', 2000);
  optionalText(branding, 'locale', 20);
  optionalText(branding, 'timezone', 80);
  optionalLogoUrl(branding, 'logo_url');

  if (branding.theme_color !== undefined && branding.theme_color !== null && branding.theme_color !== '') {
    const value = trim(branding.theme_color);
    if (!HEX_COLOR_PATTERN.test(value)) throw httpError(400, 'branding.theme_color must be a hex color');
    branding.theme_color = value;
  }

  if (branding.enabled_modules !== undefined) validateEnabledModules(branding.enabled_modules);
  if (branding.feature_flags !== undefined) validateFeatureFlags(branding.feature_flags);
}

function validateEnabledModules(value) {
  if (!Array.isArray(value)) throw httpError(400, 'enabled_modules must be an array');
  if (value.length > ERP_MODULES.size) throw httpError(400, 'enabled_modules has too many items');
  for (const item of value) {
    const moduleKey = trim(item).toLowerCase();
    if (!ERP_MODULES.has(moduleKey)) throw httpError(400, `Unknown ERP module: ${item}`);
  }
}

function validateFeatureFlags(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'feature_flags must be an object');
  for (const [key, item] of Object.entries(value)) {
    if (!FEATURE_FLAGS.has(key)) throw httpError(400, `Unknown feature flag: ${key}`);
    if (typeof item !== 'boolean') throw httpError(400, `feature_flags.${key} must be true or false`);
  }
}

function validateLocations(value) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw httpError(400, 'locations must be an array');
  if (value.length > 25) throw httpError(400, 'locations has too many items');
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw httpError(400, `locations[${index}] must be an object`);
    requiredText(item, 'name', 160);
    optionalText(item, 'code', 40);
    optionalText(item, 'address', 1000);
    bool(item, 'is_active');
  });
}

function validateSalesCompanies(value) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw httpError(400, 'sales_companies must be an array');
  if (value.length > 25) throw httpError(400, 'sales_companies has too many items');
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw httpError(400, `sales_companies[${index}] must be an object`);
    if (item.same_as_main_company !== true) requiredText(item, 'name', 160);
    optionalText(item, 'legal_name', 180);
    optionalText(item, 'gstin', 32);
    optionalText(item, 'phone', 40);
    email(item, 'email', false);
    optionalText(item, 'address', 1000);
    optionalText(item, 'state', 80);
    optionalText(item, 'state_code', 20);
    bool(item, 'is_gst_enabled');
    bool(item, 'is_active');
    bool(item, 'same_as_main_company');
  });
}

function validateSignup(req, res, next) {
  try {
    const data = body(req);
    email(data, 'email');
    requiredText(data, 'name', 120);
    requiredText(data, 'phone', 40);
    password(data);
    optionalText(data, 'referral_code', 64);
    next();
  } catch (error) {
    next(error);
  }
}

function validateLogin(req, res, next) {
  try {
    const data = body(req);
    email(data, 'email');
    password(data, 'password', 1);
    next();
  } catch (error) {
    next(error);
  }
}

function validateVerificationBase(data) {
  id(data, 'account_id', false);
  email(data, 'email', false);
  optionalText(data, 'phone', 40);
  enumValue(data, 'channel', ['EMAIL'], false);
  enumValue(data, 'purpose', ['SIGNUP', 'LOGIN', 'RESET'], false);
  email(data, 'target', false);
  if (!data.account_id && !data.email && !data.phone) throw httpError(400, 'account_id or email is required');
}

function validateVerificationRequest(req, res, next) {
  try {
    const data = body(req);
    validateVerificationBase(data);
    next();
  } catch (error) {
    next(error);
  }
}

function validateVerificationSubmit(req, res, next) {
  try {
    const data = body(req);
    validateVerificationBase(data);
    requiredText(data, 'code', 12);
    if (!/^\d{4,12}$/.test(data.code)) throw httpError(400, 'code must be numeric');
    next();
  } catch (error) {
    next(error);
  }
}

function validateRuntimeLogin(req, res, next) {
  try {
    const data = body(req);
    email(data, 'email', false);
    optionalText(data, 'login_id', 40);
    optionalText(data, 'identifier', 80);
    const loginId = data.login_id || data.identifier;
    if (!data.email && !loginId) throw httpError(400, 'email or login_id is required');
    if (!data.email && loginId && !LOGIN_ID_PATTERN.test(loginId)) throw httpError(400, 'login_id is invalid');
    password(data, 'password', 1);
    id(data, 'tenant_id');
    requiredText(data, 'device_fingerprint', 256);
    optionalText(data, 'device_name', 120);
    optionalText(data, 'platform', 40);
    optionalText(data, 'os_version', 80);
    optionalText(data, 'app_version', 80);
    id(data, 'seat_transfer_user_id', false);
    bool(data, 'force_takeover');
    bool(data, 'force_seat_transfer');
    next();
  } catch (error) {
    next(error);
  }
}

function validateTenantPayload(req, res, next) {
  try {
    const data = body(req);
    id(data, 'tenant_id', false);
    optionalText(data, 'display_name', 160);
    optionalText(data, 'legal_name', 180);
    optionalText(data, 'business_type', 100);
    optionalText(data, 'coupon_code', 64);
    enumValue(data, 'plan_code', ['SINGLE_USER', 'MULTI_USER'], false);
    enumValue(data, 'billing_cycle', ['MONTHLY', 'YEARLY'], false);
    enumValue(data, 'gateway_mode', ['RAZORPAY'], false);
    if (data.slug !== undefined && data.slug !== null && data.slug !== '') {
      const value = trim(data.slug).toLowerCase();
      if (value.length > 80 || !SLUG_PATTERN.test(value)) throw httpError(400, 'slug is invalid');
      data.slug = value;
    }
    validateBranding(data.branding || {});
    validateLocations(data.locations);
    validateSalesCompanies(data.sales_companies);
    next();
  } catch (error) {
    next(error);
  }
}

function validateTenantConfig(req, res, next) {
  try {
    const data = body(req);
    const company = data.company || {};
    if (company && (typeof company !== 'object' || Array.isArray(company))) throw httpError(400, 'company must be an object');
    optionalText(company, 'display_name', 160);
    optionalText(company, 'legal_name', 180);
    optionalText(company, 'business_type', 100);
    validateBranding(data.branding || {});
    if (data.enabled_modules !== undefined) validateEnabledModules(data.enabled_modules);
    if (data.feature_flags !== undefined) validateFeatureFlags(data.feature_flags);
    validateLocations(data.locations);
    validateSalesCompanies(data.sales_companies);
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  validateSignup,
  validateLogin,
  validateVerificationRequest,
  validateVerificationSubmit,
  validateRuntimeLogin,
  validateTenantPayload,
  validateTenantConfig
};
