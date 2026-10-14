/**
 * VR-6 — live execution overlay reducer.
 */
import {
    buildOverlayMap,
    overlayClassFor,
    buildAgentRunMap,
    awaitsAHuman,
} from '@/lib/processes/canvas-execution-overlay';

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

/**
 * #3472 — the SECOND overlay channel: what an agent node's latest run is doing.
 *
 * ── WHY THESE ASSERTIONS AND NOT A SHAPE TEST ──────────────────────────────
 *
 * The reducer above has a cautionary history (#3546): its input type was
 * RESTATED rather than derived, it read a `running` field the endpoint has
 * never returned, and its test passes by constructing that field itself — a
 * double that cannot disagree with the API. `buildAgentRunMap`'s input type is
 * derived from `listCanvasAgentRuns`'s return, so the same mistake is a
 * compile error, and these cases cover the decisions the reducer actually
 * makes rather than the shape it accepts.
 */
describe('buildAgentRunMap', () => {
    const node = (over: Record<string, unknown> = {}) => ({
        ruleId: 'r1',
        runId: 'run-1',
        workflowKey: 'audit-prep',
        status: 'RUNNING',
        stepCount: 4,
        costTokens: 0,
        startedAt: new Date('2026-10-14T00:00:00Z'),
        lastStepSeq: 2,
        lastStepKind: 'READ',
        lastStepTool: 'get_framework_status',
        ...over,
    });

    it('is empty for no response, rather than throwing', () => {
        // The provider renders before the first poll resolves, and a canvas
        // that is not in Run Mode never polls at all.
        expect(buildAgentRunMap(undefined).size).toBe(0);
    });

    it('keys one state per rule', () => {
        const m = buildAgentRunMap({ nodes: [node()] } as never);
        expect(m.get('r1')?.runId).toBe('run-1');
        expect(m.get('r1')?.lastStepSeq).toBe(2);
    });

    it('keeps the FIRST row for a rule, which the usecase orders newest-first', () => {
        // The usecase already returns one row per rule, so this dedupe is for
        // a future endpoint that returns a history: it must degrade to the
        // LATEST run, not to the last element of the array.
        const m = buildAgentRunMap({
            nodes: [node({ runId: 'newer' }), node({ runId: 'older' })],
        } as never);
        expect(m.get('r1')?.runId).toBe('newer');
    });

    it('carries a run with no steps yet, with a null step position', () => {
        // A just-started run has genuinely recorded none. A zero here would
        // render as "step 1 of 0" and read as a stalled run.
        const m = buildAgentRunMap({
            nodes: [node({ lastStepSeq: null, lastStepKind: null, lastStepTool: null })],
        } as never);
        expect(m.get('r1')?.lastStepSeq).toBeNull();
        expect(m.get('r1')?.status).toBe('RUNNING');
    });
});

describe('awaitsAHuman', () => {
    const state = (status: string) => ({
        runId: 'r', workflowKey: 'w', status, stepCount: 1,
        lastStepSeq: 0, lastStepKind: 'READ', lastStepTool: null,
    });

    it('is true only for AWAITING_APPROVAL', () => {
        expect(awaitsAHuman(state('AWAITING_APPROVAL'))).toBe(true);
    });

    it('is FALSE for PAUSED — a deploy paused it and it resumes on its own', () => {
        // Badging PAUSED would send an operator looking for an approval queue
        // that is empty. This is the case the distinction exists for.
        expect(awaitsAHuman(state('PAUSED'))).toBe(false);
    });

    it('is false for every other status, and for no run at all', () => {
        for (const s of ['RUNNING', 'COMPLETED', 'FAILED', 'ABORTED']) {
            expect(awaitsAHuman(state(s))).toBe(false);
        }
        expect(awaitsAHuman(undefined)).toBe(false);
    });
});
