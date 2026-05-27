-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('FIXED_AMOUNT', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "CouponRedemptionStatus" AS ENUM ('APPLIED', 'CONSUMED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ReferralRewardStatus" AS ENUM ('PENDING', 'APPROVED', 'REVERSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CreditLedgerDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "CreditLedgerType" AS ENUM ('REFERRAL_REWARD', 'COUPON_REDEMPTION', 'MANUAL_ADJUSTMENT');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "lifetime_referral_earnings_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "referral_code" TEXT,
ADD COLUMN     "referral_credit_balance_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "referred_at" TIMESTAMP(3),
ADD COLUMN     "referred_by_account_id" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "checkout_payload_json" JSONB,
ADD COLUMN     "coupon_id" TEXT,
ADD COLUMN     "discount_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "gateway_mode" TEXT,
ADD COLUMN     "gateway_request_id" TEXT,
ADD COLUMN     "gateway_status" TEXT,
ADD COLUMN     "original_amount_minor" INTEGER;

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "discount_type" "CouponDiscountType" NOT NULL,
    "amount_minor" INTEGER,
    "percentage_off" DECIMAL(5,2),
    "max_discount_minor" INTEGER,
    "min_amount_minor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "usage_limit" INTEGER,
    "per_account_limit" INTEGER NOT NULL DEFAULT 1,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "first_payment_only" BOOLEAN NOT NULL DEFAULT true,
    "is_referral_reward" BOOLEAN NOT NULL DEFAULT false,
    "applies_to_plan_codes" JSONB,
    "active_from" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata_json" JSONB,
    "created_by_account_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL,
    "coupon_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "payment_id" TEXT,
    "status" "CouponRedemptionStatus" NOT NULL DEFAULT 'APPLIED',
    "discount_minor" INTEGER NOT NULL,
    "metadata_json" JSONB,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),
    "reversed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralReward" (
    "id" TEXT NOT NULL,
    "referrer_account_id" TEXT NOT NULL,
    "referred_account_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "payment_id" TEXT,
    "reward_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "ReferralRewardStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "metadata_json" JSONB,
    "approved_at" TIMESTAMP(3),
    "reversed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountCreditLedger" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "direction" "CreditLedgerDirection" NOT NULL,
    "entry_type" "CreditLedgerType" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "balance_after_minor" INTEGER NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountCreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX "Coupon_is_active_expires_at_idx" ON "Coupon"("is_active", "expires_at");

-- CreateIndex
CREATE INDEX "Coupon_created_by_account_id_idx" ON "Coupon"("created_by_account_id");

-- CreateIndex
CREATE INDEX "CouponRedemption_coupon_id_status_idx" ON "CouponRedemption"("coupon_id", "status");

-- CreateIndex
CREATE INDEX "CouponRedemption_account_id_status_idx" ON "CouponRedemption"("account_id", "status");

-- CreateIndex
CREATE INDEX "CouponRedemption_tenant_id_status_idx" ON "CouponRedemption"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "CouponRedemption_payment_id_idx" ON "CouponRedemption"("payment_id");

-- CreateIndex
CREATE INDEX "ReferralReward_referrer_account_id_status_idx" ON "ReferralReward"("referrer_account_id", "status");

-- CreateIndex
CREATE INDEX "ReferralReward_referred_account_id_status_idx" ON "ReferralReward"("referred_account_id", "status");

-- CreateIndex
CREATE INDEX "ReferralReward_tenant_id_status_idx" ON "ReferralReward"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralReward_referred_account_id_payment_id_key" ON "ReferralReward"("referred_account_id", "payment_id");

-- CreateIndex
CREATE INDEX "AccountCreditLedger_account_id_created_at_idx" ON "AccountCreditLedger"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "AccountCreditLedger_reference_type_reference_id_idx" ON "AccountCreditLedger"("reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "Account_referral_code_key" ON "Account"("referral_code");

-- CreateIndex
CREATE INDEX "Account_referred_by_account_id_idx" ON "Account"("referred_by_account_id");

-- CreateIndex
CREATE INDEX "Payment_coupon_id_idx" ON "Payment"("coupon_id");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_referred_by_account_id_fkey" FOREIGN KEY ("referred_by_account_id") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_created_by_account_id_fkey" FOREIGN KEY ("created_by_account_id") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_referrer_account_id_fkey" FOREIGN KEY ("referrer_account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_referred_account_id_fkey" FOREIGN KEY ("referred_account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountCreditLedger" ADD CONSTRAINT "AccountCreditLedger_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

