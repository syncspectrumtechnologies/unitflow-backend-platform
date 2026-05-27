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
const { prepareCheckoutResponse, finalizeSuccessfulPayment } = require('../services/checkoutService');
const { isZeroAmountCheckout, resolveGatewayMode } = require('../services/paymentGatewayService');
const { getReferralDashboard } = require('../services/referralService');
const { listAccountCoupons } = require('../services/couponService');

async function assertOwner(tenantId, accountId) {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, owner_account_id: accountId },
    include: {
      owner: { select: { id: true, email: true, phone: true, name: true, email_verified_at: true, phone_verified_at: true, is_super_admin: true, runtime_access_exempt: true, status: true } },
      config: true,
      locations: true,
      sales_companies: { orderBy: { created_at: 'asc' } },
      subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 },
      payments: { orderBy: { created_at: 'desc' }, take: 5 }
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

function defaultDisplayNameForAccount(account) {
  const baseName = trimOrNull(account?.name) || trimOrNull(account?.email) || 'UnitFlow Workspace';
  return baseName.includes('Workspace') ? baseName : `${baseName} Workspace`;
}

function buildCodeFromName(value, fallback = 'MAIN') {
  const letters = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => part.slice(0, 1))
    .join('');
  return letters || fallback;
}

function trimOrNull(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function normalizeLocations(locations, displayName, fallbackLocations = []) {
  const source = Array.isArray(locations)
    ? locations
    : (Array.isArray(fallbackLocations) ? fallbackLocations : []);

  const normalized = source
    .map((item, index) => ({
      name: trimOrNull(item?.name) || (index === 0 ? `${displayName} Main Unit` : null),
      code: trimOrNull(item?.code) || buildCodeFromName(item?.name || displayName || 'MAIN'),
      address: trimOrNull(item?.address),
      is_active: item?.is_active !== false
    }))
    .filter((item) => item.name);

  if (normalized.length === 0) {
    normalized.push({
      name: `${displayName} Main Unit`,
      code: buildCodeFromName(displayName || 'MAIN'),
      address: null,
      is_active: true
    });
  }

  return normalized;
}

function buildOnboardingSuggestions({ account, displayName, legalName, slug, branding = {}, locations = [], salesCompanies = [] }) {
  const resolvedDisplayName = trimOrNull(displayName) || defaultDisplayNameForAccount(account);
  const normalizedLocations = normalizeLocations(locations, resolvedDisplayName);
  const suggestedSalesCompanies = normalizeSalesCompanies({
    salesCompanies,
    displayName: resolvedDisplayName,
    legalName: legalName || resolvedDisplayName,
    locations: normalizedLocations
  });

  return {
    display_name: resolvedDisplayName,
    slug: safeSlug(slug || resolvedDisplayName),
    branding: {
      theme_color: branding.theme_color || '#1F6FEB',
      app_title: branding.app_title || resolvedDisplayName,
      logo_url: branding.logo_url || null,
      invoice_header: branding.invoice_header || null,
      invoice_footer: branding.invoice_footer || null,
      locale: branding.locale || 'en-IN',
      timezone: branding.timezone || 'Asia/Kolkata'
    },
    locations: normalizedLocations,
    sales_companies: suggestedSalesCompanies
  };
}

function buildOnboardingSteps(tenant) {
  const latestSubscription = tenant?.subscriptions?.[0] || null;
  const steps = [
    {
      key: 'workspace',
      label: 'Workspace basics',
      completed: Boolean(trimOrNull(tenant?.display_name) && trimOrNull(tenant?.slug))
    },
    {
      key: 'verification',
      label: 'Owner verification',
      completed: Boolean(tenant?.owner?.email_verified_at && tenant?.owner?.phone_verified_at)
    },
    {
      key: 'branding',
      label: 'Branding',
      completed: Boolean(tenant?.config?.app_title || tenant?.config?.theme_color)
    },
    {
      key: 'locations',
      label: 'Locations',
      completed: Array.isArray(tenant?.locations) && tenant.locations.length > 0
    },
    {
      key: 'billing',
      label: 'Plan and billing',
      completed: Boolean(latestSubscription || tenant?.runtime_provision_status === 'PAYMENT_PENDING' || tenant?.payments?.length)
    },
    {
      key: 'ready',
      label: 'Provisioning',
      completed: tenant?.runtime_provision_status === 'READY'
    }
  ];

  const completedCount = steps.filter((step) => step.completed).length;
  return {
    steps,
    completed_count: completedCount,
    total_count: steps.length,
    percent_complete: Math.round((completedCount / steps.length) * 100)
  };
}

async function replaceTenantLocations(tx, tenantId, locations) {
  await tx.tenantLocation.deleteMany({ where: { tenant_id: tenantId } });
  for (const item of locations) {
    await tx.tenantLocation.create({
      data: {
        tenant_id: tenantId,
        name: item.name,
        code: item.code || null,
        address: item.address || null,
        is_active: item.is_active !== false
      }
    });
  }
}

function serializeTenant(tenant) {
  return {
    ...tenant,
    provisioning_version: buildProvisioningVersion(tenant, tenant.subscriptions?.[0] || null),
    runtime_access_ready: ['READY', 'SYNC_PENDING'].includes(String(tenant.runtime_provision_status || ''))
      && (['ACTIVE', 'GRACE'].includes(tenant.lifecycle_status) || isPrivilegedRuntimeAccess(tenant)),
    onboarding: buildOnboardingSteps(tenant)
  };
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
      tenant_id,
      display_name,
      legal_name,
      business_type,
      slug,
      branding = {},
      locations,
      plan_code,
      billing_cycle,
      sales_companies,
      coupon_code,
      gateway_mode
    } = req.body || {};

    const privilegedOwner = Boolean(req.account.is_super_admin && req.account.runtime_access_exempt);
    if (!req.account.email_verified_at || !req.account.phone_verified_at) throw httpError(403, 'Email and phone verification are required before onboarding');

    const requestedTenant = tenant_id ? await assertOwner(tenant_id, req.account.id) : null;
    const reusableTenant = requestedTenant || await findReusableTenant(req.account.id);

    const effectiveDisplayName = trimOrNull(display_name)
      || trimOrNull(reusableTenant?.display_name)
      || defaultDisplayNameForAccount(req.account);
    const suggested = buildOnboardingSuggestions({
      account: req.account,
      displayName: effectiveDisplayName,
      legalName: legal_name !== undefined ? legal_name : reusableTenant?.legal_name,
      slug: slug || reusableTenant?.slug,
      branding: {
        ...(reusableTenant?.config || {}),
        ...(branding || {})
      },
      locations: Array.isArray(locations) ? locations : reusableTenant?.locations,
      salesCompanies: sales_companies === undefined
        ? ((reusableTenant?.sales_companies || []).map((item) => ({
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
          })))
        : sales_companies
    });
    const normalizedLocations = suggested.locations;
    const normalizedSalesCompanies = suggested.sales_companies;

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
    if (activeTenant && !privilegedOwner && activeTenant.id !== reusableTenant?.id) {
      throw httpError(409, 'This account already has an active workspace');
    }

    const uniqueSlug = await buildUniqueSlug(slug || suggested.slug || effectiveDisplayName, reusableTenant?.id || null);

    const tenant = await prisma.$transaction(async (tx) => {
      let workspace;
      const baseTenantData = {
        slug: uniqueSlug,
        display_name: effectiveDisplayName,
        legal_name: legal_name !== undefined ? trimOrNull(legal_name) : reusableTenant?.legal_name || null,
        business_type: business_type !== undefined ? trimOrNull(business_type) : reusableTenant?.business_type || null,
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
              theme_color: suggested.branding.theme_color,
              logo_url: suggested.branding.logo_url,
              app_title: suggested.branding.app_title,
              invoice_header: suggested.branding.invoice_header,
              invoice_footer: suggested.branding.invoice_footer,
              locale: suggested.branding.locale,
              timezone: suggested.branding.timezone
            }
          });
        } else {
          await tx.tenantConfig.create({
            data: {
              tenant_id: reusableTenant.id,
              theme_color: suggested.branding.theme_color,
              logo_url: suggested.branding.logo_url,
              app_title: suggested.branding.app_title,
              invoice_header: suggested.branding.invoice_header,
              invoice_footer: suggested.branding.invoice_footer,
              locale: suggested.branding.locale,
              timezone: suggested.branding.timezone
            }
          });
        }

        await replaceTenantLocations(tx, reusableTenant.id, normalizedLocations);
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
            theme_color: suggested.branding.theme_color,
            logo_url: suggested.branding.logo_url,
            app_title: suggested.branding.app_title,
            invoice_header: suggested.branding.invoice_header,
            invoice_footer: suggested.branding.invoice_footer,
            locale: suggested.branding.locale,
            timezone: suggested.branding.timezone
          }
        });

        await replaceTenantLocations(tx, workspace.id, normalizedLocations);
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
        metadata: { source: 'self_serve_onboarding', display_name: effectiveDisplayName },
        couponCode: coupon_code,
        gatewayMode: resolveGatewayMode(gateway_mode)
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
        body: `${effectiveDisplayName} is being provisioned with super admin access.`
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

    const hydratedTenant = await assertOwner(tenant.id, req.account.id);
    const { payment: preparedPayment, checkout } = await prepareCheckoutResponse({
      payment: tenant.payment,
      tenant: hydratedTenant,
      account: req.account,
      gatewayMode: gateway_mode
    });

    if (isZeroAmountCheckout(preparedPayment)) {
      const succeededPayment = await prisma.payment.update({
        where: { id: preparedPayment.id },
        data: {
          status: 'SUCCEEDED',
          paid_at: new Date(),
          gateway_status: 'SUCCEEDED'
        }
      });
      const subscription = await finalizeSuccessfulPayment({
        tenant: hydratedTenant,
        plan,
        billingCycle: normalizedBillingCycle,
        payment: succeededPayment,
        metadata: { zero_amount_checkout: true, source: 'self_serve_onboarding' }
      });

      return res.status(201).json({
        ok: true,
        tenant_id: tenant.id,
        lifecycle_status: 'SUSPENDED',
        runtime_provision_status: 'PAYMENT_PENDING',
        onboarding_status: 'PROFILE_COMPLETED',
        plan_code: plan.code,
        billing_cycle: normalizedBillingCycle,
        payment: succeededPayment,
        checkout,
        auto_activated: true,
        subscription_id: subscription.id
      });
    }

    return res.status(201).json({
      ok: true,
      tenant_id: tenant.id,
      lifecycle_status: 'SUSPENDED',
      runtime_provision_status: 'PAYMENT_PENDING',
      onboarding_status: 'PROFILE_COMPLETED',
      plan_code: plan.code,
      billing_cycle: normalizedBillingCycle,
      payment: {
        id: preparedPayment.id,
        amount_minor: preparedPayment.amount_minor,
        original_amount_minor: preparedPayment.original_amount_minor,
        discount_minor: preparedPayment.discount_minor,
        currency: preparedPayment.currency,
        status: preparedPayment.status,
        gateway: preparedPayment.gateway,
        gateway_mode: preparedPayment.gateway_mode
      },
      checkout
    });
  } catch (error) {
    next(error);
  }
};

