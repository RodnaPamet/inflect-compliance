import { NextResponse, type NextRequest } from 'next/server';
import {
    checkReportRateLimit,
    storeViolation,
    recordDropped,
    parseLegacyReport,
    parseModernReports,
    getViolationSummary,
    MAX_REPORT_PAYLOAD_BYTES,
} from '@/lib/security/csp-violations';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';

/**
 * CSP Violation Report Endpoint
 *
 * POST — receives browser CSP violation reports
 *   Supports:
 *     - Legacy: application/csp-report (single violation)
 *     - Modern: application/reports+json (Reporting API v1, array)
 *     - Fallback: application/json
 *
 * GET — returns the recent-violation summary (operator debugging)
 *   Gated in-handler by PLATFORM_ADMIN_API_KEY. Nothing in the product
 *   calls it; it exists for whoever operates the deployment.
 *
 * Security:
 *   - POST: rate limited 30 reports/IP/min, payload capped at 16 KB,
 *     no CSRF token required (the browser sends reports without
 *     credentials), always 204 (never leaks internal state).
 *   - GET: X-Platform-Admin-Key, verified in constant time. See the
 *     docblock on the handler for why the gate lives in the handler
 *     and why it is the platform key rather than a tenant role.
 */

// ─── POST: Receive CSP violation reports ─────────────────────────────

export async function POST(request: Request): Promise<NextResponse> {
    try {
        // ── Rate limit by IP ──
        const clientIp = extractClientIp(request);
        if (!checkReportRateLimit(clientIp)) {
            recordDropped();
            return new NextResponse(null, { status: 429 });
        }

        // ── Payload size guard ──
        const contentLength = request.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_REPORT_PAYLOAD_BYTES) {
            recordDropped();
            return new NextResponse(null, { status: 413 });
        }

        // ── Read body with size limit ──
        const rawBody = await readBodyWithLimit(request, MAX_REPORT_PAYLOAD_BYTES);
        if (rawBody === null) {
            recordDropped();
            return new NextResponse(null, { status: 413 });
        }

        // ── Parse payload ──
        const contentType = request.headers.get('content-type') ?? '';
        const userAgent = request.headers.get('user-agent') ?? '';

        let parsed: ReturnType<typeof JSON.parse>;
        try {
            parsed = JSON.parse(rawBody);
        } catch {
            recordDropped();
            return new NextResponse(null, { status: 204 });
        }

        // ── Legacy format: { "csp-report": { ... } } ──
        if (
            contentType.includes('application/csp-report') ||
            (typeof parsed === 'object' && parsed !== null && 'csp-report' in parsed)
        ) {
            const violation = parseLegacyReport(parsed, clientIp, userAgent);
            if (violation) {
                storeViolation(violation);
            } else {
                recordDropped();
            }
            return new NextResponse(null, { status: 204 });
        }

        // ── Modern format: [{ "type": "csp-violation", "body": { ... } }] ──
        if (
            contentType.includes('application/reports+json') ||
            Array.isArray(parsed)
        ) {
            const violations = parseModernReports(parsed, clientIp, userAgent);
            for (const v of violations) {
                storeViolation(v);
            }
            if (violations.length === 0) recordDropped();
            return new NextResponse(null, { status: 204 });
        }

        // ── Unknown format ──
        recordDropped();
        return new NextResponse(null, { status: 204 });
    } catch {
        // Never leak errors — always 204
        recordDropped();
        return new NextResponse(null, { status: 204 });
    }
}

// ─── GET: Operator summary of recent violations ───────────────

/**
 * This path is listed in `MACHINE_CALLER_PREFIXES` (src/lib/auth/guard.ts)
 * so the edge lets the POST through without a cookie — a browser will not
 * attach one to a CSP report, so requiring credentials there guarantees zero
 * reports forever. That allowlist is PATH-scoped, not method-scoped, so the
 * GET is equally public at the edge and has to gate itself here. It did not,
 * under a comment asserting that "the middleware auth guard" covered it, and
 * so it served `documentUri` / `originalPolicy` / `sourceFile` to anyone who
 * asked (#2103). Do not replace this with another claim about the
 * middleware: whatever the middleware does to `/api/*` in general, it does
 * not do to this path in particular.
 *
 * The gate is the PLATFORM key rather than a tenant role, and that is the
 * load-bearing choice rather than an accident of what was to hand. The ring
 * buffer is ONE process-wide array shared by every tenant on the instance,
 * so a `documentUri` of `/t/<some-other-tenant>/risks/…` is sitting in it.
 * There is no tenant role under which reading another tenant's page URLs is
 * correct — a tenant-ADMIN check would narrow the audience from "the
 * internet" to "any admin of any tenant" and still be a cross-tenant read.
 * The question this surface actually asks is "are you operating this
 * deployment", and `/api/admin/diagnostics` — same shape, server-wide data
 * with no tenant dimension — already answers it exactly this way.
 *
 * Consequence worth knowing before debugging a CSP problem: with
 * `PLATFORM_ADMIN_API_KEY` unset this endpoint is 503, i.e. off. That is the
 * intended default. Reading the violation buffer is an operator action.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
    try {
        verifyPlatformApiKey(request);
    } catch (err) {
        // Keep the error's OWN status. `verifyPlatformApiKey` throws 503 when
        // no key is configured on this deployment and 401 when the supplied
        // one is missing or wrong; collapsing both to 401 sends an operator
        // off to rotate a credential that does not exist.
        if (err instanceof PlatformAdminError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
    }

    const summary = getViolationSummary(50);
    return jsonResponse(summary);
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractClientIp(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return '127.0.0.1';
}

/**
 * Read request body with a byte limit to prevent memory exhaustion.
 * Returns null if the body exceeds the limit.
 */
async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string | null> {
    const reader = request.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                reader.cancel();
                return null;
            }
            chunks.push(value);
        }

        const merged = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return new TextDecoder().decode(merged);
    } catch {
        return null;
    }
}
