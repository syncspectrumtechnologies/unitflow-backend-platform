const nodemailer = require('nodemailer');
const prisma = require('../config/db');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const { generateNumericCode, hashValue } = require('../utils/security');
const httpError = require('../utils/httpError');

const ALLOWED_CHANNELS = new Set(['EMAIL', 'PHONE']);
const ALLOWED_PURPOSES = new Set(['SIGNUP', 'LOGIN', 'RESET']);

function normalizeVerificationChannel(channel) {
  const normalized = String(channel || 'EMAIL').trim().toUpperCase();
  if (!ALLOWED_CHANNELS.has(normalized)) throw httpError(400, 'channel must be EMAIL or PHONE');
  return normalized;
}

function normalizeVerificationPurpose(purpose) {
  const normalized = String(purpose || 'SIGNUP').trim().toUpperCase();
  if (!ALLOWED_PURPOSES.has(normalized)) throw httpError(400, 'purpose must be SIGNUP, LOGIN, or RESET');
  return normalized;
}

function normalizeVerificationTarget(target, channel) {
  if (target === undefined || target === null || target === '') return null;
  return channel === 'EMAIL' ? String(target).toLowerCase().trim() : String(target).trim();
}

async function maybeSendEmail(target, subject, text) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    logger.info('Skipping outbound email because SMTP is not configured', { email_target: target, subject });
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    requireTLS: String(process.env.SMTP_STARTTLS || 'true').toLowerCase() === 'true'
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
    to: target,
    subject,
    text
  });
  return true;
}

async function createVerification({ accountId, channel, purpose, target }) {
  const normalizedChannel = normalizeVerificationChannel(channel);
  const normalizedPurpose = normalizeVerificationPurpose(purpose);
  const normalizedTarget = normalizeVerificationTarget(target, normalizedChannel);
  if (!normalizedTarget) throw httpError(400, 'Verification target is required');

  const code = generateNumericCode(6);
  const expiresAt = new Date(Date.now() + env.verificationCodeTtlMinutes * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.accountVerification.updateMany({
      where: {
        account_id: accountId,
        channel: normalizedChannel,
        purpose: normalizedPurpose,
        target: normalizedTarget,
        consumed_at: null,
        expires_at: { gt: new Date() }
      },
      data: { consumed_at: new Date() }
    });

    await tx.accountVerification.create({
      data: {
        account_id: accountId,
        channel: normalizedChannel,
        purpose: normalizedPurpose,
        target: normalizedTarget,
        code_hash: hashValue(code),
        expires_at: expiresAt
      }
    });
  });

  if (normalizedChannel === 'EMAIL') {
    await maybeSendEmail(normalizedTarget, 'UnitFlow verification code', `Your UnitFlow verification code is ${code}. It expires in ${env.verificationCodeTtlMinutes} minutes.`);
  }

  return { code, expires_at: expiresAt, channel: normalizedChannel, purpose: normalizedPurpose, target: normalizedTarget };
}

async function verifyCode({ accountId, channel, purpose, target, code }) {
  const normalizedChannel = normalizeVerificationChannel(channel);
  const normalizedPurpose = normalizeVerificationPurpose(purpose);
  const normalizedTarget = normalizeVerificationTarget(target, normalizedChannel);
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) throw httpError(400, 'Verification code is required');

  const baseWhere = {
    account_id: accountId,
    channel: normalizedChannel,
    purpose: normalizedPurpose,
    consumed_at: null,
    expires_at: { gt: new Date() }
  };

  let record = null;

  if (normalizedTarget) {
    record = await prisma.accountVerification.findFirst({
      where: { ...baseWhere, target: normalizedTarget },
      orderBy: { created_at: 'desc' }
    });
  }

  if (!record) {
    record = await prisma.accountVerification.findFirst({
      where: baseWhere,
      orderBy: { created_at: 'desc' }
    });
  }

  if (!record) throw httpError(400, 'No active verification code found');
  if (record.code_hash !== hashValue(normalizedCode)) throw httpError(400, 'Invalid verification code');

  await prisma.accountVerification.update({
    where: { id: record.id },
    data: { consumed_at: new Date() }
  });

  return record;
}

module.exports = {
  createVerification,
  verifyCode,
  normalizeVerificationChannel,
  normalizeVerificationPurpose,
  normalizeVerificationTarget
};
