/* eslint-disable @typescript-eslint/no-explicit-any -- a transaction double
 * shaped like the Prisma client; the file-level disable is this repo's
 * standard for the shape. */
/**
 * The retirement cascade's two functions, called directly (#3698).
 *
 * `agent-registry-usecase.test.ts` owns the ORDER retirement calls these in;
 * `agent-retirement-cascade.test.ts` (integration) owns the rows. This file owns
 * the predicates and the audit-row contract, which neither of those can isolate:
 *
 *   • every write names the tenant AND the agent, and the key revocation does
 *     NOT filter on expiry — "no key bound to a retired agent is unrevoked" must
 *     not depend on the clock;
 *   • the open ownership transfer is closed whatever its deadline: CANCELLED by
 *     the retiring actor while live, stamped EXPIRED with no actor once lapsed;
 *   • a list of ids SHORT of its write's count says so (`idsTruncated`);
 *   • the evidence effect (#3700) reaches only the agent's artefacts of the
 *     periods still OPEN, withdraws them `AGENT_RETIRED` and deletes none;
 *   • an effect that changed nothing writes no row of its own, and the summary
 *     carries every figure — including the evidence basis — exactly once.
 */

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    applyRetirementCascadeInTx,
    writeRetirementAuditRows,
} from '@/app-layer/usecases/agent-retirement-cascade';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../helpers/make-context';

const mockLogEvent = logEvent as jest.MockedFunction<typeof logEvent>;
const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'retirer-1' });

type ArtefactRow = { id: string; evidenceId: string; kind: string; periodStart: Date; sourceDigest: string };

function makeDb(
    opts: {
        transfer?: { id: string; toOwnerUserId: string; expiresAt: Date } | null;
        keyIds?: string[];
        keysRevoked?: number;
        openArtefacts?: ArtefactRow[];
    } = {},
) {
    return {
        agenticEvidenceArtefact: {
            findMany: jest.fn(async () => opts.openArtefacts ?? []),
            update: jest.fn(async () => ({})),
            updateMany: jest.fn(),
            delete: jest.fn(),
            deleteMany: jest.fn(),
        },
        evidence: {
            update: jest.fn(async () => ({})),
            delete: jest.fn(),
            deleteMany: jest.fn(),
        },
        tenantApiKey: {
            findMany: jest.fn(async () => (opts.keyIds ?? ['key-1', 'key-2']).map((id) => ({ id }))),
            count: jest.fn(async () => 1),
            updateMany: jest.fn(async () => ({ count: opts.keysRevoked ?? 2 })),
        },
        agentHarnessScannerKey: {
            findMany: jest.fn(async () => []),
            updateMany: jest.fn(async () => ({ count: 0 })),
        },
        registeredAgentTool: {
            findMany: jest.fn(async () => [{ id: 'g-1', toolName: 'list_risks' }]),
            deleteMany: jest.fn(async () => ({ count: 1 })),
        },
        agentProposal: {
            findMany: jest.fn(async () => []),
            updateMany: jest.fn(async () => ({ count: 0 })),
        },
        agentPolicyCard: { findUnique: jest.fn(async () => null) },
        agentOwnershipTransfer: {
            findFirst: jest.fn(async () => opts.transfer ?? null),
            updateMany: jest.fn(async () => ({ count: opts.transfer ? 1 : 0 })),
        },
    } as any;
}

beforeEach(() => jest.clearAllMocks());

