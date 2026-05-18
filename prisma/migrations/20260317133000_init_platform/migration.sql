-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "VerificationChannel" AS ENUM ('EMAIL', 'PHONE');
CREATE TYPE "VerificationPurpose" AS ENUM ('SIGNUP', 'LOGIN', 'RESET');
CREATE TYPE "TenantLifecycleStatus" AS ENUM ('TRIAL_PENDING', 'TRIAL_ACTIVE', 'ACTIVE', 'GRACE', 'SUSPENDED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "OnboardingStatus" AS ENUM ('DRAFT', 'PROFILE_COMPLETED', 'PROVISIONING', 'READY');
CREATE TYPE "BillingCycle" AS ENUM ('TRIAL', 'MONTHLY', 'YEARLY');
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'GRACE', 'EXPIRED', 'CANCELLED');
CREATE TYPE "PlanType" AS ENUM ('SINGLE_USER', 'MULTI_USER');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');
CREATE TYPE "SessionScope" AS ENUM ('CONTROL_PLANE', 'RUNTIME');
CREATE TYPE "OpsRole" AS ENUM ('ADMIN', 'SUPPORT', 'FINANCE');
CREATE TYPE "ReleaseChannel" AS ENUM ('STABLE', 'BETA', 'INTERNAL');
CREATE TYPE "ReleasePlatform" AS ENUM ('WINDOWS', 'MAC');
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

CREATE TABLE "Account" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "name" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "email_verified_at" TIMESTAMP(3),
  "phone_verified_at" TIMESTAMP(3),
  "last_login_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Account_email_key" ON "Account"("email");
CREATE UNIQUE INDEX "Account_phone_key" ON "Account"("phone");
CREATE INDEX "Account_status_idx" ON "Account"("status");

CREATE TABLE "PlatformSession" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "jti" TEXT NOT NULL,
  "ip" TEXT,
  "user_agent" TEXT,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformSession_jti_key" ON "PlatformSession"("jti");
CREATE INDEX "PlatformSession_account_id_revoked_at_expires_at_idx" ON "PlatformSession"("account_id", "revoked_at", "expires_at");

