---
title: Inflect Compliance for developers
description: Architecture, security, integration and contributor documentation for Inflect Compliance.
editUrl: https://github.com/RodnaPamet/inflect-compliance/edit/main/site/developers/index.md
---

Inflect Compliance is a multi-tenant Governance, Risk and Compliance platform. It manages controls, risks, evidence, audits and vendors across ISO 27001, ISO 42001, SOC 2, NIST CSF, NIS2, DORA and the EU AI Act.

This site is for the people who build it, run it or integrate with it. It is generated from the `docs/` folder of the [repository](https://github.com/RodnaPamet/inflect-compliance), which is the source of truth, and every page links back to the file it came from. Help for people who use the product is on the [help site](https://rodnapamet.github.io/inflect-compliance/).

## Where to start

- **New contributor:** read [Contributing](../../CONTRIBUTING.md), then the [application layer guide](../../docs/app-layer.md).
- **Adding a subsystem:** follow the [new-subsystem checklist](../../docs/new-subsystem-checklist.md).
- **Evaluating the security model:** start with [tenant isolation](../../docs/epic-a-security.md), [row-level security](../../docs/rls-tenant-isolation.md) and [field encryption](../../docs/epic-b-encryption.md).
- **Integrating with the API:** read the [API consumer guide](../../docs/api-consumer-guide.md), then the generated [refusal codes](../../docs/reference/refusal-codes.md).
- **Who can do what:** the [roles and permissions](../../docs/reference/roles-and-permissions.md) table and the API calls behind each page in [page actions](../../docs/reference/page-actions.md), both generated from the code.
- **Governing AI agents:** read the [agent skill standard](../../docs/agent-skill-standard.md) and the [integration passport](../../docs/integration-passport.md).
- **Data protection questions:** see [data residency](../../docs/data-residency.md), [data retention](../../docs/data-retention.md) and [data subject access requests](../../docs/dsar.md).

## What is not here

Deployment guides and runbooks for the production environment are deliberately not published. [How these sites are built](../../docs/docs-site.md) explains what is published and why.
