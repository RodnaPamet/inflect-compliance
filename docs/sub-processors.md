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
| Google Cloud (Compute Engine + Persistent Disk + Snapshots) | Everything the deployment holds: encrypted business data, user PII, the hash-chained `AuditLog`, uploaded evidence files, and the runtime secrets in `/opt/inflect/.env.prod` — all on one persistent disk, and in that disk's daily snapshots | Hosting, database, object storage, queue and backup | `europe-west1` (Belgium); snapshots in the `eu` multi-region | Customer-controlled; snapshots 14 days | No (load-bearing) |
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
| Google Calendar & Outlook Calendar (`calendar`) | **WRITES** compliance deadline titles, dates and a short detail line into the connected USER'S OWN calendar — e.g. "NIS2 notification due", "Evidence review: <name>". Per-user opt-in (Google) or tenant-admin authorised (Microsoft); no other tenant data leaves | Personal calendar push | Global | Until the user disconnects, or the event is removed by the reconcile sweep | Yes (per-tenant opt-in, then per-user connect) |
| On-prem Active Directory (`active-directory`) | Directory account metadata — sAMAccountName/UPN, email, enabled/disabled status, group membership, last-logon (per-tenant integration only; read-only LDAPS bind to the customer's own domain controller — no data leaves the customer network except the metadata pulled into Inflect) | Identity posture sync | Customer-hosted DC | Sync retention | Yes (per-tenant opt-in) |
| BambooHR (`hris`) | Employee roster metadata — name, work email, employment status, department (per-tenant integration only; read-only pull) | HRIS sync | Global | Token lifetime | Yes (per-tenant opt-in) |
| Workday (`workday`) | Employee roster metadata — name, work email, employment status, department, manager (per-tenant integration only; read-only OAuth2 pull from the customer's own Workday tenant) | HRIS sync | Customer-selected Workday data centre | Token lifetime | Yes (per-tenant opt-in) |
| ServiceNow (`servicenow`) | Change-management records — change number, short description, approval state, assignment group, requester (per-tenant integration only; read-only pull from the customer's own ServiceNow instance) | Change-management evidence | Customer-selected ServiceNow data centre | Session lifetime | Yes (per-tenant opt-in) |

> **Customer-configured SSO IdPs.** A tenant may configure its own SAML
> or OIDC identity provider (`src/app/api/auth/sso/saml/*`,
> `src/app/api/auth/sso/oidc/*`). That IdP is the **customer's own**
> provider, chosen and controlled by the customer — it is not an Inflect
> sub-processor. Inflect receives the assertion/claims the customer's IdP
> sends (email, name, group memberships).

---

## Per-sub-processor detail

### Google Cloud — hosting, database, storage, backup

The production deployment is a **single Compute Engine VM** running Docker
Compose. Postgres, Redis, the app, the worker and ClamAV are containers on that
VM; there is no managed database, no object-storage bucket and no managed
secret store. That is why one entry replaces what earlier revisions of this
document listed as five separate AWS services.

- **PII shared:** all of it. User email, name, membership and role; business
  records; the hash-chained `AuditLog`; uploaded evidence files
  (`STORAGE_PROVIDER=local`, on a Docker volume); session rows carrying
  `ipAddress` and `userAgent`; and the master KEK itself, which lives in
  `/opt/inflect/.env.prod` on the same disk. Business-content fields are
  envelope-encrypted with a per-tenant DEK (Epic B) and every tenant table is
  under RLS, but the disk holds the ciphertext and the wrapping key together.
- **Legal basis:** performance of contract (GDPR Art. 6(1)(b)) — hosting the
  service is the service.
- **Processing instructions:** run the workload and store its data; no
  independent use. Google Cloud does not read application data.
- **Transfer:** the VM is in `europe-west1` (Belgium) and snapshots are stored
  in the `eu` multi-region, so primary data and backups stay in the EEA.
- **Retention:** governed by the application's own retention rules
  ([`docs/data-retention.md`](./data-retention.md)). Disk snapshots are kept 14
  days by policy `inflect-daily-snapshot`, with one permanent manual snapshot
  outside that window.
- **Vendor pages:** https://cloud.google.com/security/gdpr · https://cloud.google.com/terms/data-processing-addendum
- **Codebase:** `deploy/docker-compose.prod.yml`; env `DATABASE_URL`,
  `DIRECT_DATABASE_URL` (`src/env.ts`), `REDIS_URL`, `FILE_STORAGE_ROOT` and
  `STORAGE_PROVIDER`. Recovery posture in
  [`docs/disaster-recovery.md`](./disaster-recovery.md).

> **An earlier revision of this list named AWS S3, RDS, ElastiCache, KMS and
> Secrets Manager as non-optional sub-processors.** None of them has ever been
> provisioned: the Terraform describing them was never applied. Naming the wrong
> processor is a disclosure defect rather than doc rot — it is the field a
> customer's DPIA and transfer assessment key on — so it is corrected here
> rather than annotated. See
> [#2226](https://github.com/RodnaPamet/inflect-compliance/issues/2226).
>
> The application still *supports* S3-compatible object storage
> (`src/lib/storage/s3-provider.ts`, selected by `STORAGE_PROVIDER=s3`, with
> `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` and
> `S3_SECRET_ACCESS_KEY`). An operator who enables it adds their chosen
> provider as a sub-processor and must record it here.

### Optional external services this deployment does not use

Named so the inventory stays a complete triage of `src/env.ts` rather than a
list of only what happens to be switched on. Each is unset in production today;
enabling any of them adds a sub-processor and requires an entry above.

| Env | Service it would introduce | Status here |
|---|---|---|
| `DATABASE_READ_URL` | A read replica of the primary database — a second managed database instance if pointed off-box | Unset. `prismaRead === prisma`; single-DB mode. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Any S3-compatible object-storage provider (AWS S3, Cloudflare R2, MinIO, …) for evidence files | Unset. `STORAGE_PROVIDER=local`; files are on the VM's disk. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Upstash — managed Redis over REST, used as the rate-limit backend when set | Unset. Rate limiting falls back to the in-process/in-VM Redis. |

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