exports.saveOnboardingDraft = async (req, res, next) => {
  try {
    const { tenant_id, display_name, legal_name, business_type, slug, branding = {}, locations, sales_companies } = req.body || {};
    const existingTenant = tenant_id ? await assertOwner(tenant_id, req.account.id) : await findReusableTenant(req.account.id);
    const effectiveDisplayName = trimOrNull(display_name)
      || trimOrNull(existingTenant?.display_name)
      || defaultDisplayNameForAccount(req.account);
    const suggested = buildOnboardingSuggestions({
      account: req.account,
      displayName: effectiveDisplayName,
      legalName: legal_name !== undefined ? legal_name : existingTenant?.legal_name,
      slug: slug || existingTenant?.slug,
      branding: {
        ...(existingTenant?.config || {}),
        ...(branding || {})
      },
      locations: Array.isArray(locations) ? locations : existingTenant?.locations,
      salesCompanies: sales_companies === undefined
        ? ((existingTenant?.sales_companies || []).map((item) => ({
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
          })))
        : sales_companies
    });
    const uniqueSlug = await buildUniqueSlug(slug || suggested.slug || effectiveDisplayName, existingTenant?.id || null);

    const saved = await prisma.$transaction(async (tx) => {
      let workspace = existingTenant;
      if (workspace) {
        workspace = await tx.tenant.update({
          where: { id: workspace.id },
          data: {
            slug: uniqueSlug,
            display_name: effectiveDisplayName,
            legal_name: legal_name !== undefined ? trimOrNull(legal_name) : workspace.legal_name,
            business_type: business_type !== undefined ? trimOrNull(business_type) : workspace.business_type,
            onboarding_status: 'DRAFT',
            lifecycle_status: workspace.lifecycle_status === 'ACTIVE' ? workspace.lifecycle_status : 'TRIAL_PENDING',
            runtime_provision_status: workspace.runtime_company_id ? workspace.runtime_provision_status : 'DRAFT'
          }
        });
      } else {
        workspace = await tx.tenant.create({
          data: {
            owner_account_id: req.account.id,
            slug: uniqueSlug,
            display_name: effectiveDisplayName,
            legal_name: trimOrNull(legal_name),
            business_type: trimOrNull(business_type),
            onboarding_status: 'DRAFT',
            lifecycle_status: 'TRIAL_PENDING',
            runtime_provision_status: 'DRAFT'
          }
        });
      }

      await tx.tenantConfig.upsert({
        where: { tenant_id: workspace.id },
        update: {
          theme_color: suggested.branding.theme_color,
          logo_url: suggested.branding.logo_url,
          app_title: suggested.branding.app_title,
          invoice_header: suggested.branding.invoice_header,
          invoice_footer: suggested.branding.invoice_footer,
          locale: suggested.branding.locale,
          timezone: suggested.branding.timezone
        },
        create: {
          tenant_id: workspace.id,
          theme_color: suggested.branding.theme_color,
          logo_url: suggested.branding.logo_url,
          app_title: suggested.branding.app_title,
          invoice_header: suggested.branding.invoice_header,
          invoice_footer: suggested.branding.invoice_footer,
          locale: suggested.branding.locale,
          timezone: suggested.branding.timezone
        }
      });

      await replaceTenantLocations(tx, workspace.id, suggested.locations);
      await replaceTenantSalesCompanies(tx, workspace.id, suggested.sales_companies);
      return workspace;
    });

    await createAudit({
      actorType: 'ACCOUNT',
      actorId: req.account.id,
      tenantId: saved.id,
      entityType: 'tenant',
      entityId: saved.id,
      action: 'tenant.onboarding.draft_saved'
    });

    const tenant = await assertOwner(saved.id, req.account.id);
    return res.status(existingTenant ? 200 : 201).json({
      ok: true,
      tenant: serializeTenant(tenant),
      suggestions: {
        slug: uniqueSlug,
        branding: suggested.branding,
        locations: suggested.locations,
        sales_companies: suggested.sales_companies
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.getDashboard = async (req, res, next) => {
  try {
    const tenant = await assertOwner(req.params.tenantId, req.account.id);
    const [payments, paymentSummary, notifications, runtimeSessions, referral, coupons] = await Promise.all([
      prisma.payment.findMany({
        where: { tenant_id: tenant.id },
        include: {
          coupon: {
            select: { id: true, code: true, name: true, discount_type: true }
          }
        },
        orderBy: { created_at: 'desc' },
        take: 20
      }),
      prisma.payment.groupBy({
        by: ['status'],
        where: { tenant_id: tenant.id },
        _count: { id: true },
        _sum: { amount_minor: true, discount_minor: true }
      }),
      prisma.platformNotification.findMany({
        where: {
          OR: [
            { tenant_id: tenant.id },
            { account_id: req.account.id }
          ]
        },
        orderBy: { created_at: 'desc' },
        take: 20
      }),
      prisma.runtimeSession.findMany({
        where: {
          tenant_id: tenant.id,
          revoked_at: null,
          expires_at: { gt: new Date() }
        },
        orderBy: { created_at: 'desc' }
      }),
      getReferralDashboard(req.account.id),
      listAccountCoupons(req.account.id)
    ]);

    const latestSubscription = tenant.subscriptions?.[0] || null;
    return res.json({
      ok: true,
      dashboard: {
        tenant: serializeTenant(tenant),
        account: {
          id: req.account.id,
          name: req.account.name,
          email: req.account.email,
          phone: req.account.phone,
          email_verified_at: req.account.email_verified_at,
          phone_verified_at: req.account.phone_verified_at,
          referral_credit_balance_minor: referral.credit_balance_minor,
          lifetime_referral_earnings_minor: referral.lifetime_earnings_minor
        },
        subscription: latestSubscription ? {
          id: latestSubscription.id,
          status: latestSubscription.status,
          billing_cycle: latestSubscription.billing_cycle,
          seat_limit: latestSubscription.seat_limit,
          started_at: latestSubscription.started_at,
          renews_at: latestSubscription.renews_at,
          ends_at: latestSubscription.ends_at,
          grace_until: latestSubscription.grace_until,
          plan: latestSubscription.plan
        } : null,
        billing: {
          plan_details: latestSubscription?.plan || null,
          payment_summary: paymentSummary,
          payments,
          pending_payment: payments.find((payment) => payment.status === 'PENDING') || null,
          latest_successful_payment: payments.find((payment) => payment.status === 'SUCCEEDED') || null
        },
        runtime: {
          device_count: tenant.devices?.length || 0,
          active_session_count: runtimeSessions.length,
          active_sessions: runtimeSessions
        },
        referrals: referral,
        coupons,
        notifications
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.getReferralPage = async (req, res, next) => {
  try {
    await assertOwner(req.params.tenantId, req.account.id);
    const [referral, coupons] = await Promise.all([
      getReferralDashboard(req.account.id),
      listAccountCoupons(req.account.id)
    ]);

    res.json({
      ok: true,
      referral,
      coupons
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
        subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 },
        payments: { orderBy: { created_at: 'desc' }, take: 5 }
      },
      orderBy: { created_at: 'desc' }
    });

    res.json({
      ok: true,
      tenants: tenants.map((tenant) => serializeTenant(tenant))
    });
  } catch (error) { next(error); }
};

exports.getOne = async (req, res, next) => {
  try {
    const tenant = await assertOwner(req.params.tenantId, req.account.id);
    res.json({
      ok: true,
      tenant: serializeTenant(tenant)
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
