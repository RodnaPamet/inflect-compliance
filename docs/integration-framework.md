# Integration Framework

Architecture guide for the integration framework (Epic 13).

## Overview

The integration framework provides a plugin-based system for:
- **Scheduled checks** — cron-based automation that verifies compliance controls
- **Webhook events** — incoming events from external providers (GitHub, etc.)
- **Evidence auto-creation** — check results become auditable Evidence records

All operations are tenant-scoped. Secrets are AES-256-GCM encrypted at rest.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Admin UI                           │
│  /admin/integrations → CRUD connections             │
│  /admin/integrations/diagnostics → health/history   │
└────────────┬──────────────────────┬─────────────────┘
             │                      │
┌────────────▼──────────┐ ┌────────▼──────────────────┐
│   Webhook Route       │ │   Scheduled Runner        │
│ POST /api/integrations│ │ runScheduledAutomations()  │
│ /webhooks/{provider}  │ │ via runJob() observability │
└────────────┬──────────┘ └────────┬──────────────────┘
             │                      │
┌────────────▼──────────────────────▼─────────────────┐
│              Provider Registry                      │
│  automationKey → provider.checkType → Provider      │
│  e.g. github.branch_protection → GitHubProvider     │
└────────────┬──────────────────────┬─────────────────┘
             │                      │
┌────────────▼──────────┐ ┌────────▼──────────────────┐
│  IntegrationExecution │ │  Evidence                  │
│  (audit trail)        │ │  (compliance record)       │
└───────────────────────┘ └───────────────────────────┘
```

## automationKey Pattern

Format: `{provider}.{check_type}`

| Key | Provider | Check |
|-----|----------|-------|
| `github.branch_protection` | GitHub | Branch protection rules |
| `aws.s3_encryption` | AWS (future) | S3 bucket encryption |
| `azure.defender_status` | Azure (future) | Defender for Cloud |

The provider prefix routes to the registered `IntegrationProvider`.
The check type selects the specific check within that provider.

### Setting on a Control

```
Control.automationKey = "github.branch_protection"
Control.evidenceSource = "INTEGRATION"
Control.frequency = "DAILY"
```

## Webhook Flow

```
1. POST /api/integrations/webhooks/{provider}
2. Read raw body (for signature verification)
3. Compute SHA-256 payload hash → check dedup window (5 min)
4. Persist IntegrationWebhookEvent (status: received)
5. Find IntegrationConnection by provider (resolve tenant from DB)
6. Verify HMAC-SHA256 / provider-specific signature
7. Dispatch to provider.handleWebhook()
8. Create IntegrationExecution + Evidence for triggered keys
9. Update event status (processed / ignored / error)
```

### Replay Protection

Duplicate payloads within a 5-minute window are detected via SHA-256 hash
and silently ignored (returns `{ status: 'ignored', reason: 'duplicate_payload' }`).

### Signature Verification

| Provider | Header | Method |
|----------|--------|--------|
| GitHub | `X-Hub-Signature-256` | `sha256=<HMAC-SHA256-hex>` |
| GitLab | `X-Gitlab-Token` | Token comparison |
| Generic | `X-Webhook-Signature` | HMAC-SHA256 hex |

## Scheduled Runner Flow

```
1. runScheduledAutomations() — entry point (cron)
2. findDueAutomationControls(now) — query controls where:
   - automationKey is set
   - evidenceSource = INTEGRATION
   - frequency ≠ AD_HOC
   - nextDueAt ≤ now (or null = never run)
   - no execution within current frequency window (idempotency)
3. For each due control:
   - Resolve provider from registry
   - Find active IntegrationConnection
   - provider.runCheck() with decrypted config
   - Create IntegrationExecution record
   - Create Evidence (if provider.mapResultToEvidence returns data)
   - Update Control.lastTested + advance nextDueAt
```

### Frequency Intervals

| Frequency | Interval |
|-----------|----------|
| DAILY | 24 hours |
| WEEKLY | 7 days |
| MONTHLY | 30 days |
| QUARTERLY | 90 days |
| ANNUALLY | 365 days |
| AD_HOC | Manual only |

## GitHub Integration Example

### Setup

1. Go to **Admin → Integrations → Add Integration**
2. Select **GitHub** provider
3. Configure:
   - Owner: `acme-corp`
   - Repository: `platform-api`
   - Branch: `main`
4. Enter secrets:
   - Token: GitHub PAT with `repo` scope
   - Webhook Secret: (optional) for incoming webhooks
5. Click **Create Connection**

### Control Configuration

Set on any Control:
- `automationKey`: `github.branch_protection`
- `evidenceSource`: `INTEGRATION`
- `frequency`: `DAILY` (or any scheduled frequency)

### Check Result

The check evaluates:
- ✅/❌ Branch protection enabled
- ✅/❌ Required reviews configured (≥1 reviewer)
- ✅/❌ Status checks required before merge
- ℹ️ Enforce admins, force push, code owner reviews

**PASS** = required reviews + status checks both configured.

### Evidence Output

Type: `CONFIGURATION`, auto-approved, linked to the Control.

## Secret & Config Management

### Storage
- Config fields: stored as JSON in `IntegrationConnection.configJson`
- Secret fields: stored encrypted in `IntegrationConnection.secretEncrypted`
- Encryption: AES-256-GCM via `encryptField()` (unique IV per save)

### API Behavior
- Secrets are **never** returned after creation
- DTOs always show `secretStatus: "••••••••"`
- Rotation: POST with new `secrets` field replaces encrypted value
- Validation: PUT to test connection without saving

### Admin Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/t/{slug}/admin/integrations` | List connections (masked) |
| POST | `/api/t/{slug}/admin/integrations` | Create/update |
| PUT | `/api/t/{slug}/admin/integrations` | Validate/test |
| DELETE | `/api/t/{slug}/admin/integrations` | Disable |
| GET | `/api/t/{slug}/admin/integrations/diagnostics` | Health + history |

