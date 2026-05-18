const bcrypt = require('bcrypt');
const prisma = require('../config/db');
const { env } = require('../config/env');
const httpError = require('../utils/httpError');
const { signAccountToken } = require('../utils/security');
const {
  createVerification,
  verifyCode,
  normalizeVerificationChannel,
  normalizeVerificationPurpose,
  normalizeVerificationTarget
} = require('../services/verificationService');
const { createAudit } = require('../services/auditService');
const { authenticateRuntimeUser } = require('../services/coreSyncService');
const { upsertRuntimeDevice, createRuntimeSession, isPrivilegedRuntimeAccess } = require('../services/runtimeAccessService');

function normalizeEmail(value) {
  return String(value || '').toLowerCase().trim();
}

function normalizePhone(value) {
  return String(value || '').trim();
}

async function findAccountForVerification({ accountId, email, phone }) {
  if (accountId) {
    const account = await prisma.account.findUnique({ where: { id: String(accountId).trim() } });
    if (account) return account;
  }

  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    const account = await prisma.account.findUnique({ where: { email: normalizedEmail } });
    if (account) return account;
  }

  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone) {
    const account = await prisma.account.findUnique({ where: { phone: normalizedPhone } });
    if (account) return account;
  }

  return null;
}

function buildVerificationTarget(account, channel, explicitTarget) {
  const normalizedChannel = normalizeVerificationChannel(channel);
  if (explicitTarget) return normalizeVerificationTarget(explicitTarget, normalizedChannel);
  return normalizedChannel === 'PHONE'
    ? normalizeVerificationTarget(account.phone, normalizedChannel)
    : normalizeVerificationTarget(account.email, normalizedChannel);
}

exports.signup = async (req, res, next) => {
  try {
    const { email, phone, name, password } = req.body || {};
    if (!email || !phone || !name || !password) throw httpError(400, 'email, phone, name, and password are required');

    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone);
    const existing = await prisma.account.findFirst({ where: { OR: [{ email: normalizedEmail }, { phone: normalizedPhone }] } });
    if (existing) throw httpError(409, 'An account with this email or phone already exists');

    const passwordHash = await bcrypt.hash(String(password), 10);
    const account = await prisma.account.create({
      data: { email: normalizedEmail, phone: normalizedPhone, name: String(name).trim(), password_hash: passwordHash }
    });

    const [emailVerification, phoneVerification] = await Promise.all([
      createVerification({ accountId: account.id, channel: 'EMAIL', purpose: 'SIGNUP', target: account.email }),
      createVerification({ accountId: account.id, channel: 'PHONE', purpose: 'SIGNUP', target: account.phone })
    ]);

    await createAudit({ actorType: 'ACCOUNT', actorId: account.id, entityType: 'account', entityId: account.id, action: 'account.created' });

    return res.status(201).json({
      ok: true,
      account_id: account.id,
      verification_required: true,
      verification_channels: ['EMAIL', 'PHONE'],
      verification_code: env.isProduction ? undefined : emailVerification.code,
      phone_verification_code: env.isProduction ? undefined : phoneVerification.code
    });
  } catch (error) {
    next(error);
  }
};

exports.requestVerification = async (req, res, next) => {
  try {
    const { account_id, email, phone, channel = 'EMAIL', purpose = 'SIGNUP', target } = req.body || {};
    const normalizedChannel = normalizeVerificationChannel(channel);
    const normalizedPurpose = normalizeVerificationPurpose(purpose);
    const account = await findAccountForVerification({ accountId: account_id, email, phone });
    if (!account) throw httpError(404, 'Account not found');

    const resolvedTarget = buildVerificationTarget(account, normalizedChannel, target);
    if (!resolvedTarget) throw httpError(400, `Account does not have a ${normalizedChannel.toLowerCase()} target`);

    const verification = await createVerification({
      accountId: account.id,
      channel: normalizedChannel,
      purpose: normalizedPurpose,
      target: resolvedTarget
    });

    return res.json({
      ok: true,
      account_id: account.id,
      channel: verification.channel,
      purpose: verification.purpose,
      verification_code: env.isProduction ? undefined : verification.code
    });
  } catch (error) {
    next(error);
  }
};

