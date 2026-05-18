const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { env } = require('../config/env');
const { signRuntimeToken, hashDeviceFingerprint } = require('../utils/security');
const { createAudit } = require('./auditService');

function expiresInToMs(value) {
  const v = String(value || '12h').trim();
  const m = v.match(/^(\d+)([smhd])?$/i);
  if (!m) return 12 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

function getLatestSubscription(tenant) {
  return Array.isArray(tenant.subscriptions) ? tenant.subscriptions[0] || null : null;
}

function isRuntimeProvisionReady(tenant) {
  return Boolean(tenant?.runtime_company_id) && ['READY', 'SYNC_PENDING'].includes(String(tenant?.runtime_provision_status || ''));
}

function isPrivilegedRuntimeAccess(tenant) {
  return Boolean(tenant?.owner?.is_super_admin && tenant?.owner?.runtime_access_exempt);
}

function assertRuntimeEligible(tenant, { allowPrivilegedBypass = false } = {}) {
  if (!tenant) throw httpError(404, 'Tenant not found');
  if (!isRuntimeProvisionReady(tenant)) {
    throw httpError(403, 'Tenant provisioning is not complete yet');
  }

  if (allowPrivilegedBypass && isPrivilegedRuntimeAccess(tenant)) {
    if (tenant.owner?.status !== 'ACTIVE') throw httpError(403, 'Super admin owner account is disabled');
    return {
      status: 'ACTIVE',
      seat_limit: Number.MAX_SAFE_INTEGER,
      plan: {
        code: 'SUPER_ADMIN',
        name: 'Super Admin Access',
        plan_type: 'MULTI_USER'
      },
      privileged_bypass: true
    };
  }

  if (!['ACTIVE', 'GRACE'].includes(tenant.lifecycle_status)) {
    throw httpError(403, 'Tenant is not active for runtime access');
  }

  const latestSubscription = getLatestSubscription(tenant);
  if (!latestSubscription) throw httpError(403, 'No active subscription found');
  if (!['ACTIVE', 'GRACE'].includes(latestSubscription.status)) {
    throw httpError(403, 'Subscription is not active for runtime access');
  }

  return latestSubscription;
}

async function getActiveRuntimeSessions(tenantId) {
  const now = new Date();
  const sessions = await prisma.runtimeSession.findMany({
    where: {
      tenant_id: tenantId,
      revoked_at: null,
      expires_at: { gt: now }
    },
    orderBy: { issued_at: 'asc' }
  });

  if (!sessions.length) return [];

  const audits = await prisma.opsAuditLog.findMany({
    where: {
      tenant_id: tenantId,
      entity_type: 'runtime_session',
      action: 'runtime.login',
      entity_id: { in: sessions.map((s) => s.id) }
    },
    orderBy: { created_at: 'desc' }
  });

  const metadataBySessionId = new Map();
  for (const audit of audits) {
    if (!metadataBySessionId.has(audit.entity_id)) metadataBySessionId.set(audit.entity_id, audit.metadata_json || {});
  }

  return sessions.map((session) => ({
    ...session,
    runtime_user_id: metadataBySessionId.get(session.id)?.runtime_user_id || null,
    runtime_user_email: metadataBySessionId.get(session.id)?.runtime_user_email || null,
    runtime_user_name: metadataBySessionId.get(session.id)?.runtime_user_name || null,
    device_name: metadataBySessionId.get(session.id)?.device_name || null,
    platform: metadataBySessionId.get(session.id)?.platform || null,
    force_takeover: Boolean(metadataBySessionId.get(session.id)?.force_takeover)
  }));
}

function groupActiveSeats(activeSessions) {
  const seatMap = new Map();

  for (const session of activeSessions) {
    const userId = session.runtime_user_id || `session:${session.id}`;
    if (!seatMap.has(userId)) {
      seatMap.set(userId, {
        runtime_user_id: session.runtime_user_id,
        runtime_user_email: session.runtime_user_email,
        runtime_user_name: session.runtime_user_name,
        issued_at: session.issued_at,
        last_seen_at: session.last_seen_at,
        session_ids: [],
        devices: []
      });
    }

    const entry = seatMap.get(userId);
    entry.session_ids.push(session.id);
    entry.last_seen_at = entry.last_seen_at > session.last_seen_at ? entry.last_seen_at : session.last_seen_at;
    if (session.device_id) {
      entry.devices.push({
        id: session.device_id,
        device_name: session.device_name,
        platform: session.platform,
        last_seen_at: session.last_seen_at
      });
    }
  }

  return [...seatMap.values()];
}

async function revokeSeatSessions(tenantId, seat, reason) {
  if (!seat?.session_ids?.length) return;
  const now = new Date();
  await prisma.runtimeSession.updateMany({
    where: { tenant_id: tenantId, id: { in: seat.session_ids }, revoked_at: null },
    data: { revoked_at: now, revoke_reason: reason }
  });
}

async function maybeTouchDevice(deviceId) {
  if (!deviceId) return;
  await prisma.device.updateMany({ where: { id: deviceId }, data: { last_seen_at: new Date() } });
}

async function enforceSeatPolicy({ tenant, latestSubscription, runtimeUser, forceSeatTransfer = false, seatTransferUserId = null, allowPrivilegedBypass = false }) {
  if (allowPrivilegedBypass && latestSubscription?.privileged_bypass) {
    const activeSessions = await getActiveRuntimeSessions(tenant.id);
    return { activeSeats: groupActiveSeats(activeSessions), displacedSeat: null, bypassed: true };
  }

  const activeSessions = await getActiveRuntimeSessions(tenant.id);
  const activeSeats = groupActiveSeats(activeSessions);
  const runtimeUserId = String(runtimeUser.id);
  const existingSeat = activeSeats.find((seat) => seat.runtime_user_id === runtimeUserId || seat.runtime_user_email === runtimeUser.email);

  if (latestSubscription.plan.plan_type === 'SINGLE_USER') {
    const conflictingSeat = activeSeats.find((seat) => (seat.runtime_user_id || seat.runtime_user_email) && seat.runtime_user_id !== runtimeUserId && seat.runtime_user_email !== runtimeUser.email);
    if (conflictingSeat && !forceSeatTransfer) {
      throw httpError(409, 'Another active user seat is already in use for this single-user workspace', {
        code: 'ACTIVE_SEAT_CONFLICT',
        active_seats: activeSeats
      });
    }
    if (conflictingSeat && forceSeatTransfer) {
      await revokeSeatSessions(tenant.id, conflictingSeat, 'seat_transfer');
      await createAudit({
        actorType: 'RUNTIME_USER',
        actorId: runtimeUser.id,
        tenantId: tenant.id,
        entityType: 'seat_assignment',
        entityId: conflictingSeat.runtime_user_id || conflictingSeat.runtime_user_email || tenant.id,
        action: 'seat.transferred',
        metadata: { from_user: conflictingSeat.runtime_user_email, to_user: runtimeUser.email, reason: 'single_user_transfer' }
      });
      return { activeSeats, displacedSeat: conflictingSeat, bypassed: false };
    }
    return { activeSeats, displacedSeat: null, bypassed: false };
  }

  if (existingSeat) {
    return { activeSeats, displacedSeat: null, bypassed: false };
  }

  if (activeSeats.length < latestSubscription.seat_limit) {
    return { activeSeats, displacedSeat: null, bypassed: false };
  }

  if (!forceSeatTransfer) {
    throw httpError(409, 'Seat limit reached for this workspace', {
      code: 'SEAT_LIMIT_REACHED',
      seat_limit: latestSubscription.seat_limit,
      active_seats: activeSeats
    });
  }

  const targetSeat = activeSeats.find((seat) => seat.runtime_user_id === seatTransferUserId || seat.runtime_user_email === seatTransferUserId) || activeSeats[0];
  await revokeSeatSessions(tenant.id, targetSeat, 'seat_transfer');
  await createAudit({
    actorType: 'RUNTIME_USER',
    actorId: runtimeUser.id,
    tenantId: tenant.id,
    entityType: 'seat_assignment',
    entityId: targetSeat.runtime_user_id || targetSeat.runtime_user_email || tenant.id,
    action: 'seat.transferred',
    metadata: {
      from_user: targetSeat.runtime_user_email,
      to_user: runtimeUser.email,
      seat_limit: latestSubscription.seat_limit,
      reason: 'multi_user_transfer'
    }
  });
  return { activeSeats, displacedSeat: targetSeat, bypassed: false };
}

async function upsertRuntimeDevice({ tenant, accountId, deviceFingerprint, deviceName, platform, osVersion, appVersion, forceTakeover = false, runtimeUser = null, forceSeatTransfer = false, seatTransferUserId = null, allowPrivilegedBypass = false }) {
  if (!deviceFingerprint) throw httpError(400, 'device_fingerprint is required');

  const latestSubscription = assertRuntimeEligible(tenant, { allowPrivilegedBypass });
  const seatPolicy = await enforceSeatPolicy({
    tenant,
    latestSubscription,
    runtimeUser: runtimeUser || { id: 'owner', email: null },
    forceSeatTransfer,
    seatTransferUserId,
    allowPrivilegedBypass
  });
  const fingerprintHash = hashDeviceFingerprint(deviceFingerprint);
  const activeOtherDevices = tenant.devices.filter((d) => d.is_active && d.device_fingerprint_hash !== fingerprintHash && !d.revoked_at);

  if (!latestSubscription.privileged_bypass && latestSubscription.plan.plan_type === 'SINGLE_USER' && activeOtherDevices.length > 0 && !forceTakeover) {
    throw httpError(409, 'Another device is already active for this single-user workspace', {
      code: 'ACTIVE_DEVICE_CONFLICT',
      active_devices: activeOtherDevices.map((d) => ({ id: d.id, device_name: d.device_name, platform: d.platform, last_seen_at: d.last_seen_at })),
      active_seats: seatPolicy.activeSeats
    });
  }

  if (activeOtherDevices.length > 0 && runtimeUser) {
    await createAudit({
      actorType: 'RUNTIME_USER',
      actorId: runtimeUser.id,
      tenantId: tenant.id,
      entityType: 'device',
      action: latestSubscription.privileged_bypass ? 'runtime.device.observed' : 'runtime.device.suspicious',
      metadata: {
        device_name: deviceName,
        platform,
        existing_active_devices: activeOtherDevices.map((d) => ({ id: d.id, device_name: d.device_name, platform: d.platform, last_seen_at: d.last_seen_at })),
        force_takeover: forceTakeover,
        privileged_runtime_access: latestSubscription.privileged_bypass
      }
    });
  }

  if (forceTakeover && activeOtherDevices.length > 0) {
    const ids = activeOtherDevices.map((d) => d.id);
    await prisma.device.updateMany({ where: { id: { in: ids } }, data: { is_active: false, revoked_at: new Date() } });
    await prisma.runtimeSession.updateMany({ where: { tenant_id: tenant.id, device_id: { in: ids }, revoked_at: null }, data: { revoked_at: new Date(), revoke_reason: 'device_takeover' } });
  }

  let device = await prisma.device.findFirst({ where: { tenant_id: tenant.id, device_fingerprint_hash: fingerprintHash } });
  if (device) {
    device = await prisma.device.update({
      where: { id: device.id },
      data: {
        account_id: accountId,
        device_name: deviceName || device.device_name,
        platform: platform || device.platform,
        os_version: osVersion || device.os_version,
        app_version: appVersion || device.app_version,
        is_active: true,
        revoked_at: null,
        last_seen_at: new Date()
      }
    });
  } else {
    device = await prisma.device.create({
      data: {
        tenant_id: tenant.id,
        account_id: accountId,
        device_fingerprint_hash: fingerprintHash,
        device_name: deviceName || null,
        platform: platform || null,
        os_version: osVersion || null,
        app_version: appVersion || null,
        is_active: true
      }
    });
  }

  return { device, latestSubscription, seatPolicy };
}

async function createRuntimeSession({ tenant, accountId, deviceId, runtimeUser, allowPrivilegedBypass = false }) {
  const latestSubscription = assertRuntimeEligible(tenant, { allowPrivilegedBypass });
  const role = runtimeUser.role || (runtimeUser.is_admin ? 'ADMIN' : (Array.isArray(runtimeUser.roles) ? runtimeUser.roles[0] : 'STAFF')) || 'STAFF';
  const plan = latestSubscription.plan?.code || latestSubscription.plan_snapshot_json?.code || latestSubscription.plan?.plan_type || null;
  const companyId = tenant.runtime_company_id || tenant.id;
  const accessMode = latestSubscription.privileged_bypass ? 'SUPER_ADMIN_BYPASS' : 'STANDARD';

  const { token, jti } = signRuntimeToken({
    user_id: runtimeUser.id,
    tenant_id: tenant.id,
    company_id: companyId,
    account_id: accountId,
    plan,
    role,
    roles: Array.isArray(runtimeUser.roles) ? runtimeUser.roles : [],
    device_id: deviceId,
    access_mode: accessMode,
    super_admin_owner: Boolean(tenant.owner?.is_super_admin)
  }, env.runtimeJwtExpiresIn);

  const expiresAt = new Date(Date.now() + expiresInToMs(env.runtimeJwtExpiresIn));
  const session = await prisma.runtimeSession.create({
    data: {
      tenant_id: tenant.id,
      account_id: accountId,
      device_id: deviceId,
      jti,
      scope: 'RUNTIME',
      expires_at: expiresAt
    }
  });

  return { token, session, plan, role, access_mode: accessMode };
}

async function validateRuntimeSession({ jti, touch = false }) {
  const session = await prisma.runtimeSession.findUnique({
    where: { jti },
    include: {
      tenant: {
        include: {
          owner: true,
          subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 }
        }
      }
    }
  });

  if (!session || session.revoked_at || session.expires_at <= new Date()) return { valid: false };

  try {
    const latestSubscription = assertRuntimeEligible(session.tenant, { allowPrivilegedBypass: true });
    if (touch) {
      await prisma.runtimeSession.updateMany({ where: { id: session.id }, data: { last_seen_at: new Date() } });
      await maybeTouchDevice(session.device_id);
    }
    return {
      valid: true,
      session_id: session.id,
      tenant_id: session.tenant_id,
      account_id: session.account_id,
      device_id: session.device_id,
      subscription_status: latestSubscription.status,
      privileged_runtime_access: Boolean(latestSubscription.privileged_bypass)
    };
  } catch (_error) {
    return { valid: false };
  }
}

async function revokeTenantRuntimeAccess(tenantId, reason = 'tenant_access_revoked') {
  const now = new Date();
  await prisma.runtimeSession.updateMany({
    where: { tenant_id: tenantId, revoked_at: null },
    data: { revoked_at: now, revoke_reason: reason }
  });
  await prisma.device.updateMany({
    where: { tenant_id: tenantId, revoked_at: null },
    data: { is_active: false, revoked_at: now }
  });
}

async function listTenantSessions(tenantId) {
  const sessions = await getActiveRuntimeSessions(tenantId);
  return sessions.map((session) => ({
    id: session.id,
    runtime_user_id: session.runtime_user_id,
    runtime_user_email: session.runtime_user_email,
    runtime_user_name: session.runtime_user_name,
    device_id: session.device_id,
    device_name: session.device_name,
    platform: session.platform,
    issued_at: session.issued_at,
    expires_at: session.expires_at,
    last_seen_at: session.last_seen_at
  }));
}

module.exports = {
  assertRuntimeEligible,
  isPrivilegedRuntimeAccess,
  upsertRuntimeDevice,
  createRuntimeSession,
  validateRuntimeSession,
  revokeTenantRuntimeAccess,
  listTenantSessions
};