describe('applyRetirementCascadeInTx — the predicates', () => {
    it('revokes every unrevoked key bound to the agent, expired ones included', async () => {
        const db = makeDb();
        const now = new Date();
        const effects = await applyRetirementCascadeInTx(db, ctx, 'agent-1', now);
        expect(db.tenantApiKey.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', agentId: 'agent-1', revokedAt: null },
            data: { revokedAt: now },
        });
        expect(db.registeredAgentTool.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', agentId: 'agent-1' },
        });
        expect(effects.apiKeys).toEqual({ count: 2, liveCount: 1, ids: ['key-1', 'key-2'], idsTruncated: false });
        expect(effects.ownershipTransfer).toBeNull();
    });

    it('cancels the open, live transfer by the retiring actor', async () => {
        const now = new Date();
        const db = makeDb({
            transfer: { id: 'transfer-1', toOwnerUserId: 'owner-2', expiresAt: new Date(now.getTime() + 60_000) },
        });
        const effects = await applyRetirementCascadeInTx(db, ctx, 'agent-1', now);
        const pending = { tenantId: 'tenant-1', agentId: 'agent-1', status: 'PENDING' };
        // Every PENDING row, whatever its deadline — not only the unlapsed ones.
        expect(db.agentOwnershipTransfer.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: pending }),
        );
        expect(db.agentOwnershipTransfer.updateMany).toHaveBeenCalledWith({
            where: { ...pending, id: 'transfer-1' },
            data: { status: 'CANCELLED', cancelledAt: now, cancelledByUserId: 'retirer-1' },
        });
        expect(effects.ownershipTransfer).toEqual({ transferId: 'transfer-1', toOwnerUserId: 'owner-2' });
    });

    it('stamps a lapsed open transfer EXPIRED, with no actor, and reports no cancellation', async () => {
        const now = new Date();
        const db = makeDb({
            transfer: { id: 'transfer-1', toOwnerUserId: 'owner-2', expiresAt: new Date(now.getTime() - 60_000) },
        });
        const effects = await applyRetirementCascadeInTx(db, ctx, 'agent-1', now);
        expect(db.agentOwnershipTransfer.updateMany).toHaveBeenCalledTimes(1);
        expect(db.agentOwnershipTransfer.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', agentId: 'agent-1', status: 'PENDING', id: 'transfer-1' },
            data: { status: 'EXPIRED' },
        });
        expect(effects.ownershipTransfer).toBeNull();
    });

    it('withdraws only the agent\'s per-agent artefacts of the periods still open, AGENT_RETIRED, and deletes none', async () => {
        const now = new Date('2026-10-18T12:00:00.000Z');
        const open: ArtefactRow[] = [
            { id: 'art-1', evidenceId: 'ev-1', kind: 'AGENT_ACTION_RECEIPTS_PER_AGENT', periodStart: new Date('2026-10-01T00:00:00.000Z'), sourceDigest: 'd1' },
            { id: 'art-2', evidenceId: 'ev-2', kind: 'AI_DECISION_RECORDS_PER_AGENT', periodStart: new Date('2026-10-01T00:00:00.000Z'), sourceDigest: 'd2' },
        ];
        const db = makeDb({ openArtefacts: open });
        const effects = await applyRetirementCascadeInTx(db, ctx, 'agent-1', now);

        // The read IS the scope: this tenant, this agent, CURRENT, and a period
        // that ends after the retirement — so a closed month is never read, and
        // a tenant-wide row (agentId NULL) can never match.
        expect(db.agenticEvidenceArtefact.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 'tenant-1', agentId: 'agent-1', status: 'CURRENT', periodEnd: { gt: now } },
            }),
        );
        for (const row of open) {
            expect(db.agenticEvidenceArtefact.update).toHaveBeenCalledWith({
                where: { id: row.id },
                data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawnReason: 'AGENT_RETIRED' },
            });
            expect(db.evidence.update).toHaveBeenCalledWith({
                where: { id: row.evidenceId },
                data: { content: expect.stringContaining('AGENT_RETIRED'), isArchived: true },
            });
        }
        // Withdrawn, never deleted — and never through a bulk write that could
        // reach past the rows read.
        expect(db.agenticEvidenceArtefact.delete).not.toHaveBeenCalled();
        expect(db.agenticEvidenceArtefact.deleteMany).not.toHaveBeenCalled();
        expect(db.agenticEvidenceArtefact.updateMany).not.toHaveBeenCalled();
        expect(db.evidence.delete).not.toHaveBeenCalled();
        expect(db.evidence.deleteMany).not.toHaveBeenCalled();
        expect(effects.evidenceArtefacts).toEqual({
            count: 2,
            ids: ['art-1', 'art-2'],
            idsTruncated: false,
            deferredToSweep: false,
        });

        await writeRetirementAuditRows(db, ctx, { id: 'agent-1', status: 'ACTIVE' }, effects);
        const row = mockLogEvent.mock.calls.find(([, , p]) => p.action === 'AGENT_RETIREMENT_EVIDENCE_WITHDRAWN');
        expect(row?.[2].detailsJson).toMatchObject({
            artefactIds: ['art-1', 'art-2'],
            count: 2,
            reason: 'agent_retired',
            toStatus: 'WITHDRAWN',
        });
        const cascade = (mockLogEvent.mock.calls[0][2].detailsJson as { cascade: Record<string, unknown> }).cascade;
        expect(cascade).toMatchObject({ evidenceArtefactsWithdrawn: 2, evidenceBasis: 'PER_AGENT_OPEN_PERIODS' });
    });

    it('a key list SHORT of the revocation count is flagged, though under the cap', async () => {
        // The list and the write are two statements. A list holding fewer ids
        // than rows revoked must say so — `count > cap` alone would read false.
        const db = makeDb({ keyIds: ['key-1'], keysRevoked: 2 });
        const effects = await applyRetirementCascadeInTx(db, ctx, 'agent-1', new Date());
        expect(effects.apiKeys).toMatchObject({ count: 2, ids: ['key-1'], idsTruncated: true });
    });
});

