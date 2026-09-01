/**
 * VR-6 — live execution overlay reducer.
 */
import { buildOverlayMap, overlayClassFor } from '@/lib/processes/canvas-execution-overlay';

describe('buildOverlayMap', () => {
    it('returns an empty map for undefined', () => {
        expect(buildOverlayMap(undefined).size).toBe(0);
    });

    it('maps recent terminal executions by ruleId', () => {
        const m = buildOverlayMap({
            running: [],
            recent: [
                { ruleId: 'r1', status: 'SUCCEEDED', createdAt: '2026-06-08T00:00:00Z' },
                { ruleId: 'r2', status: 'FAILED', createdAt: '2026-06-08T00:01:00Z' },
            ],
        });
        expect(m.get('r1')?.status).toBe('SUCCEEDED');
        expect(m.get('r2')?.status).toBe('FAILED');
    });

    it('RUNNING wins over a terminal state for the same rule + counts concurrency', () => {
        const m = buildOverlayMap({
            running: [
                { ruleId: 'r1', status: 'RUNNING', createdAt: '2026-06-08T00:02:00Z' },
                { ruleId: 'r1', status: 'RUNNING', createdAt: '2026-06-08T00:02:05Z' },
            ],
            recent: [{ ruleId: 'r1', status: 'SUCCEEDED', createdAt: '2026-06-08T00:00:00Z' }],
        });
        expect(m.get('r1')?.status).toBe('RUNNING');
        expect(m.get('r1')?.count).toBe(2);
    });
});

describe('overlayClassFor', () => {
    it('maps each status to a distinct chassis treatment', () => {
        expect(overlayClassFor('RUNNING')).toContain('animate-pulse');
        expect(overlayClassFor('SUCCEEDED')).toContain('ring-content-success');
        expect(overlayClassFor('FAILED')).toContain('ring-content-error');
        expect(overlayClassFor('SKIPPED')).toContain('opacity-50');
        expect(overlayClassFor(undefined)).toBe('');
    });
});

// ─── Degraded-response + precedence branches ───────────────────────
//
// `buildOverlayMap` guards `resp.recent ?? []`, `resp.running ?? []`
// and `(r.status as OverlayStatus) ?? 'SKIPPED'`. The declared
// response type marks `running` / `recent` as REQUIRED and `status`
// as a plain `string`, so a degraded body cannot be written as a
// plain literal. It is constructed through this ONE named cast
// rather than an `as any` sprayed at each call site.

type DegradedRow = {
    ruleId: string;
    status: string | null;
    createdAt: string;
};
type DegradedResponse = {
    running?: DegradedRow[];
    recent?: DegradedRow[];
};

function degraded(
    body: DegradedResponse,
): Parameters<typeof buildOverlayMap>[0] {
    return body as Parameters<typeof buildOverlayMap>[0];
}

describe('buildOverlayMap — degraded payloads', () => {
    it('tolerates a body with no `recent` array and still reads `running`', () => {
        const m = buildOverlayMap(
            degraded({
                running: [
                    { ruleId: 'r1', status: 'RUNNING', createdAt: '2026-06-08T00:00:00Z' },
                ],
            }),
        );
        expect(m.size).toBe(1);
        expect(m.get('r1')).toStrictEqual({
            status: 'RUNNING',
            startedAt: '2026-06-08T00:00:00Z',
            count: 1,
        });
    });

    it('tolerates a body with no `running` array and still reads `recent`', () => {
        const m = buildOverlayMap(
            degraded({
                recent: [
                    { ruleId: 'r1', status: 'FAILED', createdAt: '2026-06-08T00:00:00Z' },
                ],
            }),
        );
        expect(m.size).toBe(1);
        expect(m.get('r1')).toStrictEqual({
            status: 'FAILED',
            startedAt: '2026-06-08T00:00:00Z',
            count: 0,
        });
    });

    it('returns an empty map when BOTH arrays are absent', () => {
        expect(buildOverlayMap(degraded({})).size).toBe(0);
    });

    it("substitutes SKIPPED for a recent row whose status is null", () => {
        // A terminal row the API could not classify must still paint a
        // treatment — falling through as `null` would make
        // `overlayClassFor` return '' and the node would look untouched.
        const m = buildOverlayMap(
            degraded({
                running: [],
                recent: [
                    { ruleId: 'r1', status: null, createdAt: '2026-06-08T00:00:00Z' },
                ],
            }),
        );
        expect(m.get('r1')?.status).toBe('SKIPPED');
        expect(overlayClassFor(m.get('r1')?.status)).toBe('opacity-50');
    });

    it('keeps the FIRST recent row for a ruleId (the endpoint sorts newest-first)', () => {
        // The reducer guards with `!map.has(...)`. Dropping that guard
        // would let the OLDER duplicate overwrite the newer one, so the
        // node would flash the wrong terminal state.
        const m = buildOverlayMap(
            degraded({
                running: [],
                recent: [
                    { ruleId: 'r1', status: 'FAILED', createdAt: '2026-06-08T00:05:00Z' },
                    { ruleId: 'r1', status: 'SUCCEEDED', createdAt: '2026-06-08T00:01:00Z' },
                ],
            }),
        );
        expect(m.size).toBe(1);
        expect(m.get('r1')).toStrictEqual({
            status: 'FAILED',
            startedAt: '2026-06-08T00:05:00Z',
            count: 0,
        });
    });

    it('resets the concurrency count to 1 when the prior entry was terminal', () => {
        // `existing?.status === 'RUNNING' ? existing.count : 0` — the
        // false arm. A recent SUCCEEDED row carries count 0; the single
        // running row that follows must report 1, not 0 and not 2.
        const m = buildOverlayMap(
            degraded({
                running: [
                    { ruleId: 'r1', status: 'RUNNING', createdAt: '2026-06-08T00:09:00Z' },
                ],
                recent: [
                    { ruleId: 'r1', status: 'SUCCEEDED', createdAt: '2026-06-08T00:01:00Z' },
                ],
            }),
        );
        expect(m.get('r1')).toStrictEqual({
            status: 'RUNNING',
            startedAt: '2026-06-08T00:09:00Z',
            count: 1,
        });
    });
});
