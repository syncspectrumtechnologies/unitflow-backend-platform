const prisma = require('../config/db');
const { env } = require('../config/env');
const httpError = require('../utils/httpError');
const { safeSlug } = require('../utils/security');
const { createNotification } = require('./notificationService');
const { createAudit } = require('./auditService');

function randomCodeSuffix(length = 5) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
}

async function generateUniqueReferralCode(seedValue) {
  const base = safeSlug(seedValue || 'unitflow').replace(/-/g, '').slice(0, 8).toUpperCase() || 'UNITFLOW';
  let attempts = 0;

  while (attempts < 20) {
    attempts += 1;
    const code = `${base}${randomCodeSuffix(4)}`;
    const existing = await prisma.account.findFirst({
      where: { referral_code: code },
      select: { id: true }
    });
    if (!existing) return code;
  }

  return `UF${Date.now().toString(36).toUpperCase()}${randomCodeSuffix(3)}`;
}

async function assignReferralCodeToAccount(account) {
  if (account?.referral_code) return account.referral_code;
  const referralCode = await generateUniqueReferralCode(account?.name || account?.email || account?.id);
  await prisma.account.update({
    where: { id: account.id },
    data: { referral_code: referralCode }
  });
  return referralCode;
}

async function resolveReferrerAccountId(referralCode, accountId = null) {
  const normalizedCode = String(referralCode || '').trim().toUpperCase();
  if (!normalizedCode) return null;

  const referrer = await prisma.account.findFirst({
    where: { referral_code: normalizedCode, status: 'ACTIVE' },
    select: { id: true }
  });
  if (!referrer) throw httpError(404, 'Referral code not found');
  if (accountId && referrer.id === accountId) throw httpError(400, 'You cannot use your own referral code');
  return referrer.id;
}

async function createCreditLedgerEntry(tx, { accountId, direction = 'CREDIT', entryType, amountMinor, currency = env.defaultCurrency, referenceType = null, referenceId = null, metadata = null }) {
  const account = await tx.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      referral_credit_balance_minor: true,
      lifetime_referral_earnings_minor: true
    }
  });
  if (!account) throw httpError(404, 'Account not found for credit entry');

  const normalizedAmount = Math.max(Number(amountMinor || 0), 0);
  const nextBalance = direction === 'DEBIT'
    ? Math.max(Number(account.referral_credit_balance_minor || 0) - normalizedAmount, 0)
    : Number(account.referral_credit_balance_minor || 0) + normalizedAmount;

  await tx.account.update({
    where: { id: accountId },
    data: {
      referral_credit_balance_minor: nextBalance,
      lifetime_referral_earnings_minor: direction === 'CREDIT'
        ? Number(account.lifetime_referral_earnings_minor || 0) + normalizedAmount
        : account.lifetime_referral_earnings_minor
    }
  });

  return tx.accountCreditLedger.create({
    data: {
      account_id: accountId,
      direction,
      entry_type: entryType,
      amount_minor: normalizedAmount,
      currency,
      balance_after_minor: nextBalance,
      reference_type: referenceType,
      reference_id: referenceId,
      metadata_json: metadata || undefined
    }
  });
}

