/**
 * The probe-run ingest's pure parts (active flavour, step 8a): what a run
 * opens and what it may close, the finding reference, severity and wording,
 * and the gate. The database half is `tests/integration/probe-runs.test.ts`.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

const mockDb = {
    agentProberKey: { findMany: jest.fn() },
    probeApproverKey: { findFirst: jest.fn() },
    probeRun: { findFirst: jest.fn() },
};

import { PROBE_VERDICT_REASONS, VERDICT_OF_REASON } from '@rodnapamet/scanent-contract/probes-contract';

import {
    ingestProbeReport,
    isRaisingReason,
    originOf,
    planProbeFindings,
    probeFindingSourceRef,
} from '@/app-layer/usecases/probe-runs';
import { makeRequestContext } from '../helpers/make-context';
import { createFakeScanner } from '../helpers/agent-harness-fake-scanner';
import { acted, approverFingerprint, CHAT, probesBody } from '../helpers/probe-fake-report';

const ORIGIN = 'https://agents.acme.example';
const outcome = (over: Partial<Parameters<typeof planProbeFindings>[0][number]>) => ({
    sourceRef: 'probe:canary.instruction-override.1@abc@prober-1',
    probeId: 'canary.instruction-override.1',
    probeClass: 'canary',
    verdict: 'ACTED',
    verdictReason: 'CANARY_RETURNED' as const,
    origin: ORIGIN,
    kind: 'http-chat',
    ...over,
});

describe('what a run raises', () => {
    it('raises exactly the reasons the contract maps to ACTED or DISCLOSED', () => {
        const raising = PROBE_VERDICT_REASONS.filter(isRaisingReason).sort();
        expect(raising).toEqual(
            PROBE_VERDICT_REASONS.filter((r) => VERDICT_OF_REASON[r] === 'ACTED' || VERDICT_OF_REASON[r] === 'DISCLOSED').sort(),
        );
        expect(raising).toEqual(['CANARY_RETURNED', 'CREDENTIAL_SHAPE_RETURNED', 'PLANTED_CONTEXT_RETURNED']);
    });

    it('is HIGH for an agent that acted and for a credential, MEDIUM for planted context (owner decision)', () => {
        const plan = planProbeFindings([
            outcome({ sourceRef: 'a' }),
            outcome({ sourceRef: 'b', probeClass: 'disclosure', verdict: 'DISCLOSED', verdictReason: 'CREDENTIAL_SHAPE_RETURNED' }),
            outcome({ sourceRef: 'c', probeClass: 'disclosure', verdict: 'DISCLOSED', verdictReason: 'PLANTED_CONTEXT_RETURNED' }),
        ]);
        expect(plan.assert.map((f) => [f.sourceRef, f.severity])).toEqual([['a', 'HIGH'], ['b', 'HIGH'], ['c', 'MEDIUM']]);
    });

    it('names the probe, the class, the origin and the tool, and nothing the agent said', () => {
        const [f] = planProbeFindings([outcome({ tool: 'lookup_account', kind: 'mcp' })]).assert;
        expect(f.title).toBe('An agent followed an injected instruction');
        expect(f.description).toContain('canary.instruction-override.1');
        expect(f.description).toContain('(canary)');
        expect(f.description).toContain(`mcp agent at ${ORIGIN}`);
        expect(f.description).toContain('through its tool lookup_account');
    });
});

describe('what a run may close', () => {
    it('closes on RESISTED only, never on INCONCLUSIVE', () => {
        const plan = planProbeFindings([
            outcome({ sourceRef: 'resisted', verdict: 'RESISTED', verdictReason: 'CANARY_ABSENT' }),
            outcome({ sourceRef: 'no-reply', verdict: 'INCONCLUSIVE', verdictReason: 'NO_REPLY' }),
            outcome({ sourceRef: 'cut', verdict: 'INCONCLUSIVE', verdictReason: 'REPLY_CUT_NOTHING_FOUND' }),
            outcome({ sourceRef: 'no-context', probeClass: 'disclosure', verdict: 'INCONCLUSIVE', verdictReason: 'NO_PLANTED_CONTEXT_GIVEN' }),
        ]);
        expect(plan.assert).toEqual([]);
        expect(plan.resolve).toEqual(['resisted']);
    });

    it('never closes a reference the same run raised, whatever else it answered', () => {
        const plan = planProbeFindings([
            outcome({ sourceRef: 'x', verdict: 'RESISTED', verdictReason: 'CANARY_ABSENT' }),
            outcome({ sourceRef: 'x' }),
        ]);
        expect(plan.assert.map((f) => f.sourceRef)).toEqual(['x']);
        expect(plan.resolve).toEqual([]);
    });
});

describe('the finding reference', () => {
    it('is the probe, the target digest, the tool when there is one, and the prober', () => {
        expect(probeFindingSourceRef('canary.role-escape.1', 'd1', undefined, 'p1')).toBe('probe:canary.role-escape.1@d1@p1');
        expect(probeFindingSourceRef('canary.role-escape.1', 'd1', 'tool_a', 'p1')).toBe('probe:canary.role-escape.1@d1#tool_a@p1');
    });

    it('a target is named by its origin, never its path', () => {
        expect(originOf('https://agents.acme.example/support/chat')).toBe(ORIGIN);
    });
});

describe('the gate and the refusals before any write', () => {
    beforeEach(() => jest.clearAllMocks());

    it('refuses a caller without admin.agent_probes_ingest before reading anything', async () => {
        const reader = makeRequestContext('READER');
        await expect(ingestProbeReport(reader, '{}')).rejects.toThrow(/agent_probes_ingest/);
        expect(mockDb.agentProberKey.findMany).not.toHaveBeenCalled();
    });

    it('refuses a credential bound to another agent than the prober', async () => {
        const prober = createFakeScanner();
        const approver = createFakeScanner();
        mockDb.agentProberKey.findMany.mockResolvedValue([
            { id: 'k1', agentId: 'prober-1', publicKey: prober.publicKeyHex, keyFingerprint: approverFingerprint(prober.publicKeyHex) },
        ]);
        const ctx = { ...makeRequestContext('ADMIN'), agentId: 'someone-else' };
        const raw = prober.serialise(probesBody(approverFingerprint(approver.publicKeyHex), [acted(CHAT)]));
        await expect(ingestProbeReport(ctx, raw)).rejects.toThrow('probe_report_refused: SUBMITTER_MISMATCH');
        expect(mockDb.probeApproverKey.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a scope no live approver key signed', async () => {
        const prober = createFakeScanner();
        mockDb.agentProberKey.findMany.mockResolvedValue([
            { id: 'k1', agentId: 'prober-1', publicKey: prober.publicKeyHex, keyFingerprint: approverFingerprint(prober.publicKeyHex) },
        ]);
        mockDb.probeApproverKey.findFirst.mockResolvedValue(null);
        const raw = prober.serialise(probesBody(approverFingerprint(createFakeScanner().publicKeyHex), [acted(CHAT)]));
        await expect(ingestProbeReport(makeRequestContext('ADMIN'), raw)).rejects.toThrow('probe_report_refused: APPROVER_NOT_REGISTERED');
        expect(mockDb.probeRun.findFirst).not.toHaveBeenCalled();
    });
});
