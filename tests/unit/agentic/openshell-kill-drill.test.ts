/**
 * 5.4 (#3974) — "a test proves the deletion actually happened rather than that
 * the call returned".
 *
 * That sentence names a specific regression, and these fakes are built to
 * produce it. The honest transport and the lying one are IDENTICAL except for
 * `awaitDeleted`: both report `DELETION_OUTCOME_COMPLETED`, so any verdict that
 * differs between them is attributable to the absence check and to nothing
 * else. A test that only showed the honest case passing would be satisfied by
 * an implementation that trusted the outcome, which is what `executor.ts`
 * deliberately does on the tool path.
 */
import {
    drillSandboxDeletion,
    KILL_DRILL_LABEL,
    SANDBOX_DRILL_OUTCOMES,
} from '@/lib/agentic/openshell/kill-drill';
import {
    unconfiguredTransport,
    type DeletionOutcome,
    type SandboxTransport,
} from '@/lib/agentic/openshell/transport';

const TIMEOUT_MS = 30;

/** Resolves when the signal aborts, so a "present" sandbox costs one timeout. */
const neverAbsent = (signal: AbortSignal): Promise<void> =>
    new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });

interface FakeOptions {
    readonly deleteOutcome?: DeletionOutcome;
    readonly absent?: boolean;
    readonly deleteThrows?: Error;
    readonly onCreate?: (labels: Readonly<Record<string, string>> | undefined) => void;
}

const fake = (opts: FakeOptions = {}): SandboxTransport => ({
    createSandbox: async ({ labels }) => {
        opts.onCreate?.(labels);
        return { id: 'sbx-drill-1', phase: 'SANDBOX_PHASE_READY' } as never;
    },
    execSandbox: async () => {
        throw new Error('the drill never execs');
    },
    deleteSandbox: async () => {
        if (opts.deleteThrows) throw opts.deleteThrows;
        return { outcome: opts.deleteOutcome ?? 'DELETION_OUTCOME_COMPLETED' } as never;
    },
    awaitDeleted: async ({ signal }) => {
        if (opts.absent ?? true) return;
        await neverAbsent(signal);
    },
});

describe('the kill-switch drill proves a sandbox is absent, not that delete returned', () => {
    it('passes when the sandbox is deleted and confirmed gone', async () => {
        const r = await drillSandboxDeletion(fake(), TIMEOUT_MS);
        expect(r.outcome).toBe('deleted_and_absent');
        expect(r.sandboxId).toBe('sbx-drill-1');
    });

    it('FAILS when delete reports COMPLETED and the sandbox is still there', async () => {
        // The regression this arm exists for. An implementation that trusted
        // `DELETION_IS_SETTLED` — as the tool path does, correctly, for its own
        // reasons — returns `deleted_and_absent` here.
        const r = await drillSandboxDeletion(
            fake({ deleteOutcome: 'DELETION_OUTCOME_COMPLETED', absent: false }),
            TIMEOUT_MS,
        );
        expect(r.outcome).toBe('delete_returned_but_sandbox_present');
        expect(r.reportedOutcome).toBe('DELETION_OUTCOME_COMPLETED');
        // The detail must name BOTH halves, or the evidence row cannot explain
        // why a success was scored a failure.
        expect(r.detail).toContain('DELETION_OUTCOME_COMPLETED');
        expect(r.detail).toContain('not absent');
    });

    it('the honest and lying transports differ ONLY in absence — the control', async () => {
        // Both report the same settled outcome, so the two verdicts below cannot
        // be explained by anything the delete call said.
        const honest = await drillSandboxDeletion(
            fake({ deleteOutcome: 'DELETION_OUTCOME_COMPLETED', absent: true }),
            TIMEOUT_MS,
        );
        const lying = await drillSandboxDeletion(
            fake({ deleteOutcome: 'DELETION_OUTCOME_COMPLETED', absent: false }),
            TIMEOUT_MS,
        );
        expect(honest.reportedOutcome).toBe(lying.reportedOutcome);
        expect(honest.outcome).not.toBe(lying.outcome);
    });

    it.each([
        ['ACCEPTED — admitted, not performed', 'DELETION_OUTCOME_ACCEPTED'],
        ['the zero value, which carries no assurance', 'DELETION_OUTCOME_UNSPECIFIED'],
        ['ALREADY_ABSENT, which is settled and still verified', 'DELETION_OUTCOME_ALREADY_ABSENT'],
    ] as const)('a sandbox that never goes absent fails on %s', async (_label, outcome) => {
        const r = await drillSandboxDeletion(
            fake({ deleteOutcome: outcome as DeletionOutcome, absent: false }),
            TIMEOUT_MS,
        );
        expect(r.outcome).toBe('delete_returned_but_sandbox_present');
    });

    it.each([
        ['DELETION_OUTCOME_ACCEPTED'],
        ['DELETION_OUTCOME_UNSPECIFIED'],
    ] as const)('and passes on %s once absence is confirmed', async (outcome) => {
        const r = await drillSandboxDeletion(
            fake({ deleteOutcome: outcome as DeletionOutcome, absent: true }),
            TIMEOUT_MS,
        );
        expect(r.outcome).toBe('deleted_and_absent');
    });

    it('records delete_refused when the delete call itself throws', async () => {
        const r = await drillSandboxDeletion(
            fake({ deleteThrows: new Error('permission denied') }),
            TIMEOUT_MS,
        );
        expect(r.outcome).toBe('delete_refused');
        expect(r.detail).toContain('permission denied');
        // The sandbox id survives a refusal, because that is the leak somebody
        // has to chase.
        expect(r.sandboxId).toBe('sbx-drill-1');
    });

    it('is NOT a pass when no runtime answers', async () => {
        // This build ships `unconfiguredTransport`, so this is the production
        // path today. It must not read as a drilled control.
        const r = await drillSandboxDeletion(unconfiguredTransport, TIMEOUT_MS);
        expect(r.outcome).toBe('not_exercised_unreachable');
        expect(r.outcome).not.toBe('deleted_and_absent');
        expect(r.sandboxId).toBeNull();
        expect(r.detail).toContain('no transport is configured');
    });

    it('stamps its own label on the sandbox it creates', async () => {
        // So a leaked drill sandbox is attributable to the drill rather than to
        // a tool run.
        let seen: Readonly<Record<string, string>> | undefined;
        await drillSandboxDeletion(fake({ onCreate: (l) => void (seen = l) }), TIMEOUT_MS);
        expect(seen?.[KILL_DRILL_LABEL]).toBe('true');
    });

    it('every declared outcome is reachable by some case above', async () => {
        // The denominator. A fifth outcome added to the union and never produced
        // would be a state the drill can report and no test has seen.
        const produced = new Set<string>();
        produced.add((await drillSandboxDeletion(fake(), TIMEOUT_MS)).outcome);
        produced.add((await drillSandboxDeletion(fake({ absent: false }), TIMEOUT_MS)).outcome);
        produced.add(
            (await drillSandboxDeletion(fake({ deleteThrows: new Error('x') }), TIMEOUT_MS)).outcome,
        );
        produced.add((await drillSandboxDeletion(unconfiguredTransport, TIMEOUT_MS)).outcome);
        expect([...produced].sort()).toEqual([...SANDBOX_DRILL_OUTCOMES].sort());
    });
});
