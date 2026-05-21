# UnitFlow Platform API

SaaS control-plane service for UnitFlow.

Current onboarding model:
- account signup and verification
- self-serve paid onboarding
- plan selection: `SINGLE_USER` or `MULTI_USER`
- billing cycle selection: `MONTHLY` or `YEARLY`
- payment completion before runtime activation
- Platform-issued runtime JWT after paid activation

## Azure Deployment Notes

- Set `PLATFORM_DATABASE_URL`, `JWT_SECRET`, `OPS_JWT_SECRET`, `PLATFORM_RUNTIME_JWT_SECRET`, `CORE_API_BASE_URL`, and `PLATFORM_INTERNAL_API_KEY` in Azure App Service Application Settings.
- `PLATFORM_INTERNAL_API_KEY` and `PLATFORM_RUNTIME_JWT_SECRET` must match the corresponding values configured in the core API App Service.
- Prisma client generation now runs during install, before `npm start`, and again at boot if the generated client is missing from the deployment artifact.