CREATE TABLE "Tenant" (
  "id" TEXT NOT NULL,
  "owner_account_id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "legal_name" TEXT,
  "business_type" TEXT,
  "onboarding_status" "OnboardingStatus" NOT NULL DEFAULT 'DRAFT',
  "lifecycle_status" "TenantLifecycleStatus" NOT NULL DEFAULT 'TRIAL_PENDING',
  "runtime_company_id" TEXT,
  "runtime_provision_status" TEXT,
  "runtime_last_synced_at" TIMESTAMP(3),
  "trial_started_at" TIMESTAMP(3),
  "trial_ends_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE UNIQUE INDEX "Tenant_runtime_company_id_key" ON "Tenant"("runtime_company_id");
CREATE INDEX "Tenant_owner_account_id_idx" ON "Tenant"("owner_account_id");
CREATE INDEX "Tenant_lifecycle_status_idx" ON "Tenant"("lifecycle_status");

CREATE TABLE "TenantConfig" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "theme_color" TEXT,
  "logo_url" TEXT,
  "app_title" TEXT,
  "invoice_header" TEXT,
  "invoice_footer" TEXT,
  "locale" TEXT DEFAULT 'en-IN',
  "timezone" TEXT DEFAULT 'Asia/Kolkata',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantConfig_tenant_id_key" ON "TenantConfig"("tenant_id");

CREATE TABLE "TenantLocation" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT,
  "address" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantLocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantLocation_tenant_id_name_key" ON "TenantLocation"("tenant_id", "name");
CREATE INDEX "TenantLocation_tenant_id_is_active_idx" ON "TenantLocation"("tenant_id", "is_active");

CREATE TABLE "SubscriptionPlan" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "plan_type" "PlanType" NOT NULL,
  "seat_limit" INTEGER NOT NULL,
  "monthly_price_minor" INTEGER NOT NULL,
  "yearly_price_minor" INTEGER NOT NULL,
  "trial_days" INTEGER NOT NULL DEFAULT 14,
  "feature_limits_json" JSONB,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SubscriptionPlan_code_key" ON "SubscriptionPlan"("code");
CREATE INDEX "SubscriptionPlan_plan_type_is_active_idx" ON "SubscriptionPlan"("plan_type", "is_active");

CREATE TABLE "TenantSubscription" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "billing_cycle" "BillingCycle" NOT NULL,
  "status" "SubscriptionStatus" NOT NULL,
  "seat_limit" INTEGER NOT NULL,
  "plan_snapshot_json" JSONB,
  "started_at" TIMESTAMP(3) NOT NULL,
  "renews_at" TIMESTAMP(3),
  "ends_at" TIMESTAMP(3),
  "grace_until" TIMESTAMP(3),
  "trial_started_at" TIMESTAMP(3),
  "trial_ends_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantSubscription_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TenantSubscription_tenant_id_status_idx" ON "TenantSubscription"("tenant_id", "status");

CREATE TABLE "Payment" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "subscription_id" TEXT,
  "gateway" TEXT,
  "gateway_order_ref" TEXT,
  "gateway_payment_ref" TEXT,
  "amount_minor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "invoice_ref" TEXT,
  "receipt_url" TEXT,
  "metadata_json" JSONB,
  "audit_trail_json" JSONB,
  "paid_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Payment_tenant_id_status_idx" ON "Payment"("tenant_id", "status");
CREATE INDEX "Payment_gateway_payment_ref_idx" ON "Payment"("gateway_payment_ref");

CREATE TABLE "Device" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "device_fingerprint_hash" TEXT NOT NULL,
  "device_name" TEXT,
  "platform" TEXT,
  "os_version" TEXT,
  "app_version" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Device_tenant_id_device_fingerprint_hash_key" ON "Device"("tenant_id", "device_fingerprint_hash");
CREATE INDEX "Device_tenant_id_account_id_is_active_idx" ON "Device"("tenant_id", "account_id", "is_active");

CREATE TABLE "RuntimeSession" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "device_id" TEXT,
  "jti" TEXT NOT NULL,
  "scope" "SessionScope" NOT NULL,
  "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "revoke_reason" TEXT,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RuntimeSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RuntimeSession_jti_key" ON "RuntimeSession"("jti");
CREATE INDEX "RuntimeSession_tenant_id_account_id_revoked_at_expires_at_idx" ON "RuntimeSession"("tenant_id", "account_id", "revoked_at", "expires_at");

CREATE TABLE "Release" (
  "id" TEXT NOT NULL,
  "channel" "ReleaseChannel" NOT NULL,
  "platform" "ReleasePlatform" NOT NULL,
  "version" TEXT NOT NULL,
  "artifact_url" TEXT NOT NULL,
  "checksum_sha256" TEXT,
  "min_supported_core_version" TEXT,
  "min_supported_platform_version" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Release_platform_channel_version_key" ON "Release"("platform", "channel", "version");
CREATE INDEX "Release_platform_channel_is_active_idx" ON "Release"("platform", "channel", "is_active");

CREATE TABLE "OpsUser" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "role" "OpsRole" NOT NULL DEFAULT 'ADMIN',
  "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "last_login_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpsUser_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OpsUser_email_key" ON "OpsUser"("email");

CREATE TABLE "OpsAuditLog" (
  "id" TEXT NOT NULL,
  "actor_type" TEXT NOT NULL,
  "actor_id" TEXT,
  "tenant_id" TEXT,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "action" TEXT NOT NULL,
  "metadata_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpsAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OpsAuditLog_tenant_id_action_idx" ON "OpsAuditLog"("tenant_id", "action");
CREATE INDEX "OpsAuditLog_created_at_idx" ON "OpsAuditLog"("created_at");

CREATE TABLE "PlatformNotification" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT,
  "account_id" TEXT,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
  "payload_json" JSONB,
  "is_read" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformNotification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlatformNotification_tenant_id_is_read_idx" ON "PlatformNotification"("tenant_id", "is_read");
CREATE INDEX "PlatformNotification_account_id_is_read_idx" ON "PlatformNotification"("account_id", "is_read");

CREATE TABLE "AccountVerification" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "channel" "VerificationChannel" NOT NULL,
  "purpose" "VerificationPurpose" NOT NULL,
  "target" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountVerification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccountVerification_account_id_channel_purpose_expires_at_idx" ON "AccountVerification"("account_id", "channel", "purpose", "expires_at");
CREATE INDEX "AccountVerification_target_consumed_at_idx" ON "AccountVerification"("target", "consumed_at");

ALTER TABLE "PlatformSession" ADD CONSTRAINT "PlatformSession_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_owner_account_id_fkey" FOREIGN KEY ("owner_account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantLocation" ADD CONSTRAINT "TenantLocation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "TenantSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Device" ADD CONSTRAINT "Device_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Device" ADD CONSTRAINT "Device_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RuntimeSession" ADD CONSTRAINT "RuntimeSession_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RuntimeSession" ADD CONSTRAINT "RuntimeSession_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RuntimeSession" ADD CONSTRAINT "RuntimeSession_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OpsAuditLog" ADD CONSTRAINT "OpsAuditLog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlatformNotification" ADD CONSTRAINT "PlatformNotification_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlatformNotification" ADD CONSTRAINT "PlatformNotification_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccountVerification" ADD CONSTRAINT "AccountVerification_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
