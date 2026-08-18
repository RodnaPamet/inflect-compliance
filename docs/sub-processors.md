# Sub-processors

The third-party services that process data on Inflect's behalf. This is
the **customer-facing source of truth** for "who can touch my data," and
the canonical list the [Data Processing Agreement](./data-processing-agreement-template.md)
Annex C points at. Adding or changing a sub-processor follows the
[sub-processor change policy](./sub-processor-change-policy.md).

Each entry carries a **codebase cross-reference** (file + line) so an
auditor can verify the inventory is accurate, not merely asserted.

> **Self-hosted ≠ sub-processor.** Some external-looking components are
> self-hosted by default and are NOT sub-processors unless an operator
> routes them off-box: the **OTel stack** (collector/Prometheus/Tempo/
> Grafana — see [`docs/observability/01-deployment-topology.md`](./observability/01-deployment-topology.md))
> and **ClamAV** antivirus (`CLAMAV_HOST`, an in-VPC daemon —
> `src/lib/storage/av-scan.ts`). If an operator points telemetry at a
> managed Grafana Cloud / AWS Managed Prometheus, that managed service
> becomes a sub-processor and must be added here.

## Inventory

| Name | Data shared | Purpose | Region | Retention | Operator-optional? |
|------|-------------|---------|--------|-----------|--------------------|
| AWS S3 | Encrypted evidence files; per-tenant DEK envelope | Object storage | Per deploy | Customer-controlled | No (load-bearing) |
| AWS RDS (Postgres) | Encrypted business data; user PII; AuditLog | Primary DB | Per deploy | Customer-controlled | No |
| AWS ElastiCache (Redis) | Session tokens; rate-limit counters; BullMQ job payloads (trace carrier + tenant id) | Queue / cache | Per deploy | Volatile (TTL) | No |
| AWS KMS | Encryption envelopes for data-at-rest (RDS/S3/snapshots); DR CMK | Crypto (infra) | Per deploy | Indefinite (per master-KEK rotation) | Partly (BYOK not exposed) |
| AWS Secrets Manager | Runtime secrets (master KEK, auth secrets, OAuth client secrets) | Secret storage | Per deploy | Until rotated | No |
| Google OAuth | User email, profile photo, name | Auth provider | Global | Standard | Yes (operator may disable) |
| Microsoft Entra ID | User email, profile photo, name | Auth provider | Global | Standard | Yes |
| Stripe | Tenant billing contact email; plan; payment method (held by Stripe — we do not store it) | Billing | US | Per Stripe agreement | Yes (self-hosted mode disables) |
| SMTP relay (operator-chosen) | Recipient email; message body (verification tokens, notification text — may include names + tenant slug) | Email delivery | Per operator | Per operator | No (delivery surface) |
| OpenRouter | Risk-assessment prompt text (risk titles/descriptions — business content) | AI risk suggestions | US/global | Per OpenRouter | Yes (default `stub`; off unless enabled) |
| Anthropic (Claude API) | Posture summary: aggregate metrics only (counts + percentages — no PII, no entity text). Risk suggestions: risk-assessment prompt text (risk titles/descriptions, asset names — business content) | AI posture summary; AI risk suggestions | US/global | Per Anthropic | Yes (both default `stub`; off unless enabled) |
| HaveIBeenPwned | SHA-1 prefix of a chosen password (k-anonymity; no PII) | Password breach check | Global | Volatile (no log) | No (security primitive) |
| GitHub | Repo metadata (per-tenant integration only) | Repo sync | Global | Token lifetime | Yes (per-tenant opt-in) |
| Microsoft SharePoint | Document metadata (per-tenant integration only) | Document sync | Global | Token lifetime | Yes (per-tenant opt-in) |
| Okta | Directory account metadata — email, status, MFA/admin flags (per-tenant integration only; read-only pull) | Identity posture sync | Global | Token lifetime | Yes (per-tenant opt-in) |
| Google Workspace (`google-workspace`) | Directory account metadata — email, status, 2SV/admin flags (per-tenant integration only; read-only pull) | Identity posture sync | Global | Token lifetime | Yes (per-tenant opt-in) |
| Microsoft Entra ID / Azure AD (`entra-id`) | Directory account metadata — email, status, MFA-registration/admin flags, domain federation (per-tenant integration only; read-only Graph pull; also covers on-prem AD synced via Azure AD Connect) | Identity posture sync | Global | Token lifetime | Yes (per-tenant opt-in) |
| On-prem Active Directory (`active-directory`) | Directory account metadata — sAMAccountName/UPN, email, enabled/disabled status, group membership, last-logon (per-tenant integration only; read-only LDAPS bind to the customer's own domain controller — no data leaves the customer network except the metadata pulled into Inflect) | Identity posture sync | Customer-hosted DC | Sync retention | Yes (per-tenant opt-in) |
| BambooHR (`hris`) | Employee roster metadata — name, work email, employment status, department (per-tenant integration only; read-only pull) | HRIS sync | Global | Token lifetime | Yes (per-tenant opt-in) |
| Workday (`workday`) | Employee roster metadata — name, work email, employment status, department, manager (per-tenant integration only; read-only OAuth2 pull from the customer's own Workday tenant) | HRIS sync | Customer-selected Workday data centre | Token lifetime | Yes (per-tenant opt-in) |

> **Customer-configured SSO IdPs.** A tenant may configure its own SAML
> or OIDC identity provider (`src/app/api/auth/sso/saml/*`,
> `src/app/api/auth/sso/oidc/*`). That IdP is the **customer's own**
> provider, chosen and controlled by the customer — it is not an Inflect
> sub-processor. Inflect receives the assertion/claims the customer's IdP
> sends (email, name, group memberships).

---

## Per-sub-processor detail

### AWS S3 — object storage
- **PII shared:** none directly; stores **encrypted** evidence files (envelope-encrypted with the per-tenant DEK, Epic B). Filenames/keys are tenant-scoped.
- **Legal basis:** performance of contract (GDPR Art. 6(1)(b)) — storing the customer's evidence is the service.
- **Processing instructions:** store and return objects on request; no independent use.
- **Transfer:** intra-region (bucket in the customer's chosen AWS region); no cross-border transfer unless the operator picks a non-EU region for EU data.
- **Vendor pages:** https://aws.amazon.com/compliance/data-privacy/ · https://aws.amazon.com/compliance/gdpr-center/
- **Codebase:** `src/lib/storage/s3-provider.ts` (`S3Client`, `PutObjectCommand`); env `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (`src/env.ts:139`); `infra/terraform/modules/storage/main.tf`.

### AWS RDS (Postgres) — primary database
- **PII shared:** user email, name, membership/role; business records; the hash-chained `AuditLog`. Business-content fields are encrypted at rest (Epic B); the column-level data is also protected by RLS.
- **Legal basis:** performance of contract (Art. 6(1)(b)).
- **Processing instructions:** persist and query tenant data; no independent use.
- **Transfer:** intra-region.
- **Vendor pages:** https://aws.amazon.com/rds/ · https://aws.amazon.com/compliance/gdpr-center/
- **Codebase:** env `DATABASE_URL`, `DIRECT_DATABASE_URL`, `DATABASE_READ_URL` (`src/env.ts:17`); `infra/terraform/modules/database/main.tf`.

### AWS ElastiCache (Redis) — queue / cache / rate-limit
- **PII shared:** session token rows (`ipAddress`, `userAgent`), rate-limit counters keyed by (IP, userId), BullMQ job payloads which carry the trace context + `tenantId`. Volatile (TTL-bounded), never the source of truth.
- **Legal basis:** legitimate interest (Art. 6(1)(f)) — performance + abuse protection.
- **Processing instructions:** ephemeral cache/queue; entries expire by TTL.
- **Transfer:** intra-region.
- **Vendor pages:** https://aws.amazon.com/elasticache/
- **Codebase:** env `REDIS_URL` (`src/env.ts:56`); managed-Redis fallback `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (`src/env.ts:128`); `infra/terraform/modules/redis/main.tf`.

### AWS KMS — encryption keys (infrastructure)
- **PII shared:** none — wraps encryption envelopes for data-at-rest (RDS, S3, RDS snapshots, the cross-region DR CMK). The application's master KEK (`DATA_ENCRYPTION_KEY`) is env-provided and stored in Secrets Manager, not fetched from the KMS API at request time.
- **Legal basis:** legitimate interest (Art. 6(1)(f)) — securing data at rest.
- **Processing instructions:** key custody + envelope crypto only.
- **Transfer:** intra-region (the DR CMK is a multi-region replica — see [`docs/disaster-recovery.md`](./disaster-recovery.md)).
- **Vendor pages:** https://aws.amazon.com/kms/
- **Codebase:** `infra/terraform/modules/database/main.tf`, `infra/terraform/modules/storage/main.tf` (encryption at rest); app-layer envelope crypto in [`docs/encryption-data-protection.md`](./encryption-data-protection.md).

### AWS Secrets Manager — runtime secrets (infrastructure)
- **PII shared:** none — holds the master KEK, auth secrets, and OAuth client secrets.
- **Legal basis:** legitimate interest (Art. 6(1)(f)).
- **Processing instructions:** secret storage + retrieval at deploy/boot.
- **Transfer:** intra-region.
- **Vendor pages:** https://aws.amazon.com/secrets-manager/
- **Codebase:** `infra/terraform/modules/secrets/main.tf`.

### Google OAuth — authentication
- **PII shared:** user email, profile photo URL, display name (returned by Google on sign-in).
- **Legal basis:** consent (Art. 6(1)(a)) at sign-in + performance of contract.
- **Processing instructions:** authenticate the user; return profile claims.
- **Transfer:** Google is global; covered by Google's SCCs for EU→US.
- **Vendor pages:** https://policies.google.com/privacy · https://cloud.google.com/terms/data-processing-addendum
- **Codebase:** `src/auth.ts:251` (`Google({...})`); env `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (`src/env.ts:113`).

### Microsoft Entra ID — authentication
- **PII shared:** user email, profile photo, display name.
- **Legal basis:** consent + performance of contract.
- **Processing instructions:** authenticate; return profile claims.
- **Transfer:** Microsoft global; covered by the Microsoft DPA SCCs.
- **Vendor pages:** https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA
- **Codebase:** `src/auth.ts:262` (`AzureAD({...})`); env `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` (`src/env.ts:115`).

### Stripe — billing (SaaS mode only)
- **PII shared:** tenant billing-contact email; plan; payment method is entered into Stripe directly — **Inflect never stores card data**.
- **Legal basis:** performance of contract (Art. 6(1)(b)).
- **Processing instructions:** process subscription billing.
- **Transfer:** Stripe US; SCCs per the Stripe DPA.
- **Vendor pages:** https://stripe.com/privacy · https://stripe.com/legal/dpa
- **Codebase:** `src/lib/stripe.ts:18` (`new Stripe(key)`); env `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO`, `STRIPE_PRICE_ID_ENTERPRISE` (`src/env.ts:206`). Self-hosted mode (no `STRIPE_SECRET_KEY`) disables Stripe entirely — see [`docs/billing.md`](./billing.md).

### SMTP relay — email delivery
- **PII shared:** recipient email address; message body (may include the recipient's name, the tenant slug, verification/reset tokens, and notification text).
- **Legal basis:** performance of contract + legitimate interest (transactional email).
- **Processing instructions:** deliver the message; no independent use.
- **Transfer:** depends on the operator-chosen provider (SES / SendGrid / Postmark / …). The operator MUST register their chosen provider here (see [`docs/deployment.md`](./deployment.md)).
- **Vendor pages:** provider-specific (the operator records the chosen provider's DPA link).
- **Codebase:** `src/lib/mailer.ts:56` (`nodemailer.createTransport`); env `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (`src/env.ts:199`).

### OpenRouter — AI risk suggestions (optional)
- **PII shared:** the risk-assessment **prompt text** — risk titles/descriptions, which may contain business content. No user account PII is sent.
- **Legal basis:** legitimate interest (Art. 6(1)(f)); only active when the operator opts in.
- **Processing instructions:** generate a completion; per OpenRouter's terms.
- **Transfer:** OpenRouter US/global; per its terms.
- **Vendor pages:** https://openrouter.ai/privacy · https://openrouter.ai/terms
- **Operator-optional:** default `AI_RISK_PROVIDER=stub` (a local template provider — no external call). Set `AI_RISK_PROVIDER=openrouter` + `OPENROUTER_API_KEY` to enable.
- **Also used by** the inbound-questionnaire autofill (PR-9): env `AI_QUESTIONNAIRE_PROVIDER` (default `stub`; `openrouter` + `OPENROUTER_API_KEY` to enable) — routes questionnaire questions + grounding through OpenRouter (`src/app-layer/ai/questionnaire/openrouter-provider.ts`).
- **Codebase:** `src/app-layer/ai/risk-assessment/openrouter-provider.ts:14` (`https://openrouter.ai/api/v1/chat/completions`); env `AI_RISK_PROVIDER`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (`src/env.ts:213`).

### Anthropic (Claude API) — AI compliance-posture summary + AI risk suggestions (optional)

Two independent features share ONE credential (`ANTHROPIC_API_KEY` /
`ANTHROPIC_MODEL`) but send **materially different payloads**. Each is
enabled by its own env var, so an operator can run either alone.

**(a) Compliance-posture summary** — `AI_POSTURE_PROVIDER=anthropic`
- **PII shared:** **none** — only AGGREGATE metrics (control-coverage %, per-framework coverage counts, open-risk counts by severity, overdue evidence/task/policy counts). No entity names, free text, IDs, or account PII leave the process.
- **Codebase:** `src/app-layer/ai/compliance-posture/anthropic-provider.ts` (`https://api.anthropic.com/v1/messages`).

**(b) Risk suggestions** — `AI_RISK_PROVIDER=anthropic`
- **PII shared:** none by design, but the payload is **business content**, not aggregates: risk-assessment prompt text (risk titles/descriptions, asset names, tenant industry/context). Same payload the OpenRouter risk provider sends — the sanitiser and egress guard in the risk-assessment path apply identically regardless of which provider serves the request.
- **Residency:** a tenant with `aiResidency=LOCAL_ONLY` NEVER reaches this provider — the factory short-circuits to the local gateway or the deterministic stub before any external provider is constructed (`tests/guards/ai-residency-enforcement.test.ts`).
- **Codebase:** `src/app-layer/ai/risk-assessment/anthropic-provider.ts` (`https://api.anthropic.com/v1/messages`).

Common to both:
- **Legal basis:** legitimate interest (Art. 6(1)(f)); only active when the operator opts in.
- **Processing instructions:** generate the requested completion; per Anthropic's terms.
- **Transfer:** Anthropic US/global; per its terms.
- **Vendor pages:** https://www.anthropic.com/legal/privacy · https://www.anthropic.com/legal/commercial-terms
- **Operator-optional:** both default to `stub` (deterministic local providers — no external call). Set `AI_POSTURE_PROVIDER=anthropic` and/or `AI_RISK_PROVIDER=anthropic`, plus `ANTHROPIC_API_KEY` (model via `ANTHROPIC_MODEL`), to enable. `…=openrouter` routes the same respective payload through OpenRouter instead.
- **Env:** `AI_POSTURE_PROVIDER`, `AI_RISK_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (`src/env.ts`).

### HaveIBeenPwned — password breach check
- **PII shared:** **none** — only the first 5 hex chars of the SHA-1 of a candidate password (k-anonymity range query). The full hash/password never leaves the server.
- **Legal basis:** legitimate interest (Art. 6(1)(f)) — credential-stuffing defence (Epic A.3).
- **Processing instructions:** range lookup; no logging of the prefix to PII.
- **Transfer:** k-anonymity prefix carries no personal data, so no transfer concern.
- **Vendor pages:** https://haveibeenpwned.com/Privacy
- **Codebase:** `src/lib/security/password-check.ts:75` (`https://api.pwnedpasswords.com/range`).

### GitHub — repository integration (per-tenant, optional)
- **PII shared:** repository + commit metadata for the connected org; the connecting user's OAuth token. Only when a tenant enables the GitHub integration.
- **Legal basis:** consent (the tenant admin connects it) + performance of contract.
- **Processing instructions:** read repo metadata for compliance sync.
- **Transfer:** GitHub global; Microsoft/GitHub DPA SCCs.
- **Vendor pages:** https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement
- **Codebase:** `src/app-layer/integrations/providers/github/` (`client.ts`, `sync.ts`).

### Microsoft SharePoint — document integration (per-tenant, optional)
- **PII shared:** document + site metadata; the connecting user's OAuth token. Only when a tenant enables the SharePoint integration.
- **Legal basis:** consent + performance of contract.
- **Processing instructions:** read document metadata for evidence sync.
- **Transfer:** Microsoft global; Microsoft DPA SCCs.
- **Vendor pages:** https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA
- **Codebase:** `src/app-layer/integrations/providers/sharepoint/` (`client.ts`, `docx.ts`).

---

## SaaS mode vs. self-hosted

- **Stripe** applies only in SaaS mode (`STRIPE_SECRET_KEY` set); self-hosted deployments resolve every tenant to ENTERPRISE and never call Stripe — see [`docs/billing.md`](./billing.md).
- **AWS** services are present whenever the operator deploys on AWS (the reference architecture). A non-AWS operator substitutes equivalents and records them here.
- **OpenRouter, GitHub, SharePoint** are off unless explicitly enabled.

See also: [`SECURITY.md`](../SECURITY.md), [`docs/encryption-data-protection.md`](./encryption-data-protection.md) (the technical "how data is protected"), and [`docs/data-processing-agreement-template.md`](./data-processing-agreement-template.md).


> The `personnel` integration provider is **internal** — it evaluates the
> employee roster against already-connected identity accounts (offboarded
> access, onboarding SLA, manager coverage). It calls no external service, so
> it is **not** a sub-processor.


> The `device` integration provider is **internal** — it evaluates the
> device inventory (encryption, screen lock, antivirus, password manager). It
> calls no external service, so it is **not** a sub-processor. (A future MDM
> connector — Jamf / Intune — would be added here as a real sub-processor.)


> The `training` integration provider is **internal** — it evaluates
> training-assignment completion + background-check status from data entered
> manually or via a future KnowBe4 / Certn connector. It calls no external
> service today, so it is **not** a sub-processor.
