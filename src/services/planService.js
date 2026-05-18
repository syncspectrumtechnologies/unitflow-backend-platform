const prisma = require('../config/db');
const { env } = require('../config/env');

async function ensureDefaultPlans() {
  const defs = [
    {
      code: 'SINGLE_USER',
      name: 'Single User',
      description: 'Single active user seat, one active device at a time.',
      plan_type: 'SINGLE_USER',
      seat_limit: 1,
      monthly_price_minor: env.singleMonthlyMinor,
      yearly_price_minor: env.singleYearlyMinor,
      trial_days: 0,
      feature_limits_json: {
        max_users: 1,
        max_factories: 1,
        max_active_devices_per_seat: 1,
        max_products: 500,
        max_orders_per_month: 500,
        max_invoices_per_month: 500,
        api_access: false,
        mobile_companion_access: false,
        advanced_exports: false,
        premium_messaging: false,
        plan_family: 'single',
        enabled_modules: ['core_erp', 'inventory', 'orders', 'invoices', 'payments', 'purchases']
      }
    },
    {
      code: 'MULTI_USER',
      name: 'Multi User',
      description: 'Team plan for small factories and warehouses.',
      plan_type: 'MULTI_USER',
      seat_limit: env.multiSeatLimit,
      monthly_price_minor: env.multiMonthlyMinor,
      yearly_price_minor: env.multiYearlyMinor,
      trial_days: 0,
      feature_limits_json: {
        max_users: env.multiSeatLimit,
        max_factories: 5,
        max_active_devices_per_seat: 2,
        max_products: 10000,
        max_orders_per_month: 10000,
        max_invoices_per_month: 10000,
        api_access: false,
        mobile_companion_access: false,
        advanced_exports: true,
        premium_messaging: true,
        plan_family: 'multi',
        enabled_modules: ['core_erp', 'inventory', 'orders', 'invoices', 'payments', 'purchases', 'chat', 'broadcast', 'stats']
      }
    }
  ];

  for (const def of defs) {
    await prisma.subscriptionPlan.upsert({ where: { code: def.code }, update: def, create: def });
  }
}

async function getPlanByCode(code) {
  return prisma.subscriptionPlan.findFirst({ where: { code, is_active: true } });
}

async function listActivePlans() {
  return prisma.subscriptionPlan.findMany({ where: { is_active: true }, orderBy: { created_at: 'asc' } });
}

module.exports = { ensureDefaultPlans, getPlanByCode, listActivePlans };
