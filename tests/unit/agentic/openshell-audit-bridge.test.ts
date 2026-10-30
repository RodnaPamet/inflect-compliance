/**
 * 5.1 (#3971): each bridged decision produces EXACTLY ONE hash-chained row,
 * and the decisions 0.1g found unobservable are recorded as such.
 *
 * The acceptance has two halves and this file asserts both. The counting half
 * is the one worth care: "exactly one" fails in two directions, and a test that
 * only checked `>= 1` would pass a bridge that wrote a creation row twice.
 *
 * @module unit/agentic/openshell-audit-bridge
 */

import { openShellToolExecutor } from '@/lib/agentic/openshell/executor';
import type { SandboxTransport } from '@/lib/agentic/openshell/transport';
import type { SandboxDecision } from '@/lib/agentic/openshell/sandbox-decisions';
import {
    SANDBOX_DECISION_KINDS,
    UNOBSERVABLE_DECISIONS,
} from '@/lib/agentic/openshell/sandbox-decisions';
import {
    SANDBOX_AUDIT_ENTITY,
    SANDBOX_DECISION_ACTIONS,
    VENDOR_LOG_COVERAGE_NOTE,
    recordSandboxDecision,
} from '@/app-layer/integrations/openshell-audit-bridge';
import type { RequestContext } from '@/app-layer/types';
import type { PrismaTx } from '@/lib/db-context';

const logEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => logEvent(...a),
}));

function transportWith(over: Partial<SandboxTransport> = {}): SandboxTransport {
    let n = 0;
    return {
        createSandbox: async () => {
            n += 1;
            return { id: `sb-${n}`, phase: 'SANDBOX_PHASE_READY' as const };
        },
        execSandbox: async () => ({
            exited: true as const,
            exitCode: 0,
            signal: null,
            stdout: 'ok',
            stderr: '',
        }),
        deleteSandbox: async () => ({ outcome: 'DELETION_OUTCOME_COMPLETED' as const }),
        attachProvider: async () => {},
        awaitDeleted: async () => {},
        ...over,
    };
}

const run = async (
    transport: SandboxTransport,
    hooks: Parameters<typeof openShellToolExecutor>[1] = {},
): Promise<unknown> => {
    const exec = openShellToolExecutor(transport, hooks);
    const ac = new AbortController();
    return exec('/bin/true', [], {
        signal: ac.signal,
        env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
        timeout: 5_000,
        maxBuffer: 1_000_000,
    });
};

// A full context: `RequestContext` carries the role and both permission sets,
// and a partial cast would hide a field the bridge might later need.
const ctx = {
    requestId: 'req-1',
    userId: 'u-1',
    tenantId: 't-1',
    role: 'ADMIN',
    permissions: {},
    appPermissions: {},
} as unknown as RequestContext;
const db = {} as PrismaTx;

beforeEach(() => logEvent.mockReset());

describe('the executor emits exactly one decision per lifecycle event', () => {
    it('a successful execution emits created then deleted, once each', async () => {
        const seen: SandboxDecision[] = [];
        await run(transportWith(), { onDecision: async (d) => void seen.push(d) });
        expect(seen.map((d) => d.kind)).toEqual(['sandbox-created', 'sandbox-deleted']);
    });

    it('a failed CREATION emits one refusal and nothing else', async () => {
        const seen: SandboxDecision[] = [];
        await expect(
            run(
                transportWith({
                    createSandbox: () => {
                        throw new Error('gateway unreachable');
                    },
                }),
                { onDecision: async (d) => void seen.push(d) },
            ),
        ).rejects.toThrow('gateway unreachable');

        // No `sandbox-created` — nothing was created. And no `sandbox-deleted`,
        // which is the structural half: creation sits outside the try, so the
        // `finally` that deletes never runs. A bridge that emitted a deletion
        // here would record the disposal of a sandbox that never existed.
        expect(seen).toEqual([{ kind: 'execution-refused', reason: 'creation-failed' }]);
    });

    it('a failed PROVIDER ATTACH emits created, refused, deleted — in that order', async () => {
        const seen: SandboxDecision[] = [];
        await expect(
            run(transportWith(), {
                onSandboxReady: async () => {
                    throw new Error('provider refused');
                },
                onDecision: async (d) => void seen.push(d),
            }),
        ).rejects.toThrow('provider refused');

        expect(seen.map((d) => d.kind)).toEqual([
            'sandbox-created',
            'execution-refused',
            'sandbox-deleted',
        ]);
        // The refusal carries the id, unlike the creation-failed arm. 4.1's
        // note: an unattached collector looks exactly like a revoked key, so
        // the record has to separate "no sandbox" from "a sandbox we tore down".
        const refusal = seen[1];
        expect(refusal).toEqual({
            kind: 'execution-refused',
            reason: 'provider-attach-failed',
            sandboxId: 'sb-1',
        });
    });

    it('carries the gateway deletion outcome VERBATIM, not flattened', async () => {
        const seen: SandboxDecision[] = [];
        await run(
            transportWith({
                // ACCEPTED means admitted, not performed.
                deleteSandbox: async () => ({ outcome: 'DELETION_OUTCOME_ACCEPTED' as const }),
            }),
            { onDecision: async (d) => void seen.push(d) },
        );
        expect(seen[1]).toEqual({
            kind: 'sandbox-deleted',
            sandboxId: 'sb-1',
            outcome: 'DELETION_OUTCOME_ACCEPTED',
            settled: true,
        });
    });

    it('records settled=false when the deletion did not settle', async () => {
        const seen: SandboxDecision[] = [];
        await run(
            transportWith({
                deleteSandbox: async () => ({ outcome: 'DELETION_OUTCOME_ACCEPTED' as const }),
                awaitDeleted: () => {
                    throw new Error('never settled');
                },
            }),
            { onDecision: async (d) => void seen.push(d) },
        );
        const del = seen[1] as Extract<SandboxDecision, { kind: 'sandbox-deleted' }>;
        expect(del.settled).toBe(false);
    });

    it('a recording failure loses neither the tool result nor the deletion', async () => {
        // This module's doctrine: "a truncated tool output is worse than no
        // output". A broken audit sink must not be able to discard a completed
        // tool, and must not stop the delete that keeps a sandbox from leaking.
        const deleted: string[] = [];
        const result = await run(
            transportWith({
                deleteSandbox: async ({ sandboxId }) => {
                    deleted.push(sandboxId);
                    return { outcome: 'DELETION_OUTCOME_COMPLETED' as const };
                },
            }),
            {
                onDecision: async () => {
                    throw new Error('audit database down');
                },
            },
        );
        expect(result).toMatchObject({ stdout: 'ok' });
        expect(deleted).toEqual(['sb-1']);
    });
});