describe('writeRetirementAuditRows — one row per effect that changed something', () => {
    it('writes the summary, then rows only for what changed — and the transfer row when one was open', async () => {
        const db = makeDb({
            transfer: { id: 'transfer-1', toOwnerUserId: 'owner-2', expiresAt: new Date(Date.now() + 60_000) },
        });
        const effects = await applyRetirementCascadeInTx(db, ctx, 'agent-1', new Date());
        const summary = await writeRetirementAuditRows(db, ctx, { id: 'agent-1', status: 'ACTIVE' }, effects);

        expect(mockLogEvent.mock.calls.map(([, , p]) => p.action)).toEqual([
            'AGENT_RETIRED',
            'AGENT_RETIREMENT_KEYS_REVOKED',
            'AGENT_RETIREMENT_TOOLS_DROPPED',
            'AGENT_RETIREMENT_OWNERSHIP_TRANSFER_CANCELLED',
        ]);
        expect(summary).toEqual({
            apiKeysRevoked: 2,
            liveApiKeysRevoked: 1,
            scannerKeysRevoked: 0,
            toolGrantsDropped: 1,
            proposalsExpired: 0,
            policyCardFrozenAtVersion: null,
            ownershipTransferCancelled: 'transfer-1',
            evidenceArtefactsWithdrawn: 0,
            evidenceBasis: 'PER_AGENT_OPEN_PERIODS',
        });
        const transferRow = mockLogEvent.mock.calls[3][2].detailsJson as Record<string, unknown>;
        expect(transferRow).toMatchObject({ transferId: 'transfer-1', targetUserId: 'owner-2', reason: 'agent_retired' });
    });

    it('with no open transfer there is no transfer row, and the summary says null once', async () => {
        const db = makeDb();
        const effects = await applyRetirementCascadeInTx(db, ctx, 'agent-1', new Date());
        await writeRetirementAuditRows(db, ctx, { id: 'agent-1', status: 'ACTIVE' }, effects);
        const actions = mockLogEvent.mock.calls.map(([, , p]) => p.action);
        expect(actions).not.toContain('AGENT_RETIREMENT_OWNERSHIP_TRANSFER_CANCELLED');
        // Nothing open to withdraw, so no evidence row — its zero is on the summary.
        expect(actions).not.toContain('AGENT_RETIREMENT_EVIDENCE_WITHDRAWN');
        expect(actions).toContain('AGENT_RETIRED');
        const cascade = (mockLogEvent.mock.calls[0][2].detailsJson as { cascade: Record<string, unknown> }).cascade;
        expect(cascade.ownershipTransferCancelled).toBeNull();
    });
});
