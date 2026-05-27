const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { env } = require('../config/env');

function normalizeCouponCode(value) {
  return String(value || '').trim().toUpperCase();
}

function parsePlanCodeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean);
  }
  return [];
}

function toMinorStringAmount(amountMinor) {
  return (Number(amountMinor || 0) / 100).toFixed(2);
}

function computeDiscountMinor({ coupon, baseAmountMinor }) {
  if (!coupon) return 0;

  let discountMinor = 0;
  if (coupon.discount_type === 'FIXED_AMOUNT') {
    discountMinor = Number(coupon.amount_minor || 0);
  } else {
    const percentage = Number(coupon.percentage_off || 0);
    discountMinor = Math.round((Number(baseAmountMinor || 0) * percentage) / 100);
  }

  if (coupon.max_discount_minor) {
    discountMinor = Math.min(discountMinor, Number(coupon.max_discount_minor));
  }

  discountMinor = Math.min(discountMinor, Number(baseAmountMinor || 0));
  return Math.max(discountMinor, 0);
}

async function findCouponByCode(code) {
  const normalizedCode = normalizeCouponCode(code);
  if (!normalizedCode) return null;
  return prisma.coupon.findUnique({ where: { code: normalizedCode } });
}

async function validateCouponForCheckout({ accountId, tenantId = null, plan, couponCode, baseAmountMinor, currency = env.defaultCurrency }) {
  const normalizedCode = normalizeCouponCode(couponCode);
  if (!normalizedCode) {
    return {
      coupon: null,
      pricing: {
        base_amount_minor: Number(baseAmountMinor || 0),
        discount_minor: 0,
        final_amount_minor: Number(baseAmountMinor || 0),
        currency
      }
    };
  }

  const coupon = await findCouponByCode(normalizedCode);
  if (!coupon || !coupon.is_active) throw httpError(404, 'Coupon not found');

  const now = new Date();
  if (coupon.active_from && coupon.active_from > now) throw httpError(400, 'Coupon is not active yet');
  if (coupon.expires_at && coupon.expires_at <= now) throw httpError(400, 'Coupon has expired');
  if (coupon.currency && coupon.currency !== currency) throw httpError(400, 'Coupon currency does not match this checkout');
  if (coupon.usage_limit && Number(coupon.used_count || 0) >= Number(coupon.usage_limit)) {
    throw httpError(400, 'Coupon usage limit has been reached');
  }
  if (coupon.min_amount_minor && Number(baseAmountMinor || 0) < Number(coupon.min_amount_minor)) {
    throw httpError(400, `Coupon requires a minimum order amount of ${toMinorStringAmount(coupon.min_amount_minor)}`);
  }

  const applicablePlanCodes = parsePlanCodeList(coupon.applies_to_plan_codes);
  if (applicablePlanCodes.length && !applicablePlanCodes.includes(String(plan?.code || '').toUpperCase())) {
    throw httpError(400, 'Coupon is not applicable to the selected plan');
  }

  if (coupon.first_payment_only) {
    const priorSuccessCount = await prisma.payment.count({
      where: {
        status: 'SUCCEEDED',
        tenant: {
          owner_account_id: accountId
        }
      }
    });
    if (priorSuccessCount > 0) {
      throw httpError(400, 'Coupon is only valid on the first successful payment');
    }
  }

  if (coupon.per_account_limit) {
    const redemptionCount = await prisma.couponRedemption.count({
      where: {
        coupon_id: coupon.id,
        account_id: accountId,
        status: { in: ['APPLIED', 'CONSUMED'] }
      }
    });
    if (redemptionCount >= Number(coupon.per_account_limit)) {
      throw httpError(400, 'Coupon usage limit for this account has been reached');
    }
  }

  const discountMinor = computeDiscountMinor({ coupon, baseAmountMinor });
  return {
    coupon,
    pricing: {
      base_amount_minor: Number(baseAmountMinor || 0),
      discount_minor: discountMinor,
      final_amount_minor: Math.max(Number(baseAmountMinor || 0) - discountMinor, 0),
      currency
    }
  };
}

async function consumeCouponRedemption({ payment, accountId, tenantId }) {
  if (!payment?.coupon_id) return null;

  const existing = await prisma.couponRedemption.findFirst({
    where: {
      coupon_id: payment.coupon_id,
      account_id: accountId,
      payment_id: payment.id
    }
  });
  if (existing) return existing;

  const redemption = await prisma.$transaction(async (tx) => {
    const created = await tx.couponRedemption.create({
      data: {
        coupon_id: payment.coupon_id,
        account_id: accountId,
        tenant_id: tenantId,
        payment_id: payment.id,
        status: 'CONSUMED',
        discount_minor: Number(payment.discount_minor || 0),
        consumed_at: new Date(),
        metadata_json: {
          payment_id: payment.id,
          amount_minor: payment.amount_minor
        }
      }
    });

    await tx.coupon.update({
      where: { id: payment.coupon_id },
      data: {
        used_count: {
          increment: 1
        }
      }
    });

    return created;
  });

  return redemption;
}

async function listAccountCoupons(accountId) {
  const [createdCoupons, redemptions] = await Promise.all([
    prisma.coupon.findMany({
      where: {
        OR: [
          { created_by_account_id: accountId },
          { redemptions: { some: { account_id: accountId } } }
        ]
      },
      orderBy: { created_at: 'desc' },
      take: 20
    }),
    prisma.couponRedemption.findMany({
      where: { account_id: accountId },
      include: {
        coupon: true,
        payment: {
          select: {
            id: true,
            amount_minor: true,
            currency: true,
            status: true,
            created_at: true
          }
        }
      },
      orderBy: { applied_at: 'desc' },
      take: 20
    })
  ]);

  return {
    created: createdCoupons,
    redemptions
  };
}

module.exports = {
  normalizeCouponCode,
  findCouponByCode,
  validateCouponForCheckout,
  consumeCouponRedemption,
  listAccountCoupons
};