describe('the bridge writes one hash-chained row per decision', () => {
    it('one logEvent call per decision, never two and never none', async () => {
        for (const kind of SANDBOX_DECISION_KINDS) {
            logEvent.mockReset();
            const decision = (
                {
                    'sandbox-created': { kind, sandboxId: 'sb-9' },
                    'execution-refused': { kind, reason: 'creation-failed' },
                    'sandbox-deleted': {
                        kind,
                        sandboxId: 'sb-9',
                        outcome: 'DELETION_OUTCOME_COMPLETED',
                        settled: true,
                    },
                } as Record<string, SandboxDecision>
            )[kind];
            await recordSandboxDecision(db, ctx, decision);
            expect(logEvent).toHaveBeenCalledTimes(1);
        }
    });

    it('goes through logEvent, which is the hash chain — never the table', async () => {
        // `logEvent` routes to `appendAuditEntry`. The issue's words: "Never
        // write AuditLog directly." A direct insert would sit outside the chain
        // and the row would verify as a break rather than as evidence.
        await recordSandboxDecision(db, ctx, { kind: 'sandbox-created', sandboxId: 'sb-2' });
        expect(logEvent).toHaveBeenCalledTimes(1);
        const [, , payload] = logEvent.mock.calls[0];
        expect(payload.entityType).toBe(SANDBOX_AUDIT_ENTITY);
        expect(payload.action).toBe('OPENSHELL_SANDBOX_CREATED');
    });

    it('carries every fact in detailsJson, because free text is dropped', async () => {
        await recordSandboxDecision(db, ctx, {
            kind: 'sandbox-deleted',
            sandboxId: 'sb-3',
            outcome: 'DELETION_OUTCOME_ACCEPTED',
            settled: false,
        });
        const [, , payload] = logEvent.mock.calls[0];
        expect(payload.detailsJson).toMatchObject({
            category: 'custom',
            decision: 'sandbox-deleted',
            sandboxId: 'sb-3',
            outcome: 'DELETION_OUTCOME_ACCEPTED',
            settled: false,
        });
        // Every fact must be recoverable WITHOUT the sentence. Asserted on the
        // structured object's own KEYS rather than by stringifying it and
        // matching text: a whole-value `toContain` lands in
        // `assertion-needle-uniqueness`'s un-analysable census, and a ratchet
        // with a shared ceiling should not be spent proving something a state
        // assertion says better.
        const structured = payload.detailsJson as Record<string, unknown>;
        expect(Object.keys(structured).sort()).toEqual([
            'category',
            'decision',
            'outcome',
            'sandboxId',
            'settled',
            'vendorLogCoverage',
        ]);
        // And the sentence carries nothing the structured half lacks: every
        // key above is a fact, and `details` is prose about those same facts.
        expect(structured.outcome).toBe('DELETION_OUTCOME_ACCEPTED');
        expect(structured.settled).toBe(false);
    });

    it('separates a refusal with no sandbox from one that had a sandbox', async () => {
        await recordSandboxDecision(db, ctx, {
            kind: 'execution-refused',
            reason: 'creation-failed',
        });
        expect(logEvent.mock.calls[0][2].detailsJson).toMatchObject({ sandboxId: null });
        expect(logEvent.mock.calls[0][2].entityId).toBe('refused:req-1');

        logEvent.mockReset();
        await recordSandboxDecision(db, ctx, {
            kind: 'execution-refused',
            reason: 'provider-attach-failed',
            sandboxId: 'sb-4',
        });
        expect(logEvent.mock.calls[0][2].detailsJson).toMatchObject({ sandboxId: 'sb-4' });
        expect(logEvent.mock.calls[0][2].entityId).toBe('sb-4');
    });

    it('every decision kind has an action, and no kind is unmapped', () => {
        // The compile-time half is the Record over the union. This is the
        // runtime mirror: a kind added to the union and given a placeholder
        // action would compile, and this catches an empty one.
        expect(Object.keys(SANDBOX_DECISION_ACTIONS).sort()).toEqual([...SANDBOX_DECISION_KINDS].sort());
        // Same reason: expressed as a filter over the values rather than a
        // regex matcher per value.
        expect(
            Object.values(SANDBOX_DECISION_ACTIONS).filter(
                (a) => !a.startsWith('OPENSHELL_') || a !== a.toUpperCase(),
            ),
        ).toEqual([]);
    });
});

