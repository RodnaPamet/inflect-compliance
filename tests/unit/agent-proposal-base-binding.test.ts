/**
 * An approval is bound to the DIFF THE REVIEWER READ, not to the proposal id.
 *
 * ═══ THE FAILURE THIS LOCKS OUT ═══
 *
 * Rendering a diff is only half of human oversight. The other half is that the
 * approval which follows applies the change the reviewer looked at. Without a
 * binding, the sequence
 *
 *     reviewer opens the queue   -> diff computed against likelihood = 4
 *     somebody edits the record  -> likelihood is now 9
 *     reviewer clicks Approve    -> the update applies over a base they never saw
 *
 * produces an audit row saying a human approved a delta that never existed. A
 * diff against a stale base is not a smaller lie than no diff at all; it is a
 * worse one, because it reads as authoritative and the audit trail agrees.
 *
 * So `approveAgentProposal` recomputes the diff server-side and requires the
 * caller to name the base fingerprint it read. Three refusals fall out of one
 * check: no diff was read, no diff COULD be read, and the base has moved.
 *
 * CREATE proposals are exempt, and deliberately: a create has no base, so
 * `baseDigest` is null and demanding a token would be theatre.
 */
const db = {
    agentProposal: { findFirst: jest.fn(), updateMany: jest.fn() },
    risk: { findMany: jest.fn() },
    control: { findMany: jest.fn() },
    policy: { findMany: jest.fn() },
    finding: { findMany: jest.fn() },
};

const createRisk = jest.fn(async () => ({ id: 'risk-new' }));
const updateRisk = jest.fn(async () => ({ id: 'risk-77' }));

jest.mock('@/lib/db/rls-middleware', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/app-layer/usecases/risk', () => ({
    createRisk: (...a: unknown[]) => createRisk(...(a as [])),
    updateRisk: (...a: unknown[]) => updateRisk(...(a as [])),
}));
jest.mock('@/app-layer/usecases/control/mutations', () => ({
    createControl: jest.fn(),
    updateControl: jest.fn(),
}));
jest.mock('@/app-layer/usecases/policy', () => ({ createPolicy: jest.fn() }));
jest.mock('@/app-layer/usecases/finding', () => ({
    createFinding: jest.fn(),
    updateFinding: jest.fn(),
}));
jest.mock('@/lib/audit', () => ({ appendAuditEntry: jest.fn(async () => undefined) }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('@/app-layer/ai/guard', () => ({
    guardUntrustedInput: jest.fn(async () => ({ allowed: true })),
    guardEgress: jest.fn(async () => ({ allowed: true })),
    assertGuardAllowed: jest.fn(),
}));

import { approveAgentProposal,
    wasApplied,
} from '@/app-layer/usecases/agent-proposals';
import { computeProposalDiff } from '@/lib/agentic/proposal-diff';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'reviewer-1' });

/** The record as it stood when the reviewer's page rendered. */
const BASE_AT_REVIEW = { id: 'risk-77', tenantId: 't1', title: 'Backup risk', likelihood: 4 };
const PROPOSED = { title: 'Backup risk', likelihood: 9 };

function updateProposal() {
    return {
        id: 'p-update',
        tenantId: 't1',
        status: 'PENDING',
        kind: 'RISK',
        operation: 'UPDATE',
        targetEntityId: 'risk-77',
        payloadJson: JSON.stringify(PROPOSED),
        proposedViaKeyId: 'k1',
    };
}

/** The fingerprint the review UI would have shipped to the client. */
function digestAgainst(target: Record<string, unknown> | null): string | null {
    return computeProposalDiff({
        operation: 'UPDATE',
        payloadJson: JSON.stringify(PROPOSED),
        target,
    }).baseDigest;
}

beforeEach(() => {
    jest.clearAllMocks();
    db.agentProposal.findFirst.mockResolvedValue(updateProposal());
    db.agentProposal.updateMany.mockResolvedValue({ count: 1 });
    db.risk.findMany.mockResolvedValue([BASE_AT_REVIEW]);
    db.control.findMany.mockResolvedValue([]);
    db.policy.findMany.mockResolvedValue([]);
    db.finding.findMany.mockResolvedValue([]);
});

