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
| TypeSafe AI (Jev) | **WITHDRAWN 2026-10-14 — no data reaches it.** Was active 2026-10-11 to 2026-10-14 and processed nothing in that window (`LegacyMatchVerdict` = 0 rows). Would have shared, per residue account: the legacy account's username and its tokens, neutralised display name, given and family names, email **local part only**, department, title, account type, and transliteration variants; plus up to five HR candidates' name parts (middle and preferred included) with variants, department and title. Excluded by construction: email domains, employee numbers, dates, employment status, managers, entitlements, privilege flags, unmapped columns | Identity adjudication for legacy access recertification | US (West Coast) | Zero retention, required in the signed DPA | **No — unreachable.** `TYPESAFE_SUBPROCESSOR_ACTIVE` is `false`, so no value of `legacyMatchAiMode` reaches it |
| Okta | Directory account metadata — email, status, MFA/admin flags (per-tenant integration only; read-only pull) | Identity posture sync | Global | Token lifetime | Yes (per-tenant opt-in) |
| Google Workspace (`google-workspace`) | Directory account metadata — email, status, 2SV/admin flags (per-tenant integration only; read-only pull) | Identity posture sync | Global | Token lifetime | Yes (per-tenant opt-in) |
| Microsoft Entra ID / Azure AD (`entra-id`) | Directory account metadata — email, status, MFA-registration/admin flags, domain federation (per-tenant integration only; read-only Graph pull; also covers on-prem AD synced via Azure AD Connect) | Identity posture sync | Global | Token lifetime | Yes (per-tenant opt-in) |
| Google Calendar & Outlook Calendar (`calendar`) | **WRITES** compliance deadline titles, dates and a short detail line into the connected USER'S OWN calendar — e.g. "NIS2 notification due", "Evidence review: <name>". Per-user opt-in (Google) or tenant-admin authorised (Microsoft); no other tenant data leaves | Personal calendar push | Global | Until the user disconnects, or the event is removed by the reconcile sweep | Yes (per-tenant opt-in, then per-user connect) |
| On-prem Active Directory (`active-directory`) | Directory account metadata — sAMAccountName/UPN, email, enabled/disabled status, group membership, last-logon (per-tenant integration only; read-only LDAPS bind to the customer's own domain controller — no data leaves the customer network except the metadata pulled into Inflect) | Identity posture sync | Customer-hosted DC | Sync retention | Yes (per-tenant opt-in) |
| Legacy application via MCP (`legacy-mcp`) | **Not a sub-processor — the far end is the customer's own system.** Inflect PULLS a read-only view of a legacy application's access table from an MCP server the CUSTOMER runs, over HTTPS to an endpoint they configure: account identifier, display name, email local part, department, title, status and the columns their manifest declares. Nothing is sent except the request itself, and no third party is involved — the operator is the data controller on both ends. Listed here because the inventory is the register of every external connection, and a reader checking whether a new integration shares data with somebody needs to find the answer rather than an absence | Legacy access recertification | Customer-hosted MCP server | Snapshot retention (see docs/data-retention.md) | Yes (per-tenant opt-in) |
| Agent harness scanner and ingest | **Not a sub-processor — the ingest runs in the existing `app` service, and the scanner is to run on the customer's own infrastructure and read the customer's own systems.** Both belong to step `1a` (#3665) of the agentic IAM design: the ingest is on `main` (#3688), and the scanner is #3686. The customer's scanner is to PUSH a signed report of the agent-shaped principals in its estate to its own tenant's ingest route, `/api/t/:slug/admin/agents/harness-scans`: identifiers, flags, counts, evidence pointers, credential references and owner references, never content and never a credential value. The ingest calls no external service and no model. No third party is involved. Listed here for the reason the `legacy-mcp` row is; the assessment is [`docs/agentic-harness-scanner-dpia.md`](./agentic-harness-scanner-dpia.md) | Agent inventory and harness scoring | Customer-hosted scanner; what the ingest keeps is stored with the tenant | Business record, purged with the tenant (see docs/data-retention.md) | Yes (per-tenant opt-in) |
| BambooHR (`hris`) | Employee roster metadata — name, work email, employment status, department (per-tenant integration only; read-only pull) | HRIS sync | Global | Token lifetime | Yes (per-tenant opt-in) |
| Workday (`workday`) | Employee roster metadata — name, work email, employment status, department, manager (per-tenant integration only; read-only OAuth2 pull from the customer's own Workday tenant) | HRIS sync | Customer-selected Workday data centre | Token lifetime | Yes (per-tenant opt-in) |
| OrangeHRM (`orangehrm`) | Employee roster metadata — name, work email, employment status, department, manager, hire and termination dates (per-tenant integration only; read-only OAuth2 pull from the customer's own OrangeHRM instance). The connector's host allowlist admits only OrangeHRM-operated hosts (`*.orangehrm.com`, `*.orangehrmlive.com`), so a self-hosted instance on a customer domain cannot be connected without a reviewed allowlist change | HRIS sync | OrangeHRM-operated | Token lifetime | Yes (per-tenant opt-in) |
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
- **Codebase:** `src/lib/mailer.ts:56` (`nodemailer.createTransport`); env `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (declared in `src/env.ts`; the sender is resolved by `src/lib/email/sender-identity.ts`).

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
- **Workspace:** an API key created inside an Anthropic workspace needs nothing more. An ORGANISATION-level key is refused by Anthropic with HTTP 400 unless each request names its workspace, so set `ANTHROPIC_WORKSPACE_ID` (a `wrkspc_…` identifier, not a secret) and every request to the Anthropic API — both features above, and the Flue agent runtime's external provider, which uses the same key — carries the header `anthropic-workspace-id: <id>`. Unset, no request carries it. The header names which of the operator's own workspaces the request is billed and governed under; it sends no customer data and changes nothing about what each payload contains (`src/lib/ai/anthropic-workspace.ts`).
- **Env:** `AI_POSTURE_PROVIDER`, `AI_RISK_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_WORKSPACE_ID` (`src/env.ts`).

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

### TypeSafe AI (Jev) — identity adjudication for legacy access recertification (WITHDRAWN)

- **Activation status:** proposed-inactive (withdrawn 2026-10-14)

**This processor is WITHDRAWN and no data reaches it.**
`TYPESAFE_SUBPROCESSOR_ACTIVE` is `false`, so `getDecisionProvider` returns the local
provider or the stub for every mode and no tenant path can obtain a Jev provider whatever
`legacyMatchAiMode` is set to.

**It was active from 2026-10-11 to 2026-10-14, and it processed nothing in that window.**
That is a measurement, not a presumption: `LegacyMatchVerdict` holds **0 rows** in
production. The path was reachable at the time — `LAYA_BASE_URL` was configured and a tenant could have
selected `EXTERNAL` — and it produced no verdicts because no evaluation record was ever
committed, so the gate refused every batch as `NO_EVALUATION`.

**Why it was withdrawn rather than completed.** The owner's decision on 2026-10-14, on the
balance of what the relationship cost against what it delivered:

- it delivered **nothing measurable** — zero verdicts, ever;
- it cost a **US transfer** of legacy-account and candidate name data, a DPA obligation
  that was never discharged (no executed DPA is held here), a compliance review that was
  waived rather than performed, and a customer-notice window that had to be run;
- the model that would have made it useful on-premises instead measured **0.571 held-out
  precision** and answers that track prompt LENGTH rather than content (#3490), so the
  local alternative did not rescue the feature either;
- an open prompt-injection finding against the vendor remains unresolved (#3461).

Withdrawing closes steps 2 and 3 by removing their subject rather than by completing them,
which is the honest way to describe it: **the obligations did not get discharged, they
stopped applying.**

The code is kept rather than deleted, so this entry continues to describe something that
exists and the decision is one constant away from reversible. Deleting the ~9,600 lines of
adjudication path is a separate decision.

**Steps 2 and 3 of [`docs/sub-processor-change-policy.md`](./sub-processor-change-policy.md)
were not performed.** See *Policy progress* below. That is recorded here deliberately
rather than left as "pending" beside a live integration: a record that disagrees with
reality is worse than an unflattering one, and
`tests/guardrails/sub-processor-record-agrees-with-code.test.ts` now fails if the two
drift apart in either direction.

- **PII shared on activation:** one request per residue account, carrying an allowlisted
  JSON state and two typed questions — a `choice` over up to five candidate letters plus
  `NONE`, and a boolean *is this account used by one individual*. The state holds:
  - **the legacy account** — username and its tokens, the neutralised display name, given
    and family names, the **email local part only**, department, title, account type, and
    the transliteration variants tagged by scheme;
  - **up to five HR candidates, labelled `A`–`E`** — name parts including middle and
    preferred names, with variants, department and title.
- **Excluded by construction:** email domains, employee numbers, dates, employment status,
  managers, entitlements, privilege flags and unmapped columns. The letter-to-employee
  mapping never leaves Inflect. Vetoes, the re-keyed-person rule and the timeline stay
  deterministic, so the model judges identity and nothing else.
- **Legal basis:** legitimate interest (Art. 6(1)(f)), active only where a tenant selects
  `EXTERNAL`.
- **Processing instructions:** answer two typed questions with calibrated probabilities.
  The model returns probabilities only — it generates no text, and it creates no link: a
  person confirms every link.
- **Transfer:** US West Coast, under **Standard Contractual Clauses**. The vendor holds
  **no EU-US Data Privacy Framework certification**, so the SCCs plus a transfer impact
  assessment are the sole mechanism. The SCCs are the *instrument* permitting the
  transfer, not a statement about where the data lands — `LEGACY_MATCH_PROCESSOR`
  recorded the region as `EU` on that misreading until #3419, and the value is written
  into the immutable audit log.
- **Retention:** zero data retention, required in the signed DPA, together with the
  vendor's commitment not to train on customer data.
- **Operator-optional:** yes, and tenant-optional. `legacyMatchAiMode` defaults to `OFF`.
  Selecting `EXTERNAL` is refused under tenant AI residency `LOCAL_ONLY`.
- **Local alternative:** there is none as of 2026-10-14. A tenant choosing
  `LOCAL_ONLY` used to be served by Laya on infrastructure the operator runs; the
  owner retired that estate and `LOCAL_ONLY` is now refused at the settings
  boundary, so the only accepted mode is `OFF`. Laya was **never** a sub-processor
  and had no entry here — open weights on our own infrastructure, with no personal
  data leaving it — which is why its removal changes nothing in this register.
- **Vendor pages:** [API reference](https://docs.typesafe.ai/api) and
  [model list](https://docs.typesafe.ai/models), both re-verified 2026-10-08 by Step 6b.
  The verification corrected one row of the design document's vendor table: the model
  identifier is `jev-1.13.0`, not `jev-1.13`.
- **Codebase:** `src/app-layer/ai/identity-match/` holds the wire codec and
  `JevDecisionProvider`; the endpoint `https://api.typesafe.ai/v1/systemone` is a **code
  constant** so no configuration can redirect it.
  **`TYPESAFE_SUBPROCESSOR_ACTIVE` is `true`**, so `getDecisionProvider` returns a Jev
  provider for an `EXTERNAL` tenant *when `TYPESAFE_API_KEY` is also set*. Those are two
  separate acts and only the second moves data:
  - the flag is a code constant, changed by a reviewed pull request. On its own it is
    **inert** — with no key present the factory falls through to the local provider
    (`src/app-layer/ai/identity-match/index.ts:112-117`), so merging the flip sends
    nothing anywhere. What it does do is permit a tenant admin to select `EXTERNAL`,
    which `tenant-security-settings.ts:463` refuses while the flag is false.
  - `TYPESAFE_API_KEY` is deployment configuration, read once at startup through the
    validated `env` object. **Setting that key on the host is the act that starts the
    transfer**, and it needs a restart to take effect.

  Pinned by `tests/guards/ai-residency-enforcement.test.ts` (the gate still precedes the
  external construction), `tests/unit/identity-match-provider-factory.test.ts` (the
  active-path behaviour, including that `OFF` and `LOCAL_ONLY` stay local with the key
  present) and `tests/guardrails/sub-processor-record-agrees-with-code.test.ts` (this
  entry agrees with the constants).

**Policy progress**

| Step | State |
|------|-------|
| 1 — engineering proposes (this entry) | **Complete** — merged 2026-10-08 in #3246 |
| 2 — compliance / legal review | **Never performed** — waived 2026-10-11, then MOOT from 2026-10-14 |
| 3 — customer notice (30 days) | **Issued 2026-10-14**, window would have closed 2026-11-13; MOOT from 2026-10-14 |
| 4 — activation | **Reversed** — active 2026-10-11, **withdrawn 2026-10-14** |

- **Notice sent:** a notice was issued to the public list on 2026-10-14
  ([`docs/notices/2026-10-13-typesafe-ai-sub-processor.md`](./notices/2026-10-13-typesafe-ai-sub-processor.md)),
  and the processor was withdrawn the same day. The notice is superseded rather than
  completed: it announced a processor that no longer receives data. No customer was emailed,
  because there were no customer tenants to email — the eleven rows in production are the
  owner's own and test fixtures.
- **Objection window closes:** not applicable — no notice was sent, so no window ran.

**Activation waiver — 2026-10-11**

Activation was authorised by the repository owner on 2026-10-11 with steps 2 and 3
deliberately not performed. Recorded here because the alternative is a register reading
"pending" next to a live transfer, which is the one state that would mislead a reader who
trusted this document.

What specifically did not happen, so nobody has to reconstruct it later:

- **Step 2 (review).** `docs/sub-processor-change-policy.md` requires a compliance/legal
  review before activation. #3246 — the pull request that added this entry — merged with
  **zero reviews** and all four of its legal checkboxes unticked. Four sections of
  `docs/data-processing-agreement-template.md` are marked `[LEGAL REVIEW REQUIRED]` and
  no legal or compliance function is named anywhere in this repository
  (`docs/change-management-policy.md` records that as an open policy question).
  Of the four confirmations step 2 calls for, three are clerical and checkable from the
  signed DPA; the fourth — whether the SCCs plus a transfer impact assessment are an
  adequate basis given the vendor holds no DPF certification — requires legal competence
  that nobody in this repository has been identified as holding. **None of the four were
  recorded.**
- **Step 3 (notice).** The policy promises customers 30 days' notice before a new
  sub-processor begins processing. The notice was never sent and no window ever started.
  This register previously read "Notice sent: pending", which was accurate at the time
  and would have become false the moment the flag flipped.

**What a customer asking "were we notified?" should be told:** no. There is no evidence of
notice either way, because no notice was issued. That is an absence, not a denial, and it
is recorded here rather than inferred from a silent register.

**A notice was ISSUED on 2026-10-14** —
[`docs/notices/2026-10-13-typesafe-ai-sub-processor.md`](./notices/2026-10-13-typesafe-ai-sub-processor.md).
Posted to this public list; the objection window closes **2026-11-13**.

**The email leg was not performed, because there were no customers to email.**
The policy's email requirement protects the objection right of an EXISTING
customer whose data is about to reach a new processor, and on 2026-10-14 the
deployment had no live customer tenants — the eleven rows in production are the
owner's own and test fixtures. So the window runs against this public list
alone. That is recorded rather than smoothed over: "emailed every customer" and
"there were no customers" are different postures and only one is true. A
customer onboarded after that date receives this list as it then stands, which
is the ordinary path and not a notice event.

So the answer above changes on 2026-11-13, not before: step 3 is **performed in
part** from 2026-10-14, and complete once the window closes with no sustained
objection. Step 2 remains **not performed**.

**Zero retention** remains stated as "required in the signed DPA" above. That requirement
has **not** been confirmed against an executed DPA in this repository — no signed DPA is
held here, only the template. Treat the retention row as the commitment sought, not as a
commitment verified.

## SaaS mode vs. self-hosted

- **Stripe** applies only in SaaS mode (`STRIPE_SECRET_KEY` set); self-hosted deployments resolve every tenant to ENTERPRISE and never call Stripe — see [`docs/billing.md`](./billing.md).
- **AWS** services are present whenever the operator deploys on AWS (the reference architecture). A non-AWS operator substitutes equivalents and records them here.
- **OpenRouter, GitHub, SharePoint** are off unless explicitly enabled.

See also: [`SECURITY.md`](../SECURITY.md), [`docs/encryption-data-protection.md`](./encryption-data-protection.md) (the technical "how data is protected"), and [`docs/data-processing-agreement-template.md`](./data-processing-agreement-template.md).


> The `identity` directory under `integrations/providers/` is **not a provider
> at all** — it holds the shared primitives (`NormalizedIdentityAccount`, the
> per-account check evaluation) that Okta, Google Workspace and Entra ID each
> reuse. It contains no client, calls no external service, and appears here
> only because it sits alongside the real providers on disk. It is **not** a
> sub-processor.

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