## Outbound HTTP

Every provider's outbound call goes through one chain. Nothing in
`src/app-layer/integrations/` calls the global `fetch` except
`bounded-fetch.ts` itself.

```
provider  ->  base-client  ->  resilientFetch  ->  boundedFetch  ->  fetch
                               429 / Retry-After   30s deadline
```

`base-client.ts` defaults `fetchImpl` to `resilientFetch`, so a provider gets
both layers by writing nothing. A provider that needs its own transport takes
`deps.fetchImpl ?? resilientFetch` — never `?? fetch`.

### What comes back, and what throws

This is the part that surprises: `resilientFetch` **throws for some statuses
instead of returning a Response**, so a `!res.ok` branch never sees them.

| Status | Outcome |
|--------|---------|
| 401, 403 | throws `IntegrationAuthError` |
| 404 | throws `IntegrationTerminalError` |
| 429, 502, 503, 504 | retried in-process up to `MAX_HTTP_ATTEMPTS`, honouring `Retry-After`, then throws `IntegrationRateLimitedError` |
| anything else (including 400) | the `Response` is returned to the caller |

Two consequences worth knowing before writing a provider:

- **A `if (!res.ok)` line is unreachable for 401/403.** Provider code that
  builds its own error message for an auth failure is dead code; the class is
  decided upstream.
- **`markAuthFailure` marks a connection only for `IntegrationAuthError`**
  (`connection-health.ts`). It returns `false` for anything else, and no caller
  checks the return value — so an unclassified failure is a silent no-op.

### OAuth token endpoints signal credential failure with 400

RFC 6749 §5.2 puts the error code in a **400** body (`invalid_grant`,
`invalid_client`, `unauthorized_client`), and 400 is in none of the sets above.
So a revoked Google domain-wide-delegation grant or an expired Entra client
secret returns a `Response`, the provider's own `!res.ok` throw produces a plain
`Error`, and `markAuthFailure` no-ops. The connection keeps rendering as
healthy while every sync fails.

Classifying those bodies is tracked separately. It is deliberately not a change
to `resilientFetch`'s status sets — a 400 from an ordinary REST endpoint means
something entirely different — and it must be **additive**. Every 401/403 already
marks today, unconditionally and without inspecting the body, so introducing an
allowlist that only honours the 400 codes would silently stop marking the
credential failures providers do report as 401 — narrowing a working signal
while looking like an improvement.

### Rules the guards enforce

- No bare `fetch` under `src/app-layer/integrations/**` — not as a default
  (`?? fetch`, `= fetch`, `= globalThis.fetch`) and not as a direct
  `await fetch(`. Enforced by
  `tests/guards/integrations-bounded-fetch-coverage.test.ts`.
- No bare `fetch` in any file that talks to a known OAuth token endpoint,
  wherever it lives. `src/lib/auth/refresh.ts` performs the Microsoft and
  Google refresh exchanges from outside the integrations tree, which is why
  this guard selects by endpoint rather than by path. Enforced by
  `tests/guards/token-endpoint-egress.test.ts`.
- Naming `boundedFetch` in a provider fails CI. It bounds one request but
  leaves a 429 to surface as a generic failure; `resilientFetch` is the
  finished article, and only it and `bounded-fetch.ts` may name the helper.

### Do not put a response body in an error

`IntegrationAuthError`'s message is persisted verbatim into
`IntegrationConnection.authFailureReason`, which is exempt from field
encryption on the recorded grounds that it is system-generated and
URL-scrubbed by `safeUrl`. `safeUrl` scrubs URLs, not bodies — and a token
endpoint's `error_description` can carry a client id, a service-account email
or an assertion fragment. Anything added to that message must come from a
fixed allowlist.

## Troubleshooting

### Webhook not processing
1. Check `/admin/integrations` — is the connection enabled?
2. Check diagnostics — any recent errors?
3. Verify webhook secret matches GitHub webhook config
4. Check server logs for `component: 'integrations'`

### Scheduled check not running
1. Verify Control has `automationKey`, `evidenceSource=INTEGRATION`, `frequency` set
2. Verify `nextDueAt` is in the past
3. Verify an active `IntegrationConnection` exists for the provider
4. Check for recent execution in the frequency window (idempotency)

### Evidence not created
1. Check `IntegrationExecution` status — ERROR means the check failed
2. Provider `mapResultToEvidence()` returns null for ERROR status (intentional)
3. Only PASSED/FAILED checks create evidence

### Adding a new provider
1. Create `src/app-layer/integrations/providers/{name}.ts`
2. Implement `ScheduledCheckProvider` and/or `WebhookEventProvider`
3. Register in `bootstrap.ts`: `registry.register(new YourProvider())`
4. Add tests in `tests/integration/{name}-provider.test.ts`
