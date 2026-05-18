# UnitFlow Phase 3 Platform Architecture

This service is the SaaS control plane for UnitFlow.

## Responsibilities
- accounts and verification
- self-serve trial creation
- tenant/org metadata and branding
- subscription plans and payments
- release metadata for Windows/Mac installers
- ops/admin tenant lifecycle management
- runtime provisioning into the separate UnitFlow core API

## Integration contract with core API
The platform calls the core internal endpoints using the shared `PLATFORM_INTERNAL_API_KEY`:
- `POST /internal/platform/tenants/provision`
- `PUT /internal/platform/tenants/:tenantId/status`
- `PUT /internal/platform/tenants/:tenantId/config`
