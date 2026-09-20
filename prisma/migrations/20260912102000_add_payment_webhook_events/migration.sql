CREATE TABLE "PaymentWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "event_id" TEXT,
  "event_name" TEXT,
  "signature_sha256" TEXT NOT NULL,
  "payment_id" TEXT,
  "gateway_order_ref" TEXT,
  "gateway_payment_ref" TEXT,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "summary_json" JSONB,
  "error_message" TEXT,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_signature_sha256_key"
  ON "PaymentWebhookEvent"("provider", "signature_sha256");
CREATE INDEX "PaymentWebhookEvent_provider_event_id_idx"
  ON "PaymentWebhookEvent"("provider", "event_id");
CREATE INDEX "PaymentWebhookEvent_provider_event_name_received_at_idx"
  ON "PaymentWebhookEvent"("provider", "event_name", "received_at");
CREATE INDEX "PaymentWebhookEvent_payment_id_idx"
  ON "PaymentWebhookEvent"("payment_id");

ALTER TABLE "PaymentWebhookEvent"
  ADD CONSTRAINT "PaymentWebhookEvent_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
