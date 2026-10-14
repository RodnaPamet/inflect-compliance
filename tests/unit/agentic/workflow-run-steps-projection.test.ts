/**
 * #3472 — the step projection, now shared by three surfaces.
 *
 * It used to live inline in `/agents/runs/[runId]/page.tsx`, where the only
 * thing covering it was a rendered test that CONSTRUCTED `RunStepRow` objects
 * by hand — so the projection itself, the part that decides which column wins
 * and which proposals belong to which step, was never executed by a test. Now
 * that a route and an SSE tail read it too, that is the gap worth closing.
 *
 * Pure: no database, no context, no workflow registry lookup. Every case below
 * is a decision the function makes rather than a shape it passes through.
 */
import {
    projectRunSteps,
    decisionDigestOf,
    isLiveRunStatus,
    type ProjectableStep,
    type ProjectableProposal,
} from '@/lib/agentic/run-step-projection';

const AT = new Date('2026-10-14T00:00:00.000Z');

function step(over: Partial<ProjectableStep> = {}): ProjectableStep {
    return {
        id: 's1', seq: 0, kind: 'READ', status: 'DONE',
        toolCalled: 'get_framework_status',
        inputJson: null, outputJson: null,
        guardVerdict: null, guardRuleIds: [], costTokens: null,
        at: AT, actorUserId: null,
        ...over,
    };
}

function proposal(over: Partial<ProjectableProposal> = {}): ProjectableProposal {
    return { id: 'p1', kind: 'EXTERNAL_WRITE', status: 'PENDING', guardVerdict: 'CLEAN', stepSeq: 0, ...over };
}

describe('projectRunSteps', () => {
    it('groups SEVERAL proposals onto the step that queued them', () => {
        // One `buildItems` can produce many, which is exactly why
        // `AgentProposal.stepSeq` carries no unique constraint. A lookup that
        // took the first match would pass any single-proposal fixture.
        const [row] = projectRunSteps(undefined, [step()], [
            proposal({ id: 'p1' }),
            proposal({ id: 'p2' }),
        ]);
        expect(row.proposals.map((p) => p.id)).toEqual(['p1', 'p2']);
    });

    it('puts each proposal on its OWN step, not on all of them', () => {
        const rows = projectRunSteps(undefined, [step({ seq: 0 }), step({ id: 's2', seq: 1 })], [
            proposal({ id: 'p0', stepSeq: 0 }),
            proposal({ id: 'p1', stepSeq: 1 }),
        ]);
        expect(rows[0].proposals.map((p) => p.id)).toEqual(['p0']);
        expect(rows[1].proposals.map((p) => p.id)).toEqual(['p1']);
    });

    it('drops a proposal that names NO step rather than attaching it to seq 0', () => {
        // `stepSeq: null` is a proposal nothing in the run claims. Grouping it
        // under `0` would hang somebody else's write on the first step.
        const [row] = projectRunSteps(undefined, [step()], [proposal({ stepSeq: null })]);
        expect(row.proposals).toEqual([]);
    });

    it('a step with no proposals gets an empty list, never undefined', () => {
        const [row] = projectRunSteps(undefined, [step()], []);
        expect(row.proposals).toEqual([]);
    });

    it('serialises `at` as an ISO string, because a Date does not survive the wire', () => {
        const [row] = projectRunSteps(undefined, [step()], []);
        expect(row.at).toBe('2026-10-14T00:00:00.000Z');
    });

    it('carries the recorded tool, and derives a scope from it', () => {
        const [row] = projectRunSteps(undefined, [step()], []);
        expect(row.tool).toBe('get_framework_status');
        expect(row.scope).not.toBeNull();
    });

    it('a step that names no tool has a NULL scope, not a "NONE" rung', () => {
        // A synthesis reaches no tenant data by construction. A chip reading
        // NONE there would imply a rung was evaluated when none was.
        const [row] = projectRunSteps(undefined, [step({ kind: 'SYNTHESIS', toolCalled: null })], []);
        expect(row.tool).toBeNull();
        expect(row.scope).toBeNull();
    });

    it('keeps NULL and CLEAN as different guard facts', () => {
        const [nullish] = projectRunSteps(undefined, [step({ guardVerdict: null })], []);
        const [clean] = projectRunSteps(undefined, [step({ guardVerdict: 'CLEAN' })], []);
        expect(nullish.guardVerdict).toBeNull();
        expect(clean.guardVerdict).toBe('CLEAN');
    });

    it('passes inputJson through VERBATIM, malformed or not', () => {
        // The client renders it as text inside a disclosure and never
        // interprets it; a parse here would move a malformed blob's failure
        // from a collapsed panel to the whole page.
        const raw = '{not valid json';
        const [row] = projectRunSteps(undefined, [step({ inputJson: raw })], []);
        expect(row.inputJson).toBe(raw);
        expect(row.decisionDigest).toBeNull();
    });
});

describe('decisionDigestOf', () => {
    const DIGEST = `sha256:${'a'.repeat(64)}`;

    it('reads a well-formed digest back', () => {
        expect(decisionDigestOf(JSON.stringify({ decisionDigest: DIGEST }))).toBe(DIGEST);
    });

    it('refuses anything that is not sha256:<64 hex>', () => {
        // SHAPE-checked, not merely present: this value goes into a query
        // string, and the decisions page can do nothing with another shape.
        for (const bad of [
            'sha256:short',
            `sha256:${'g'.repeat(64)}`,
            `md5:${'a'.repeat(64)}`,
            'a'.repeat(64),
            `sha256:${'a'.repeat(65)}`,
        ]) {
            expect(decisionDigestOf(JSON.stringify({ decisionDigest: bad }))).toBeNull();
        }
    });

    it('returns null for a non-string, a missing field, a non-object and null input', () => {
        expect(decisionDigestOf(JSON.stringify({ decisionDigest: 42 }))).toBeNull();
        expect(decisionDigestOf(JSON.stringify({}))).toBeNull();
        expect(decisionDigestOf(JSON.stringify('a string'))).toBeNull();
        expect(decisionDigestOf(null)).toBeNull();
    });

    it('swallows a parse failure rather than throwing into the page', () => {
        expect(decisionDigestOf('{')).toBeNull();
    });
});

describe('isLiveRunStatus', () => {
    it('a run that can still produce steps is live', () => {
        for (const s of ['RUNNING', 'PENDING', 'PAUSED', 'AWAITING_APPROVAL']) {
            expect(isLiveRunStatus(s)).toBe(true);
        }
    });

    it('a terminal run is not — the tail closes and replay takes over', () => {
        for (const s of ['COMPLETED', 'FAILED', 'ABORTED', 'HALTED']) {
            expect(isLiveRunStatus(s)).toBe(false);
        }
    });

    it('an unrecognised status is NOT live — a tail must not hold a connection for a state it cannot read', () => {
        // Fails closed on purpose. The alternative, treating unknown as live,
        // holds a database poll open forever for a status somebody added
        // without telling this module.
        expect(isLiveRunStatus('SOMETHING_NEW')).toBe(false);
    });
});
