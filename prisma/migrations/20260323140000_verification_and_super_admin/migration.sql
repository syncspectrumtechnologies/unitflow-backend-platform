ALTER TABLE "Account"
  ADD COLUMN IF NOT EXISTS "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "runtime_access_exempt" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Account_status_is_super_admin_idx" ON "Account"("status", "is_super_admin");
