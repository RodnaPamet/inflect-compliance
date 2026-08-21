# Observability Guide

## Overview

inflect-compliance uses three observability layers:

| Layer | Technology | Purpose |
|---|---|---|
| **Structured Logging** | Pino | Machine-readable JSON logs with requestId |
| **Distributed Tracing** | OpenTelemetry | Spans for request flows and business operations |
| **Error Reporting** | Sentry | 5xx error capture with safe metadata |

All three are **safe by default** — they do nothing when their environment variables are not set. The application works identically with or without observability enabled.

---

## RequestId Model

Every API request and background job gets a unique identifier:

- **API requests**: `requestId` set in `withApiErrorHandling`, stored in AsyncLocalStorage (ALS)
- **Background jobs**: `jobRunId` set by `runJob()`, stored in ALS as `requestId`

The ID propagates automatically to:
- All Pino log lines (`requestId` field)
- OTel span attributes (`request.id`)
- Sentry error tags (`requestId`)

**No manual propagation needed.** Any code running within the request/job context automatically inherits the ID via AsyncLocalStorage.

---

## Log Field Schema

All logs produced by the structured logger include:

| Field | Source | Always Present |
|---|---|---|
| `level` | Pino | ✅ |
| `time` | Pino | ✅ |
| `msg` | Developer | ✅ |
| `requestId` | ALS auto-enrich | ✅ (in request/job context) |
| `tenantId` | ALS auto-enrich | When available |
| `component` | Developer | ✅ Convention |
| `route` | ALS auto-enrich | ✅ (in request context) |

### Component Convention

| Value | Meaning |
|---|---|
| `api` | Route handler lifecycle (start/end/error) |
| `sso` | SSO identity linking, config, enforcement |
| `mfa` | MFA challenge verification |
| `onboarding` | Onboarding wizard lifecycle |
| `report` | Report generation |
| `file` | File download |
| `job` | Background job execution |

### Redacted Fields

Pino is configured to redact these paths in log objects:

```
authorization, cookie, password, secret, token, mfaCode,
clientSecret, accessToken, refreshToken, idToken, privateKey, totpSecret,
externalUserId, distinguishedName, userPrincipalName, sAMAccountName,
req.headers.authorization, req.headers.cookie
```

The first group is credentials. The second is **directory identifiers**, which
are not credentials — and that is why they were missing: the list was "things
that authenticate", and an objectGUID or a bind DN does not authenticate
anything. It identifies a person, in a line that carries no RLS, no tenant scope
and no retention policy.

**A redacted key is not a redacted line.** Pino matches a bare key at the ROOT
level only, and it does not reach inside a string — so a field like
`error: "Entra refused to disable account <guid>"` still carries the identifier
next to the key that was scrubbed. Any log line whose `error` field can hold a
directory provider's message must pass it through
`redactDirectoryIdentifiers` from `@/lib/security/redact-directory-identifiers`
first. Adding the key alone makes the line *look* sanitised, which is worse than
leaving it visibly unsanitised, because nobody reads it twice.

That function is shared with the leaver notification path deliberately. The rule
is the same in both places, and a log is the weaker surface, not the stronger
one: an email at least has a named recipient and a retention story.

---

## Tracing Setup

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OTEL_ENABLED` | `false` | Master switch — must be `true` to activate |
| `OTEL_SERVICE_NAME` | `inflect-compliance` | Service name in traces |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP HTTP endpoint |

### How It Works

1. `src/instrumentation.ts` — Next.js `register()` hook calls `initTelemetry()` on server startup
2. `initTelemetry()` creates a `NodeTracerProvider` with `BatchSpanProcessor` → OTLP HTTP exporter
3. `withApiErrorHandling` creates a root span for every API request
4. `traceUsecase(name, ctx, fn)` creates child spans for business operations
5. `traceOperation(name, attrs, fn)` creates spans for generic operations

### Backend Compatibility

OTLP HTTP export works with: **Jaeger**, **Grafana Tempo**, **Datadog**, **Honeycomb**, **Elastic APM**, **AWS X-Ray (via collector)**.

### Local Development

```bash
# Run Jaeger all-in-one for local trace viewing:
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

# Enable tracing:
OTEL_ENABLED=true npm run dev

# View traces at http://localhost:16686
```

---

## Error Reporting Setup

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `SENTRY_DSN` | — | Sentry project DSN (noop if missing) |
| `SENTRY_ENVIRONMENT` | `NODE_ENV` | Environment tag |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Performance monitoring (0 = rely on OTel) |

### What Gets Captured

- **Only 5xx errors** — all 4xx errors are intentionally skipped
- **Server-side**: Captured in `withApiErrorHandling` catch block
- **Client-side**: Captured in `error.tsx` and `global-error.tsx` error boundaries

### What Gets Redacted (beforeSend)

- Authorization headers → `[Filtered]`
- Cookie headers → `[Filtered]`
- Request bodies → `[Filtered]`
- URL query strings → `[Filtered]`
- Sensitive URL parameters (token, secret, password, key, code, session) → `[Redacted]`

### Ignored Errors

- `NEXT_REDIRECT` / `NEXT_NOT_FOUND` — Next.js navigation signals
- `DYNAMIC_SERVER_USAGE` — Next.js build artifact
- `ResizeObserver loop` — Browser noise

---

## Local / Dev vs Production

| Aspect | Development | Production |
|---|---|---|
| **Log format** | Pretty-printed (pino-pretty) | JSON |
| **Log level** | `debug` | `info` (via `LOG_LEVEL`) |
| **OTel** | Off unless `OTEL_ENABLED=true` | On with collector endpoint |
| **Sentry** | Off unless `SENTRY_DSN` set | On with project DSN |
| **Email** | Console sink | Real mailer |

---

## Diagnostics Endpoint

`GET /api/admin/diagnostics` — authenticated by the **platform key**
(`X-Platform-Admin-Key`, the same credential as the other `/api/admin` routes),
not by a tenant role. The payload is server-wide and has no tenant dimension,
so a tenant ADMIN is not the right authority for it. Returns:

```json
{
  "service": { "name": "…", "version": "…", "environment": "…", "uptimeSeconds": 42 },
  "observability": { "otelEnabled": true, "sentryConfigured": true, "logLevel": "info" },
  "runtime": { "nodeVersion": "v20.x", "memoryUsageMB": 128 }
}
```

Returns `503` when `PLATFORM_ADMIN_API_KEY` is unset on the deployment and
`401` when the supplied key does not match — the two are kept distinct so an
operator is not sent to rotate a credential that was never configured.

---

## Maintenance Guide

### Adding observability to a new usecase

```typescript
import { logger } from '@/lib/observability/logger';
import { traceUsecase } from '@/lib/observability/tracing';

