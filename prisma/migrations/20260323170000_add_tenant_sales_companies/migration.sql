CREATE TABLE IF NOT EXISTS "TenantSalesCompany" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "legal_name" TEXT,
  "gstin" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "address" TEXT,
  "state" TEXT,
  "state_code" TEXT,
  "is_gst_enabled" BOOLEAN,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "same_as_main_company" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantSalesCompany_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantSalesCompany_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantSalesCompany_tenant_id_name_key" ON "TenantSalesCompany"("tenant_id", "name");
CREATE INDEX IF NOT EXISTS "TenantSalesCompany_tenant_id_is_active_idx" ON "TenantSalesCompany"("tenant_id", "is_active");
