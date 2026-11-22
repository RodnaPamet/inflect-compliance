---
title: Inflect Compliance for developers
# The site name alone in the tab: Starlight appends it to every page's
# title, which on this page is the site name already.
head:
  - tag: title
    content: Inflect Compliance for developers
description: Architecture, security, integration and contributor documentation for Inflect Compliance.
editUrl: https://github.com/RodnaPamet/inflect-compliance/edit/main/site/developers/index.md
---

Inflect Compliance is a multi-tenant Governance, Risk and Compliance platform. It manages controls, risks, evidence, audits and vendors across ISO 27001, ISO 42001, SOC 2, NIST CSF, NIS2, DORA and the EU AI Act.

This site is for the people who build it, run it or integrate with it. It is generated from the `docs/` folder of the [repository](https://github.com/RodnaPamet/inflect-compliance), which is the source of truth, and every page links back to the file it came from. Help for people who use the product is on the [help site](https://rodnapamet.github.io/inflect-compliance/).

## Where to start

- **New contributor:** read [Contributing](../../CONTRIBUTING.md), then the [application layer guide](../../docs/app-layer.md). Adding a provider, a tenant-scoped model or a background job? Follow the [new-subsystem checklist](../../docs/new-subsystem-checklist.md).
- **Who can do what:** the generated [roles and permissions](../../docs/reference/roles-and-permissions.md) table, the API calls behind each page in [page actions](../../docs/reference/page-actions.md), and the [refusal codes](../../docs/reference/refusal-codes.md).

### The platform

- **Tenant isolation and data protection:** [row-level security](../../docs/rls-tenant-isolation.md), [database routing](../../docs/database-routing.md), [field encryption](../../docs/epic-b-encryption.md) and the [encryption overview](../../docs/encryption-data-protection.md), and the hash-chained [audit trail](../../docs/immutable-audit-trail.md).
- **Security controls:** [tenant isolation and brute-force protection](../../docs/epic-a-security.md), [defence in depth](../../docs/epic-c-security.md), [rate limiting](../../docs/rate-limiting.md) and the nightly [DAST scan](../../docs/dast.md).
- **Sign-in and access:** [authentication](../../docs/auth.md), [enterprise SSO](../../docs/enterprise-sso.md), [MFA and sessions](../../docs/mfa-session-security.md), [roles and tenant onboarding](../../docs/epic-1-access-control.md), and [custom roles and API keys](../../docs/enterprise-identity-custom-roles-api-keys.md), including MCP keys and token exchange.
- **Identity lifecycle:** the [joiner and leaver design](../../docs/jml-joiner-design.md), [HRIS write-back](../../docs/jml-hris-write-back-design.md) and the [legacy access contract](../../docs/legacy-mcp-access-contract.md) for recertifying legacy applications.
- **Plans and entitlements:** [billing](../../docs/billing.md).

### Compliance features

- **Frameworks and mappings:** the [framework library](../../docs/framework-library-system.md) and [requirement mapping sets](../../docs/requirement-mapping-sets.md).
- **Automation and processes:** [automation events](../../docs/automation-events.md), the [processes canvas](../../docs/processes-canvas.md) and its automation mode, and [scheduled notifications](../../docs/scheduled-notification-system.md).
- **Risk and vendors:** [risk quantification](../../docs/risk-quantification.md) and [vendor monitoring](../../docs/vendor-monitoring.md).

### AI and agents

- **Agent engines:** the [agent builder and profiles](../../docs/claude-agent-sdk-design.md) and the [Tool Runner engine](../../docs/claude-tool-runner-design.md) — delegation, deferral to a person and compaction.
- **The assistant and its knowledge:** the [in-product assistant](../../docs/assistant.md) and the [knowledge store](../../docs/knowledge-store.md) behind `search_knowledge`.
- **Governing agents:** the [agent skill standard](../../docs/agent-skill-standard.md), the [harness report contract](../../docs/agent-harness-contract.md) and [scanner onboarding](../../docs/agent-harness-scanner-onboarding.md), the [auditor's procedures](../../docs/agentic-audit-procedures.md) and the [integration passport](../../docs/integration-passport.md).
- **Agent-to-agent:** the [A2A mapping](../../docs/a2a-mapping.md), including connecting two workspaces by invitation, and its [threat model](../../docs/a2a-threat-model.md).

### Integrating and operating

- **The API:** the [API consumer guide](../../docs/api-consumer-guide.md), then the [integration framework](../../docs/integration-framework.md); connectors include [SharePoint](../../docs/sharepoint.md) and [cloud posture](../../docs/aws-posture-connector.md).
- **Observability:** [logging, tracing and metrics](../../docs/observability.md).
- **Data protection questions:** [data residency](../../docs/data-residency.md), [data retention](../../docs/data-retention.md), [data subject access requests](../../docs/dsar.md) and the [sub-processor change policy](../../docs/sub-processor-change-policy.md).
- **Shipping changes:** the [change management policy](../../docs/change-management-policy.md), [testing](../../docs/testing.md) and the [UI design system](../../docs/design-system.md).

## What is not here

Deployment guides and runbooks for the production environment are deliberately not published. [How these sites are built](../../docs/docs-site.md) explains what is published and why.
