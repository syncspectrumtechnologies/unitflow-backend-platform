const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { safeSlug } = require('../utils/security');
const { createAudit } = require('../services/auditService');
const { createNotification } = require('../services/notificationService');
const { getPlanByCode } = require('../services/planService');
const { createCheckoutPayment } = require('../services/subscriptionService');
const { env } = require('../config/env');
const { queueProvisioning, buildProvisioningVersion, kickProvisioningWorker } = require('../services/provisioningService');
const { isPrivilegedRuntimeAccess } = require('../services/runtimeAccessService');

async function assertOwner(tenantId, accountId) {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, owner_account_id: accountId },
    include: {
      owner: { select: { id: true, email: true, phone: true, name: true, email_verified_at: true, phone_verified_at: true, is_super_admin: true, runtime_access_exempt: true, status: true } },
      config: true,
      locations: true,
      sales_companies: { orderBy: { created_at: 'asc' } },
      subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 }
    }
  });
  if (!tenant) throw httpError(404, 'Tenant not found');
  return tenant;
}

async function buildUniqueSlug(rawSlug, currentTenantId = null) {
  const desiredSlug = safeSlug(rawSlug);
  if (!desiredSlug) throw httpError(400, 'A valid slug or display_name is required');

  let uniqueSlug = desiredSlug;
  let counter = 1;
  while (true) {
    const existing = await prisma.tenant.findUnique({ where: { slug: uniqueSlug } });
    if (!existing || existing.id === currentTenantId) return uniqueSlug;
    counter += 1;
    uniqueSlug = `${desiredSlug}-${counter}`;
  }
}


