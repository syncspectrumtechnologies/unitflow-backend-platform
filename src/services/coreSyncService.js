const axios = require('axios');
const { env } = require('../config/env');
const logger = require('../utils/logger');

function withRemoteErrorContext(error, fallbackMessage) {
  const remoteMessage =
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.response?.data?.details ||
    error?.message ||
    fallbackMessage;

  const wrapped = new Error(remoteMessage || fallbackMessage);
  wrapped.status = error?.response?.status || 502;
  wrapped.remote = error?.response?.data || null;
  wrapped.cause = error;
  return wrapped;
}

function client() {
  return axios.create({
    baseURL: env.coreApiBaseUrl,
    timeout: 15000,
    headers: {
      'X-Platform-Api-Key': env.platformInternalApiKey,
      'Content-Type': 'application/json'
    }
  });
}

async function provisionTenant(payload) {
  logger.info('Provisioning tenant in core runtime', { tenant_id: payload.tenant_id });
  try {
    const res = await client().post('/internal/platform/tenants/provision', payload);
    return res.data;
  } catch (error) {
    throw withRemoteErrorContext(error, 'Core tenant provisioning failed');
  }
}

async function syncTenantStatus(tenantId, payload) {
  try {
    const res = await client().put(`/internal/platform/tenants/${tenantId}/status`, payload);
    return res.data;
  } catch (error) {
    throw withRemoteErrorContext(error, 'Core tenant status sync failed');
  }
}

async function syncTenantConfig(tenantId, payload) {
  try {
    const res = await client().put(`/internal/platform/tenants/${tenantId}/config`, payload);
    return res.data;
  } catch (error) {
    throw withRemoteErrorContext(error, 'Core tenant config sync failed');
  }
}

async function authenticateRuntimeUser(payload) {
  try {
    const res = await client().post('/internal/platform/runtime/authenticate', payload);
    return res.data;
  } catch (error) {
    throw withRemoteErrorContext(error, 'Core runtime authentication failed');
  }
}

async function listRuntimeUsers(tenantId, params = {}) {
  try {
    const res = await client().get(`/internal/platform/tenants/${tenantId}/users`, { params });
    return res.data;
  } catch (error) {
    throw withRemoteErrorContext(error, 'Core runtime users fetch failed');
  }
}

async function createRuntimeUser(tenantId, payload) {
  try {
    const res = await client().post(`/internal/platform/tenants/${tenantId}/users`, payload);
    return res.data;
  } catch (error) {
    throw withRemoteErrorContext(error, 'Core runtime user creation failed');
  }
}

async function listRuntimeRoles(tenantId, params = {}) {
  try {
    const res = await client().get(`/internal/platform/tenants/${tenantId}/roles`, { params });
    return res.data;
  } catch (error) {
    throw withRemoteErrorContext(error, 'Core runtime roles fetch failed');
  }
}

async function createRuntimeRole(tenantId, payload) {
  try {
    const res = await client().post(`/internal/platform/tenants/${tenantId}/roles`, payload);
    return res.data;
  } catch (error) {
    throw withRemoteErrorContext(error, 'Core runtime role creation failed');
  }
}

async function assignRuntimeUserRole(tenantId, userId, payload) {
  try {
    const res = await client().post(`/internal/platform/tenants/${tenantId}/users/${userId}/roles`, payload);
    return res.data;
  } catch (error) {
    throw withRemoteErrorContext(error, 'Core runtime role assignment failed');
  }
}

async function listRuntimePermissions(tenantId) {
  try {
    const res = await client().get(`/internal/platform/tenants/${tenantId}/permissions`);
    return res.data;
  } catch (error) {
    throw withRemoteErrorContext(error, 'Core runtime permissions fetch failed');
  }
}

async function attachRuntimeRolePermissions(tenantId, roleId, payload) {
  try {
    const res = await client().post(`/internal/platform/tenants/${tenantId}/roles/${roleId}/permissions`, payload);
    return res.data;
  } catch (error) {
    throw withRemoteErrorContext(error, 'Core runtime permission assignment failed');
  }
}

module.exports = {
  provisionTenant,
  syncTenantStatus,
  syncTenantConfig,
  authenticateRuntimeUser,
  listRuntimeUsers,
  createRuntimeUser,
  listRuntimeRoles,
  createRuntimeRole,
  assignRuntimeUserRole,
  listRuntimePermissions,
  attachRuntimeRolePermissions
};