async function rewardReferrerForSuccessfulPayment({ tenant, payment }) {
  if (!tenant?.owner_account_id) return null;

  const owner = await prisma.account.findUnique({
    where: { id: tenant.owner_account_id },
    select: {
      id: true,
      name: true,
      email: true,
      referred_by_account_id: true
    }
  });
  if (!owner?.referred_by_account_id) return null;

  const existingReward = await prisma.referralReward.findFirst({
    where: {
      referred_account_id: owner.id,
      status: { in: ['PENDING', 'APPROVED'] }
    }
  });
  if (existingReward) return existingReward;

  const rewardMinor = Math.max(Number(env.referralRewardMinor || 0), 0);
  if (!rewardMinor) return null;

  const reward = await prisma.$transaction(async (tx) => {
    const created = await tx.referralReward.create({
      data: {
        referrer_account_id: owner.referred_by_account_id,
        referred_account_id: owner.id,
        tenant_id: tenant.id,
        payment_id: payment.id,
        reward_minor: rewardMinor,
        currency: payment.currency || env.defaultCurrency,
        status: 'APPROVED',
        approved_at: new Date(),
        metadata_json: {
          tenant_id: tenant.id,
          payment_id: payment.id,
          payment_amount_minor: payment.amount_minor
        }
      }
    });

    await createCreditLedgerEntry(tx, {
      accountId: owner.referred_by_account_id,
      direction: 'CREDIT',
      entryType: 'REFERRAL_REWARD',
      amountMinor: rewardMinor,
      currency: payment.currency || env.defaultCurrency,
      referenceType: 'referral_reward',
      referenceId: created.id,
      metadata: {
        referred_account_id: owner.id,
        tenant_id: tenant.id,
        payment_id: payment.id
      }
    });

    return created;
  });

  await Promise.all([
    createNotification({
      accountId: owner.referred_by_account_id,
      tenantId: tenant.id,
      type: 'referral.reward.approved',
      title: 'Referral reward earned',
      body: `You earned a referral reward for ${owner.name || owner.email}.`,
      payload: {
        reward_id: reward.id,
        reward_minor: reward.reward_minor,
        referred_account_id: owner.id
      }
    }),
    createAudit({
      actorType: 'SYSTEM',
      actorId: null,
      tenantId: tenant.id,
      entityType: 'referral_reward',
      entityId: reward.id,
      action: 'referral.reward.approved',
      metadata: {
        referrer_account_id: owner.referred_by_account_id,
        referred_account_id: owner.id,
        payment_id: payment.id
      }
    })
  ]);

  return reward;
}

function buildReferralLink(referralCode) {
  if (!referralCode) return null;
  if (!env.publicAppBaseUrl) return null;
  return `${String(env.publicAppBaseUrl).replace(/\/+$/, '')}/signup?ref=${encodeURIComponent(referralCode)}`;
}

async function getReferralDashboard(accountId) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      name: true,
      email: true,
      referral_code: true,
      referred_by_account_id: true,
      referral_credit_balance_minor: true,
      lifetime_referral_earnings_minor: true,
      referred_accounts: {
        select: {
          id: true,
          name: true,
          email: true,
          created_at: true,
          owned_tenants: {
            select: {
              id: true,
              display_name: true,
              lifecycle_status: true,
              payments: {
                where: { status: 'SUCCEEDED' },
                select: { id: true, amount_minor: true, currency: true, paid_at: true },
                orderBy: { paid_at: 'desc' },
                take: 1
              }
            },
            orderBy: { created_at: 'desc' },
            take: 1
          }
        },
        orderBy: { created_at: 'desc' }
      },
      referral_rewards_given: {
        orderBy: { created_at: 'desc' },
        take: 20,
        include: {
          referred: {
            select: { id: true, name: true, email: true }
          }
        }
      },
      credit_ledger_entries: {
        orderBy: { created_at: 'desc' },
        take: 20
      }
    }
  });

  if (!account) throw httpError(404, 'Account not found');

  const referralCode = await assignReferralCodeToAccount(account);
  const referredAccounts = account.referred_accounts || [];
  const approvedRewards = (account.referral_rewards_given || []).filter((reward) => reward.status === 'APPROVED');

  return {
    referral_code: referralCode,
    referral_link: buildReferralLink(referralCode),
    credit_balance_minor: Number(account.referral_credit_balance_minor || 0),
    lifetime_earnings_minor: Number(account.lifetime_referral_earnings_minor || 0),
    referred_accounts_count: referredAccounts.length,
    approved_rewards_count: approvedRewards.length,
    pending_rewards_count: (account.referral_rewards_given || []).filter((reward) => reward.status === 'PENDING').length,
    recent_referrals: referredAccounts.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      created_at: row.created_at,
      latest_workspace: row.owned_tenants?.[0] || null,
      first_successful_payment: row.owned_tenants?.[0]?.payments?.[0] || null
    })),
    rewards: account.referral_rewards_given,
    ledger: account.credit_ledger_entries
  };
}

module.exports = {
  assignReferralCodeToAccount,
  resolveReferrerAccountId,
  rewardReferrerForSuccessfulPayment,
  getReferralDashboard
};