exports.verify = async (req, res, next) => {
  try {
    const { account_id, email, phone, channel = 'EMAIL', purpose = 'SIGNUP', code, target } = req.body || {};
    if (!code) throw httpError(400, 'code is required');

    const normalizedChannel = normalizeVerificationChannel(channel);
    const normalizedPurpose = normalizeVerificationPurpose(purpose);
    const account = await findAccountForVerification({ accountId: account_id, email, phone });
    if (!account) throw httpError(404, 'Account not found');

    const resolvedTarget = buildVerificationTarget(account, normalizedChannel, target);
    if (!resolvedTarget) throw httpError(400, `Account does not have a ${normalizedChannel.toLowerCase()} target`);

    await verifyCode({ accountId: account.id, channel: normalizedChannel, purpose: normalizedPurpose, target: resolvedTarget, code });

    const updateData = normalizedChannel === 'EMAIL' ? { email_verified_at: new Date() } : { phone_verified_at: new Date() };
    await prisma.account.update({ where: { id: account.id }, data: updateData });
    await createAudit({
      actorType: 'ACCOUNT',
      actorId: account.id,
      entityType: 'account',
      entityId: account.id,
      action: 'account.verified',
      metadata: { channel: normalizedChannel, purpose: normalizedPurpose }
    });

    const refreshed = await prisma.account.findUnique({ where: { id: account.id } });
    return res.json({
      ok: true,
      verified: true,
      account_id: account.id,
      channel: normalizedChannel,
      email_verified_at: refreshed?.email_verified_at || null,
      phone_verified_at: refreshed?.phone_verified_at || null
    });
  } catch (error) {
    next(error);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) throw httpError(400, 'email and password are required');
    const account = await prisma.account.findUnique({ where: { email: normalizeEmail(email) } });
    if (!account) throw httpError(401, 'Invalid credentials');
    if (account.status !== 'ACTIVE') throw httpError(403, 'Account is disabled');
    if (!account.email_verified_at) throw httpError(403, 'Email verification is required before login');

    const ok = await bcrypt.compare(String(password), account.password_hash);
    if (!ok) throw httpError(401, 'Invalid credentials');

    const { token, jti } = signAccountToken({ account_id: account.id, email: account.email, is_super_admin: account.is_super_admin }, env.jwtExpiresIn);
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

    await prisma.platformSession.create({
      data: {
        account_id: account.id,
        jti,
        ip: req.ip,
        user_agent: req.headers['user-agent'] || null,
        expires_at: expiresAt
      }
    });

    await prisma.account.update({ where: { id: account.id }, data: { last_login_at: new Date() } });

    return res.json({
      ok: true,
      token,
      account: {
        id: account.id,
        email: account.email,
        name: account.name,
        is_super_admin: account.is_super_admin,
        runtime_access_exempt: account.runtime_access_exempt
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.runtimeLogin = async (req, res, next) => {
  try {
    const {
      email,
      password,
      tenant_id,
      device_fingerprint,
      device_name,
      platform,
      os_version,
      app_version,
      force_takeover = false,
      force_seat_transfer = false,
      seat_transfer_user_id = null
    } = req.body || {};

    if (!email || !password) throw httpError(400, 'email and password are required');
    if (!tenant_id) throw httpError(400, 'tenant_id is required');
    if (!device_fingerprint) throw httpError(400, 'device_fingerprint is required');

    const requestedTenant = await prisma.tenant.findUnique({
      where: { id: tenant_id },
      include: {
        owner: true,
        subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 },
        devices: true
      }
    });
    if (!requestedTenant) throw httpError(404, 'Tenant not found');

    let runtimeAuth;
    try {
      runtimeAuth = await authenticateRuntimeUser({
        tenant_id,
        email: normalizeEmail(email),
        password: String(password)
      });
    } catch (error) {
      const status = error?.response?.status;
      const remoteMessage = error?.response?.data?.message;
      if (status === 401) throw httpError(401, 'Invalid credentials');
      if (status === 403) throw httpError(403, remoteMessage || 'Runtime user is not allowed to login');
      throw httpError(status || 502, remoteMessage || 'Runtime authentication bridge failed');
    }

    const runtimeUser = runtimeAuth?.user;
    if (!runtimeUser) throw httpError(401, 'Invalid credentials');
    if (String(runtimeUser.company_id) !== String(requestedTenant.runtime_company_id || requestedTenant.id)) {
      throw httpError(403, 'Runtime user does not belong to the requested tenant');
    }
    const tenant = requestedTenant;

    const privilegedAccess = isPrivilegedRuntimeAccess(tenant);

    const { device, seatPolicy } = await upsertRuntimeDevice({
      tenant,
      accountId: tenant.owner_account_id,
      deviceFingerprint: device_fingerprint,
      deviceName: device_name,
      platform,
      osVersion: os_version,
      appVersion: app_version,
      forceTakeover: force_takeover,
      runtimeUser,
      forceSeatTransfer: force_seat_transfer,
      seatTransferUserId: seat_transfer_user_id,
      allowPrivilegedBypass: privilegedAccess
    });

    const { token, session, plan, role, access_mode } = await createRuntimeSession({
      tenant,
      accountId: tenant.owner_account_id,
      deviceId: device.id,
      runtimeUser,
      allowPrivilegedBypass: privilegedAccess
    });

    await createAudit({
      actorType: 'RUNTIME_USER',
      actorId: runtimeUser.id,
      tenantId: tenant.id,
      entityType: 'runtime_session',
      entityId: session.id,
      action: 'runtime.login',
      metadata: {
        device_id: device.id,
        device_name: device.device_name,
        platform: device.platform,
        plan,
        role,
        access_mode,
        runtime_user_id: runtimeUser.id,
        runtime_user_email: runtimeUser.email,
        runtime_user_name: runtimeUser.name,
        force_takeover,
        force_seat_transfer,
        displaced_user: seatPolicy?.displacedSeat?.runtime_user_email || null,
        privileged_runtime_access: privilegedAccess
      }
    });

    return res.json({
      ok: true,
      token,
      expires_in: env.runtimeJwtExpiresIn,
      tenant: {
        id: tenant.id,
        display_name: tenant.display_name,
        lifecycle_status: tenant.lifecycle_status,
        runtime_provision_status: tenant.runtime_provision_status,
        privileged_runtime_access: privilegedAccess
      },
      user: {
        id: runtimeUser.id,
        email: runtimeUser.email,
        name: runtimeUser.name,
        company_id: runtimeUser.company_id,
        is_admin: runtimeUser.is_admin,
        roles: runtimeUser.roles,
        role
      },
      device,
      runtime_session: { id: session.id, expires_at: session.expires_at },
      plan,
      access_mode,
      seat_transfer: seatPolicy?.displacedSeat ? {
        from_user: seatPolicy.displacedSeat.runtime_user_email,
        session_count: seatPolicy.displacedSeat.session_ids.length
      } : null
    });
  } catch (error) {
    next(error);
  }
};

exports.me = async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { owner_account_id: req.account.id },
      include: { subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 }, config: true, locations: true },
      orderBy: { created_at: 'desc' }
    });
    return res.json({
      ok: true,
      account: {
        id: req.account.id,
        email: req.account.email,
        phone: req.account.phone,
        name: req.account.name,
        email_verified_at: req.account.email_verified_at,
        phone_verified_at: req.account.phone_verified_at,
        status: req.account.status,
        is_super_admin: req.account.is_super_admin,
        runtime_access_exempt: req.account.runtime_access_exempt
      },
      tenants
    });
  } catch (error) {
    next(error);
  }
};

exports.logout = async (req, res, next) => {
  try {
    await prisma.platformSession.update({ where: { id: req.session.id }, data: { revoked_at: new Date() } });
    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};
