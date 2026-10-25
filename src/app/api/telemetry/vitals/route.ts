import { NextResponse } from 'next/server';
import { recordWebVital, acceptVitalBeacon } from '@/lib/observability/web-vitals';

/**
 * Web-vitals RUM sink.
 *
 * POST — receives browser web-vital beacons from `<WebVitalsReporter>`
 * (Core Web Vitals + Next.js navigation metrics). Best-effort + privacy-safe:
 *   - public (beacons fire without credentials — no auth/CSRF);
 *   - payload size-capped + per-IP rate-limited;
 *   - metric names allowlisted, values validated (server side);
 *   - ALWAYS returns 204 — never leaks internal state, never errors the client.
 *
 * Deliberately NOT routed through the standard API error wrapper (it's in
 * BARE_ROUTE_EXEMPTIONS): that wrapper applies the 60/min mutation limit, but
 * vitals legitimately fire ~8 per page over rapid navigation. The dedicated
 * `acceptVitalBeacon` limiter is tuned for that instead.
 */

const MAX_PAYLOAD_BYTES = 2048;
const MAX_BATCH = 12;

function clientIp(request: Request): string {
    const fwd = request.headers.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim();
    return request.headers.get('x-real-ip') ?? 'unknown';
}

export async function POST(request: Request): Promise<NextResponse> {
    const noContent = () => new NextResponse(null, { status: 204 });
    try {
        if (!acceptVitalBeacon(clientIp(request))) return noContent();

        const contentLength = request.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_BYTES) {
            return noContent();
        }

        const raw = await request.text();
        if (raw.length > MAX_PAYLOAD_BYTES) return noContent();

        const body = JSON.parse(raw);
        const items = Array.isArray(body) ? body.slice(0, MAX_BATCH) : [body];

        for (const m of items) {
            if (!m || typeof m.name !== 'string') continue;
            const value = Number(m.value);
            if (!Number.isFinite(value)) continue;
            recordWebVital({
                name: m.name,
                value,
                rating: typeof m.rating === 'string' ? m.rating : undefined,
                route: typeof m.route === 'string' ? m.route : '/',
                navigationType:
                    typeof m.navigationType === 'string' ? m.navigationType : undefined,
                // A public, unauthenticated sink: accept only the two shapes the
                // library produces and drop anything else, rather than passing a
                // caller-chosen value into a log field.
                navigationId:
                    typeof m.navigationId === 'string' || typeof m.navigationId === 'number'
                        ? m.navigationId
                        : undefined,
            });
        }
    } catch {
        // Best-effort telemetry — swallow everything.
    }
    return noContent();
}
