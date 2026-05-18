UPDATE "SubscriptionPlan"
SET "trial_days" = 0
WHERE "trial_days" IS DISTINCT FROM 0;