function trimOrNull(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function normalizeSalesCompanies({ salesCompanies, displayName, legalName, locations = [] }) {
  const firstLocationAddress = Array.isArray(locations) ? (locations.find((item) => item && item.is_active !== false)?.address || locations[0]?.address || null) : null;
  const source = Array.isArray(salesCompanies) ? salesCompanies : [];
  const normalized = [];
  const seenNames = new Set();

  const pushEntry = (item = {}, index = 0) => {
    const sameAsMainCompany = item?.same_as_main_company === true;
    const resolvedName = sameAsMainCompany ? trimOrNull(displayName) : trimOrNull(item?.name);
    if (!resolvedName) {
      throw httpError(400, sameAsMainCompany ? 'display_name is required when sales company is marked same_as_main_company' : `sales_companies[${index}].name is required`);
    }

    const dedupeKey = resolvedName.toLowerCase();
    if (seenNames.has(dedupeKey)) {
      throw httpError(409, `Duplicate sales company name: ${resolvedName}`);
    }
    seenNames.add(dedupeKey);

    normalized.push({
      name: resolvedName,
      legal_name: sameAsMainCompany ? (trimOrNull(legalName) || resolvedName) : trimOrNull(item?.legal_name),
      gstin: trimOrNull(item?.gstin),
      phone: trimOrNull(item?.phone),
      email: trimOrNull(item?.email),
      address: sameAsMainCompany ? (trimOrNull(item?.address) || trimOrNull(firstLocationAddress)) : trimOrNull(item?.address),
      state: trimOrNull(item?.state),
      state_code: trimOrNull(item?.state_code),
      is_gst_enabled: typeof item?.is_gst_enabled === 'boolean' ? item.is_gst_enabled : null,
      is_active: item?.is_active !== false,
      same_as_main_company: sameAsMainCompany
    });
  };

  source.forEach((item, index) => pushEntry(item, index));

  if (normalized.length === 0) {
    pushEntry({ same_as_main_company: true }, 0);
  }

  return normalized;
}

async function replaceTenantSalesCompanies(tx, tenantId, salesCompanies) {
  await tx.tenantSalesCompany.deleteMany({ where: { tenant_id: tenantId } });
  for (const item of salesCompanies) {
    await tx.tenantSalesCompany.create({
      data: {
        tenant_id: tenantId,
        name: item.name,
        legal_name: item.legal_name,
        gstin: item.gstin,
        phone: item.phone,
        email: item.email,
        address: item.address,
        state: item.state,
        state_code: item.state_code,
        is_gst_enabled: item.is_gst_enabled,
        is_active: item.is_active !== false,
        same_as_main_company: item.same_as_main_company === true
      }
    });
  }
}

async function findReusableTenant(accountId) {
  return prisma.tenant.findFirst({
    where: {
      owner_account_id: accountId,
      lifecycle_status: { in: ['TRIAL_PENDING', 'TRIAL_ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'] }
    },
    include: {
      subscriptions: { where: { status: { in: ['ACTIVE', 'GRACE'] } }, take: 1 },
      config: true,
      locations: true,
      sales_companies: { orderBy: { created_at: 'asc' } }
    },
    orderBy: { created_at: 'desc' }
  });
}

exports.onboardPaidTenant = async (req, res, next) => {
  try {
    const {
      display_name,
      legal_name,
      business_type,
      slug,
      branding = {},
      locations = [],
      plan_code,
      billing_cycle,
      sales_companies
    } = req.body || {};

    const privilegedOwner = Boolean(req.account.is_super_admin && req.account.runtime_access_exempt);

    if (!display_name) throw httpError(400, 'display_name is required');
    if (!Array.isArray(locations) || locations.length === 0) throw httpError(400, 'At least one location is required');
    if (!req.account.email_verified_at || !req.account.phone_verified_at) throw httpError(403, 'Email and phone verification are required before onboarding');

    let plan = null;
    let normalizedBillingCycle = null;
    if (!privilegedOwner) {
      if (!plan_code || !billing_cycle) throw httpError(400, 'plan_code and billing_cycle are required');
      if (!['SINGLE_USER', 'MULTI_USER'].includes(String(plan_code).toUpperCase())) throw httpError(400, 'plan_code must be SINGLE_USER or MULTI_USER');
      if (!['MONTHLY', 'YEARLY'].includes(String(billing_cycle).toUpperCase())) throw httpError(400, 'billing_cycle must be MONTHLY or YEARLY');
      plan = await getPlanByCode(String(plan_code).toUpperCase());
      if (!plan) throw httpError(404, 'Selected plan is not available');
      normalizedBillingCycle = String(billing_cycle).toUpperCase();
    }

    const activeTenant = await prisma.tenant.findFirst({
      where: { owner_account_id: req.account.id, lifecycle_status: { in: ['ACTIVE', 'GRACE'] } },
      include: { subscriptions: { where: { status: { in: ['ACTIVE', 'GRACE'] } }, take: 1 } }
    });
    if (activeTenant && !privilegedOwner) throw httpError(409, 'This account already has an active workspace');

    const normalizedSalesCompanies = normalizeSalesCompanies({
      salesCompanies: sales_companies,
      displayName: display_name,
      legalName: legal_name,
      locations
    });

    const reusableTenant = await findReusableTenant(req.account.id);
    const uniqueSlug = await buildUniqueSlug(slug || display_name, reusableTenant?.id || null);

    const tenant = await prisma.$transaction(async (tx) => {
      let workspace;
      const baseTenantData = {
        slug: uniqueSlug,
        display_name: String(display_name).trim(),
        legal_name: legal_name !== undefined ? String(legal_name || '').trim() || null : reusableTenant?.legal_name || null,
        business_type: business_type !== undefined ? String(business_type || '').trim() || null : reusableTenant?.business_type || null,
        onboarding_status: privilegedOwner ? 'PROVISIONING' : 'PROFILE_COMPLETED',
        lifecycle_status: privilegedOwner ? 'ACTIVE' : 'SUSPENDED',
        runtime_provision_status: privilegedOwner ? 'QUEUED' : 'PAYMENT_PENDING'
      };

      if (reusableTenant) {
        workspace = await tx.tenant.update({
          where: { id: reusableTenant.id },
          data: baseTenantData
        });

        if (reusableTenant.config) {
          await tx.tenantConfig.update({
            where: { tenant_id: reusableTenant.id },
            data: {
              theme_color: branding.theme_color || reusableTenant.config.theme_color || '#1F6FEB',
              logo_url: branding.logo_url !== undefined ? branding.logo_url : reusableTenant.config.logo_url,
              app_title: branding.app_title || reusableTenant.config.app_title || display_name,
              invoice_header: branding.invoice_header !== undefined ? branding.invoice_header : reusableTenant.config.invoice_header,
              invoice_footer: branding.invoice_footer !== undefined ? branding.invoice_footer : reusableTenant.config.invoice_footer,
              locale: branding.locale || reusableTenant.config.locale || 'en-IN',
              timezone: branding.timezone || reusableTenant.config.timezone || 'Asia/Kolkata'
            }
          });
        } else {
          await tx.tenantConfig.create({
            data: {
              tenant_id: reusableTenant.id,
              theme_color: branding.theme_color || '#1F6FEB',
              logo_url: branding.logo_url || null,
              app_title: branding.app_title || display_name,
              invoice_header: branding.invoice_header || null,
              invoice_footer: branding.invoice_footer || null,
              locale: branding.locale || 'en-IN',
              timezone: branding.timezone || 'Asia/Kolkata'
            }
          });
        }

        await tx.tenantLocation.deleteMany({ where: { tenant_id: reusableTenant.id } });
        for (const item of locations) {
          await tx.tenantLocation.create({
            data: {
              tenant_id: reusableTenant.id,
              name: item.name,
              code: item.code || null,
              address: item.address || null,
              is_active: item.is_active !== false
            }
          });
        }

        await replaceTenantSalesCompanies(tx, reusableTenant.id, normalizedSalesCompanies);

        await tx.payment.updateMany({
          where: { tenant_id: reusableTenant.id, status: 'PENDING' },
          data: { status: 'FAILED', audit_trail_json: { cancelled_at: new Date().toISOString(), reason: 'superseded_by_new_checkout' } }
        });
      } else {
        workspace = await tx.tenant.create({
          data: {
            owner_account_id: req.account.id,
            ...baseTenantData
          }
        });

        await tx.tenantConfig.create({
          data: {
            tenant_id: workspace.id,
            theme_color: branding.theme_color || '#1F6FEB',
            logo_url: branding.logo_url || null,
            app_title: branding.app_title || display_name,
            invoice_header: branding.invoice_header || null,
            invoice_footer: branding.invoice_footer || null,
            locale: branding.locale || 'en-IN',
            timezone: branding.timezone || 'Asia/Kolkata'
          }
        });

        for (const item of locations) {
          await tx.tenantLocation.create({
            data: {
              tenant_id: workspace.id,
              name: item.name,
              code: item.code || null,
              address: item.address || null,
              is_active: item.is_active !== false
            }
          });
        }

        await replaceTenantSalesCompanies(tx, workspace.id, normalizedSalesCompanies);
      }

      if (privilegedOwner) {
        return { ...workspace, payment: null };
      }

      const payment = await createCheckoutPayment(tx, {
        tenantId: workspace.id,
        accountId: req.account.id,
        plan,
        billingCycle: normalizedBillingCycle,
        currency: env.defaultCurrency,
        metadata: { source: 'self_serve_onboarding', display_name: String(display_name).trim() }
      });

      return { ...workspace, payment };
    });

    if (privilegedOwner) {
      await queueProvisioning({ tenantId: tenant.id, reason: 'super_admin_onboarding', actorType: 'ACCOUNT', actorId: req.account.id });
      kickProvisioningWorker();
      await createAudit({
        actorType: 'ACCOUNT',
        actorId: req.account.id,
        tenantId: tenant.id,
        entityType: 'tenant',
        entityId: tenant.id,
        action: 'tenant.onboarding.super_admin_created',
        metadata: { privileged_owner: true }
      });

      await createNotification({
        tenantId: tenant.id,
        accountId: req.account.id,
        type: 'tenant.provisioning.queued',
        title: 'Workspace provisioning queued',
        body: `${display_name} is being provisioned with super admin access.`
      });

      return res.status(201).json({
        ok: true,
        tenant_id: tenant.id,
        lifecycle_status: 'ACTIVE',
        runtime_provision_status: 'QUEUED',
        onboarding_status: 'PROVISIONING',
        access_mode: 'SUPER_ADMIN_BYPASS',
        payment: null
      });
    }

    await createAudit({
      actorType: 'ACCOUNT',
      actorId: req.account.id,
      tenantId: tenant.id,
      entityType: 'tenant',
      entityId: tenant.id,
      action: 'tenant.onboarding.checkout_created',
      metadata: { plan_code: plan.code, billing_cycle: normalizedBillingCycle, payment_id: tenant.payment.id }
    });

    await createNotification({
      tenantId: tenant.id,
      accountId: req.account.id,
      type: 'tenant.payment_pending',
      title: 'Complete your payment',
      body: `Your ${plan.name} ${normalizedBillingCycle.toLowerCase()} subscription checkout is ready.`
    });

    return res.status(201).json({
      ok: true,
      tenant_id: tenant.id,
      lifecycle_status: 'SUSPENDED',
      runtime_provision_status: 'PAYMENT_PENDING',
      onboarding_status: 'PROFILE_COMPLETED',
      plan_code: plan.code,
      billing_cycle: normalizedBillingCycle,
      payment: {
        id: tenant.payment.id,
        amount_minor: tenant.payment.amount_minor,
        currency: tenant.payment.currency,
        status: tenant.payment.status,
        gateway: tenant.payment.gateway
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.listMine = async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { owner_account_id: req.account.id },
      include: {
        owner: { select: { id: true, email: true, phone: true, name: true, email_verified_at: true, phone_verified_at: true, is_super_admin: true, runtime_access_exempt: true, status: true } },
        config: true,
        locations: true,
        sales_companies: { orderBy: { created_at: 'asc' } },
        subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 }
      },
      orderBy: { created_at: 'desc' }
    });

    res.json({
      ok: true,
      tenants: tenants.map((tenant) => ({
        ...tenant,
        provisioning_version: buildProvisioningVersion(tenant, tenant.subscriptions?.[0] || null),
        runtime_access_ready: ['READY', 'SYNC_PENDING'].includes(String(tenant.runtime_provision_status || '')) && (['ACTIVE', 'GRACE'].includes(tenant.lifecycle_status) || isPrivilegedRuntimeAccess(tenant))
      }))
    });
  } catch (error) { next(error); }
};

exports.getOne = async (req, res, next) => {
  try {
    const tenant = await assertOwner(req.params.tenantId, req.account.id);
    res.json({
      ok: true,
      tenant: {
        ...tenant,
        provisioning_version: buildProvisioningVersion(tenant, tenant.subscriptions?.[0] || null),
        runtime_access_ready: ['READY', 'SYNC_PENDING'].includes(String(tenant.runtime_provision_status || '')) && (['ACTIVE', 'GRACE'].includes(tenant.lifecycle_status) || isPrivilegedRuntimeAccess(tenant))
      }
    });
  } catch (error) { next(error); }
};

exports.updateConfig = async (req, res, next) => {
  try {
    const tenant = await assertOwner(req.params.tenantId, req.account.id);
    const { branding = {}, locations, sales_companies, company = {} } = req.body || {};

    const baseDisplayName = company.display_name || tenant.display_name;
    const baseLegalName = company.legal_name !== undefined ? company.legal_name : tenant.legal_name;
    const baseLocations = Array.isArray(locations) ? locations : tenant.locations;
    const existingSalesCompanies = (tenant.sales_companies || []).map((item) => ({
      name: item.name,
      legal_name: item.legal_name,
      gstin: item.gstin,
      phone: item.phone,
      email: item.email,
      address: item.address,
      state: item.state,
      state_code: item.state_code,
      is_gst_enabled: item.is_gst_enabled,
      is_active: item.is_active,
      same_as_main_company: item.same_as_main_company
    }));

    const normalizedSalesCompanies = sales_companies === undefined
      ? (existingSalesCompanies.some((item) => item.same_as_main_company === true)
          ? normalizeSalesCompanies({ salesCompanies: existingSalesCompanies, displayName: baseDisplayName, legalName: baseLegalName, locations: baseLocations })
          : null)
      : normalizeSalesCompanies({ salesCompanies: sales_companies, displayName: baseDisplayName, legalName: baseLegalName, locations: baseLocations });

    await prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id: tenant.id },
        data: {
          display_name: company.display_name || undefined,
          legal_name: company.legal_name !== undefined ? company.legal_name : undefined,
          business_type: company.business_type !== undefined ? company.business_type : undefined,
          onboarding_status: tenant.runtime_provision_status === 'READY' ? 'READY' : tenant.onboarding_status
        }
      });
      await tx.tenantConfig.update({
        where: { tenant_id: tenant.id },
        data: {
          theme_color: branding.theme_color || undefined,
          logo_url: branding.logo_url !== undefined ? branding.logo_url : undefined,
          app_title: branding.app_title || undefined,
          invoice_header: branding.invoice_header !== undefined ? branding.invoice_header : undefined,
          invoice_footer: branding.invoice_footer !== undefined ? branding.invoice_footer : undefined,
          locale: branding.locale || undefined,
          timezone: branding.timezone || undefined
        }
      });
      if (Array.isArray(locations)) {
        await tx.tenantLocation.deleteMany({ where: { tenant_id: tenant.id } });
        for (const item of locations) {
          await tx.tenantLocation.create({
            data: { tenant_id: tenant.id, name: item.name, code: item.code || null, address: item.address || null, is_active: item.is_active !== false }
          });
        }
      }
      if (normalizedSalesCompanies) {
        await replaceTenantSalesCompanies(tx, tenant.id, normalizedSalesCompanies);
      }
    });

    let queueResult = null;
    if (tenant.runtime_company_id) {
      queueResult = await queueProvisioning({ tenantId: tenant.id, reason: 'config_update', actorType: 'ACCOUNT', actorId: req.account.id });
    }

    await createAudit({ actorType: 'ACCOUNT', actorId: req.account.id, tenantId: tenant.id, entityType: 'tenant', entityId: tenant.id, action: 'tenant.config.updated', metadata: { queued_sync: Boolean(queueResult) } });
    res.json({ ok: true, synced: false, provisioning: queueResult });
  } catch (error) { next(error); }
};

exports.retryProvisioning = async (req, res, next) => {
  try {
    const tenant = await assertOwner(req.params.tenantId, req.account.id);
    const queued = await queueProvisioning({ tenantId: tenant.id, reason: 'owner_retry', actorType: 'ACCOUNT', actorId: req.account.id });
    res.json({ ok: true, ...queued });
  } catch (error) { next(error); }
};