describe('an UPDATE cannot be approved without naming the base that was read', () => {
    it('refuses an approval that carries no baseDigest at all', async () => {
        const err = await approveAgentProposal(ctx, 'p-update').catch(
            (e: Error & { code?: string }) => e,
        );

        // The CODE, not just a message match. Deleting the guard made this
        // assertion pass on a TypeError whose text happened to contain the word
        // `baseDigest` - a refusal by crash, which is not the refusal claimed
        // and would surface as a 500. Pinning the domain error is what makes
        // this a check on the guard rather than on a substring.
        expect(err).toBeInstanceOf(Error);
        expect((err as { code?: string }).code).toBe('BAD_REQUEST');
        expect((err as Error).message).toMatch(/requires the baseDigest of the diff/);

        // Nothing was applied AND nothing was claimed - a refusal that burned
        // the proposal would turn a missing token into a lost proposal.
        expect(updateRisk).not.toHaveBeenCalled();
        expect(db.agentProposal.updateMany).not.toHaveBeenCalled();
    });

    it('refuses with STALE_DATA when the record moved since the diff was read', async () => {
        const staleDigest = digestAgainst({ ...BASE_AT_REVIEW, likelihood: 4 });
        // The record has since moved to 5. The reviewer's token still describes
        // the 4 they read.
        db.risk.findMany.mockResolvedValue([{ ...BASE_AT_REVIEW, likelihood: 5 }]);

        const err = await approveAgentProposal(ctx, 'p-update', {
            baseDigest: staleDigest ?? undefined,
        }).catch((e: Error & { code?: string; status?: number }) => e);

        expect(err).toBeInstanceOf(Error);
        expect((err as { code?: string }).code).toBe('STALE_DATA');
        expect(updateRisk).not.toHaveBeenCalled();
    });

    it('refuses when the target has been deleted, before any freshness check', async () => {
        db.risk.findMany.mockResolvedValue([]);

        await expect(
            approveAgentProposal(ctx, 'p-update', { baseDigest: 'sha256:anything' }),
        ).rejects.toThrow(/TARGET_MISSING/);

        expect(updateRisk).not.toHaveBeenCalled();
        expect(db.agentProposal.updateMany).not.toHaveBeenCalled();
    });
});

describe('an UPDATE approved against the base that was read applies', () => {
    it('runs the real update-usecase against the named target', async () => {
        const digest = digestAgainst(BASE_AT_REVIEW);

        const result = await approveAgentProposal(ctx, 'p-update', {
            baseDigest: digest ?? undefined,
        });

        expect(updateRisk).toHaveBeenCalledTimes(1);
        const [, targetId, data] = updateRisk.mock.calls[0] as unknown as [
            unknown,
            string,
            Record<string, unknown>,
        ];
        expect(targetId).toBe('risk-77');
        expect(data.likelihood).toBe(9);
        // The proposal resolves to the record it CHANGED, not to a new one.
        // Narrowed first: an approval that only recorded a signature applies
        // nothing, and asserting an id off that arm would assert about a null.
        if (!wasApplied(result)) throw new Error('expected the proposal to be applied');
        expect(result.createdEntityId).toBe('risk-77');
        expect(result.operation).toBe('UPDATE');
        // And no create path was touched - an update that also created would be
        // the duplicate-record failure in a new costume.
        expect(createRisk).not.toHaveBeenCalled();
    });
});

describe('a CREATE proposal is exempt, because it has no base', () => {
    it('approves with no baseDigest and runs the create-usecase', async () => {
        db.agentProposal.findFirst.mockResolvedValue({
            id: 'p-create',
            tenantId: 't1',
            status: 'PENDING',
            kind: 'RISK',
            operation: 'CREATE',
            targetEntityId: null,
            payloadJson: JSON.stringify({ title: 'A brand new risk' }),
            proposedViaKeyId: 'k1',
        });

        const result = await approveAgentProposal(ctx, 'p-create');

        expect(createRisk).toHaveBeenCalledTimes(1);
        expect(updateRisk).not.toHaveBeenCalled();
        if (!wasApplied(result)) throw new Error('expected the proposal to be applied');
        expect(result.operation).toBe('CREATE');
        expect(result.createdEntityId).toBe('risk-new');
    });
});
