/**
 * Admin Diagnostics Endpoint
 *
 * GET /api/admin/diagnostics
 *
 * Returns lightweight service health and configuration status.
 *
 * ═══ AUTH: PLATFORM key, not a tenant role ═══
 *
 * Gated by `PLATFORM_ADMIN_API_KEY` (X-Platform-Admin-Key header), matching
 * its two siblings under `/api/admin`.
 *
 * It previously called `getLegacyCtx(req)` and checked
 * `ctx.permissions.canAdmin`, which reads as "admin only" but is not what it
 * did. `getLegacyCtx` resolves the context from the CALLER'S OWN
 * `session.tenantId`, so the check asked "are you an admin of your own
 * tenant?" — and every answer of yes, in any tenant, returned the same
 * server-wide payload: Node version, platform, NODE_ENV, release version,
 * heap usage, log level, and which observability backends are wired.
 *
 * None of that has a tenant dimension. There is no reading of it under which
 * one tenant's admin is more entitled than another's, which is the tell that
 * a tenant role was the wrong axis: the correct question is "are you
 * operating this deployment", and the platform key is how that is asked here.
 *
 * The old check also threw `forbidden(...)` directly, so a denial wrote no
 * `AUTHZ_DENIED` audit row (only `requirePermission` does). It evaded
 * `no-legacy-admin-guard` by hand-rolling the check instead of naming the
 * banned helper, and evaded the C.1 coverage guardrail because no
 * PRIVILEGED_ROOT covered `/api/admin` at all.
 *
 * SAFETY: Never exposes secrets, DSNs, or sensitive configuration values —
 * `sentryConfigured` is a boolean, never the DSN.
 */
import { NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { isTelemetryInitialized } from '@/lib/observability/instrumentation';
import { isSentryInitialized } from '@/lib/observability/sentry';
import { jsonResponse } from '@/lib/api-response';

const startedAt = new Date();

export const GET = withApiErrorHandling(async (req) => {
    try {
        verifyPlatformApiKey(req);
    } catch (err) {
        // Same shape as the sibling platform routes, and it must keep the
        // error's OWN status: `verifyPlatformApiKey` throws 503 when the key
        // is not configured at all and 401 when it does not match. Collapsing
        // both to 401 would tell an operator their key is wrong when in fact
        // the deployment has none set.
        if (err instanceof PlatformAdminError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
    }

    const uptimeSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);

    return jsonResponse({
        service: {
            name: process.env.OTEL_SERVICE_NAME || 'inflect-compliance',
            version: process.env.npm_package_version || '0.0.0',
            environment: process.env.NODE_ENV || 'development',
            startedAt: startedAt.toISOString(),
            uptimeSeconds,
        },
        observability: {
            otelEnabled: !!process.env.OTEL_ENABLED && process.env.OTEL_ENABLED === 'true',
            otelInitialized: isTelemetryInitialized(),
            sentryConfigured: !!process.env.SENTRY_DSN,
            sentryInitialized: isSentryInitialized(),
            logLevel: process.env.LOG_LEVEL || 'info',
        },
        runtime: {
            nodeVersion: process.version,
            platform: process.platform,
            memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        },
    });
});