export async function myNewUsecase(ctx: RequestContext) {
    logger.info('my operation started', { component: 'my-module' });

    return traceUsecase('my-module.operation', ctx, async () => {
        // ... business logic ...
        logger.info('my operation completed', { component: 'my-module', resultCount: 42 });
        return result;
    });
}
```

### Adding observability to a new background job

```typescript
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';

export async function myNewJob() {
    return runJob('my-job-name', async () => {
        logger.info('processing items', { component: 'job', count: 100 });
        // ... job logic ...
        return { processed: 100 };
    });
}
```

### Console.log Policy

- **Forbidden** in `src/app-layer/` and `src/app/api/` — use `logger.*` instead
- **Allowed** in infrastructure modules (`src/lib/`) with allowlist (mailer dev sink, rate-limit, CSP, Prisma audit middleware)
- **Enforced** by regression guard test: `observability-guards.test.ts`

---

## SLOs, Dashboards & Alerting

Production observability infrastructure is defined in `infra/`:

| Resource | Path | Purpose |
|---|---|---|
| **SLO Definitions** | [`docs/slos.md`](slos.md) | Availability, latency, error rate, health check SLOs |
| **Grafana Dashboard** | `infra/dashboards/grafana-api-slos.json` | Importable dashboard with 14 panels |
| **Alert Rules** | `infra/alerts/rules.yml` | 10 Prometheus/Grafana alerting rules |
| **OTel Collector** | `infra/otel-collector/config.yml` | Collector config (app → Prometheus + traces) |

See `infra/README.md` for deployment instructions and complete metrics inventory.

---

## Health Probes

The application exposes three health endpoints:

| Endpoint | Purpose | Dependencies | Auth |
|---|---|---|---|
| `GET /api/livez` | Liveness probe — is the process alive? | None | Public |
| `GET /api/readyz` | Readiness probe — can the process accept traffic? | Postgres, Redis | Public |
| `GET /api/health` | **Deprecated** — same as readyz, kept for backward compat | Postgres | Public |

### Kubernetes / Docker configuration

```yaml
# Kubernetes pod spec:
livenessProbe:
  httpGet:
    path: /api/livez
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /api/readyz
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 15
```

### When readyz fails

`/api/readyz` returns HTTP 503 with a JSON body describing which dependency is down:
```json
{
  "status": "not_ready",
  "checks": {
    "database": { "status": "error", "error": "Connection refused" },
    "redis": { "status": "ok", "latencyMs": 2 }
  }
}
```

---

## Operational Runbook

### Simulating dependency failures

```bash
# 1. Simulate database outage (readyz should return 503):
docker stop inflect-postgres
curl -s http://localhost:3000/api/readyz | jq .
#   → { "status": "not_ready", "checks": { "database": { "status": "error" } } }

# 2. Simulate Redis outage:
docker stop inflect-redis
curl -s http://localhost:3000/api/readyz | jq .
#   → livez still returns 200, readyz returns 503

# 3. Verify livez is unaffected:
curl -s http://localhost:3000/api/livez | jq .
#   → { "status": "alive" }
```

### Generating error spikes (alert validation)

```bash
# Send 100 requests to a non-existent route (generates 404s — NOT 5xx):
for i in $(seq 1 100); do curl -s -o /dev/null http://localhost:3000/api/nonexistent; done

# Send requests that will 500 (e.g. malformed payload to a POST endpoint):
for i in $(seq 1 50); do
  curl -s -X POST http://localhost:3000/api/t/test/controls \
    -H "Content-Type: application/json" -d '{"invalid": true}' > /dev/null
done
# Check the error rate panel in Grafana — should spike above 1%
```

### Verifying dashboard panels with real data

```bash
OTEL_ENABLED=true npm run dev

# Generate traffic with varied latency:
for i in $(seq 1 20); do curl -s http://localhost:3000/api/livez > /dev/null; done

# Open Grafana → import infra/dashboards/grafana-api-slos.json
# Verify panels show data:
#   ✓ Request Rate should show > 0 req/s
#   ✓ Latency Percentiles should show P50/P95/P99 lines
#   ✓ Request Volume should show 2xx bars
```

### Verifying job metrics

```bash
# Run the health-check job:
npx ts-node -e "
  require('./src/app-layer/jobs/executor-registry');
  const { executorRegistry } = require('./src/app-layer/jobs/executor-registry');
  executorRegistry.execute('health-check', { enqueuedAt: new Date().toISOString() })
    .then(r => console.log(JSON.stringify(r, null, 2)));
"
# Job Execution Rate panel should show a success tick for 'health-check'
```
