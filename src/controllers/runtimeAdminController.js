const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const coreSync = require('../services/coreSyncService');

const LOGIN_ID_PATTERN = /^[a-zA-Z0-9._-]{3,40}$/;

function text(value, max = 160) {
  const out = String(value ?? '').trim();
  return out ? out.slice(0, max) : '';
}

async function getOwnedRuntimeTenant(accountId, tenantId) {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, owner_account_id: accountId },
    select: { id: true, runtime_company_id: true, runtime_owner_user_id: true, runtime_provision_status: true }
  });
  if (!tenant) throw httpError(404, 'Tenant not found');
  if (!tenant.runtime_company_id) throw httpError(409, 'Runtime is not provisioned yet');
  return tenant;
}

function coreTenantId(tenant) {
  return tenant.runtime_company_id || tenant.id;
}

function actorPayload(tenant, payload = {}) {
  return { ...payload, actor_user_id: tenant.runtime_owner_user_id || undefined };
}

exports.listUsers = async (req, res, next) => {
  try {
    const tenant = await getOwnedRuntimeTenant(req.account.id, req.params.tenantId);
    const data = await coreSync.listRuntimeUsers(coreTenantId(tenant), {
      page_size: req.query.page_size || 100,
      actor_user_id: tenant.runtime_owner_user_id || undefined
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
};

exports.createUser = async (req, res, next) => {
  try {
    const tenant = await getOwnedRuntimeTenant(req.account.id, req.params.tenantId);
    const payload = {
      name: text(req.body?.name, 120),
      login_id: text(req.body?.login_id, 40).toLowerCase(),
      password: String(req.body?.password || ''),
      is_admin: req.body?.is_admin === true
    };
    if (!payload.name) throw httpError(400, 'name is required');
    if (!LOGIN_ID_PATTERN.test(payload.login_id)) throw httpError(400, 'login_id is invalid');
    if (payload.password.length < 8 || payload.password.length > 128) throw httpError(400, 'password must be between 8 and 128 characters');
    const data = await coreSync.createRuntimeUser(coreTenantId(tenant), actorPayload(tenant, payload));
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

exports.listRoles = async (req, res, next) => {
  try {
    const tenant = await getOwnedRuntimeTenant(req.account.id, req.params.tenantId);
    const data = await coreSync.listRuntimeRoles(coreTenantId(tenant), { actor_user_id: tenant.runtime_owner_user_id || undefined });
    res.json(data);
  } catch (error) {
    next(error);
  }
};

exports.createRole = async (req, res, next) => {
  try {
    const tenant = await getOwnedRuntimeTenant(req.account.id, req.params.tenantId);
    const payload = {
      name: text(req.body?.name, 80),
      description: text(req.body?.description, 240)
    };
    if (!payload.name) throw httpError(400, 'name is required');
    const data = await coreSync.createRuntimeRole(coreTenantId(tenant), actorPayload(tenant, payload));
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

exports.assignUserRole = async (req, res, next) => {
  try {
    const tenant = await getOwnedRuntimeTenant(req.account.id, req.params.tenantId);
    const roleId = text(req.body?.role_id, 128);
    if (!roleId) throw httpError(400, 'role_id is required');
    const data = await coreSync.assignRuntimeUserRole(coreTenantId(tenant), req.params.userId, actorPayload(tenant, { role_id: roleId }));
    res.json(data);
  } catch (error) {
    next(error);
  }
};

exports.listPermissions = async (req, res, next) => {
  try {
    const tenant = await getOwnedRuntimeTenant(req.account.id, req.params.tenantId);
    const data = await coreSync.listRuntimePermissions(coreTenantId(tenant));
    res.json(data);
  } catch (error) {
    next(error);
  }
};

exports.attachRolePermissions = async (req, res, next) => {
  try {
    const tenant = await getOwnedRuntimeTenant(req.account.id, req.params.tenantId);
    const permissionKeys = Array.isArray(req.body?.permission_keys)
      ? req.body.permission_keys.map((item) => text(item, 160)).filter(Boolean).slice(0, 100)
      : [];
    if (!permissionKeys.length) throw httpError(400, 'permission_keys is required');
    const data = await coreSync.attachRuntimeRolePermissions(coreTenantId(tenant), req.params.roleId, actorPayload(tenant, { permission_keys: permissionKeys }));
    res.json(data);
  } catch (error) {
    next(error);
  }
};