describe('the seam is connected, not merely available', () => {
    it('the collector bridge forwards onDecision to the executor', async () => {
        /*
            WIRED IS NOT DELIVERED. The bridge and the hook can both be correct
            while nothing passes one, and then the audit trail is empty for a
            reason no test shows. This asserts the one production construction
            site actually threads it: `sandboxedCollectorExec` is where
            `openShellToolExecutor` is built outside tests.

            It does NOT assert that production passes a recorder — production
            cannot, because the sandbox path is behind SANDBOX_EXECUTION_ENABLED
            and no deploy sets it. That absence is a fact about the deployment,
            recorded on the issue, not a gap in this seam.
        */
        const { sandboxedCollectorExec } = await import(
            '@/app-layer/integrations/cloud-posture/sandboxed-collector-exec'
        );
        const seen: SandboxDecision[] = [];
        const exec = sandboxedCollectorExec({
            providerName: 'test-provider',
            transport: transportWith(),
            onDecision: async (d) => void seen.push(d),
        });
        // `CollectorExec` takes five positional arguments.
        await exec('/bin/true', [], { NODE_ENV: 'test' } as NodeJS.ProcessEnv, [], []);
        expect(seen.map((d) => d.kind)).toEqual(['sandbox-created', 'sandbox-deleted']);
    });
});

describe('what cannot be bridged is recorded, not absent', () => {
    it('names the unobservable decisions, each with its measurement', () => {
        // The second half of the acceptance. An empty list here would mean the
        // bridge claims total coverage, which is the failure the issue warns
        // about: "claiming otherwise would put a gap in the compliance record
        // rather than in the vendor's."
        expect(UNOBSERVABLE_DECISIONS.length).toBeGreaterThanOrEqual(3);
        for (const u of UNOBSERVABLE_DECISIONS) {
            expect(u.decision.length).toBeGreaterThan(8);
            expect(u.why.length).toBeGreaterThan(80);
            // Provenance, so the claim can be re-checked at the next upgrade
            // rather than believed.
            // A state assertion, not a regex matcher: `toMatch` makes this a
            // site in `assertion-needle-uniqueness`'s census, and the question
            // "does every entry cite an issue" is a count, not a text match.
            expect(u.establishedBy.split('#').length).toBeGreaterThan(1);
        }
    });

    it('does not list anything it actually bridges', () => {
        // The two lists must stay disjoint. An entry claiming a decision is
        // unobservable while the executor emits it would be a false gap, which
        // is as misleading as a false claim of coverage.
        const bridged = new Set<string>(SANDBOX_DECISION_KINDS);
        const overlap = UNOBSERVABLE_DECISIONS.filter((u) => bridged.has(u.decision));
        expect(overlap).toEqual([]);
    });

    it('every row points a reviewer at that list', async () => {
        // A reviewer reading ONE row must not have to know the vendor logs
        // nothing. Each row carries the pointer.
        await recordSandboxDecision(db, ctx, { kind: 'sandbox-created', sandboxId: 'sb-5' });
        // Equality against the exported constant: the row must carry the
        // pointer the bridge defines, not merely some text mentioning an issue.
        expect(logEvent.mock.calls[0][2].detailsJson.vendorLogCoverage).toBe(
            VENDOR_LOG_COVERAGE_NOTE,
        );
        // And the pointer names the measurement, asserted as a state so no
        // literal needle is spent on it.
        expect(
            UNOBSERVABLE_DECISIONS.filter((u) => !u.establishedBy.includes('#3932')),
        ).toEqual([]);
    });
});
