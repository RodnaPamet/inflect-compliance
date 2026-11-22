/**
 * The approval half of a PROCESS_MAP proposal that touches the database
 * (#5053): the audited `processes.edit` check and the creation.
 *
 * `assertPermission` and `createProcessMapWithGraph` are mocked at their
 * seams; `tests/integration/agent-proposal-process-map.test.ts` runs both
 * against a real database through `approveAgentProposal`. This file pins what
 * the usecase itself adds: WHICH key it asks, that a refusal keeps its 403 and
 * gains a `details.reason` the review surfaces word, that any other failure
 * is not dressed up as that refusal, and that creation passes the prepared map
 * through untouched with the proposal named.
 */
jest.mock('@/lib/security/assert-permission', () => ({
    assertPermission: jest.fn(),
}));
jest.mock('@/app-layer/usecases/process-map', () => ({
    createProcessMapWithGraph: jest.fn(),
}));

import {
    PROCESS_MAP_APPROVER_NEEDS_PROCESSES_EDIT,
    applyApprovedProcessMap,
    assertMayApproveProcessMap,
} from '@/app-layer/usecases/process-map-proposal';
import { assertPermission } from '@/lib/security/assert-permission';
import { createProcessMapWithGraph } from '@/app-layer/usecases/process-map';
import { forbidden } from '@/lib/errors/types';
import { prepareProcessMapApproval } from '@/lib/processes/proposed-map-read';
import {
    ProposedProcessMapSchema,
    canonicaliseProposedProcessMap,
} from '@/lib/agentic/process-map-proposal';
import { makeRequestContext } from '../helpers/make-context';

const mockAssertPermission = assertPermission as jest.MockedFunction<typeof assertPermission>;
const mockCreate = createProcessMapWithGraph as jest.MockedFunction<typeof createProcessMapWithGraph>;

const ctx = makeRequestContext('EDITOR', { tenantId: 't1', userId: 'u1' });

beforeEach(() => {
    jest.clearAllMocks();
});

async function caught(p: Promise<unknown>): Promise<{ status?: number; reason?: unknown; message: string }> {
    try {
        await p;
    } catch (e) {
        const err = e as { status?: number; message: string; details?: { reason?: unknown } };
        return { status: err.status, reason: err.details?.reason, message: err.message };
    }
    throw new Error('expected a refusal, and the call succeeded');
}

describe('assertMayApproveProcessMap', () => {
    it('asks processes.edit, on the approve route, and passes when it is held', async () => {
        mockAssertPermission.mockResolvedValueOnce(undefined);
        await expect(assertMayApproveProcessMap(ctx, 'prop-1')).resolves.toBeUndefined();
        expect(mockAssertPermission).toHaveBeenCalledTimes(1);
        expect(mockAssertPermission).toHaveBeenCalledWith(ctx, 'processes.edit', {
            method: 'POST',
            path: '/api/t/:slug/agent-proposals/prop-1/approve',
        });
    });

    it('re-throws a denial as a 403 carrying the reason the review surfaces word', async () => {
        // `assertPermission` has already written the AUTHZ_DENIED row by now.
        mockAssertPermission.mockRejectedValueOnce(forbidden('Permission denied'));
        const r = await caught(assertMayApproveProcessMap(ctx, 'prop-1'));
        expect([r.status, r.reason]).toEqual([403, PROCESS_MAP_APPROVER_NEEDS_PROCESSES_EDIT]);
        expect(PROCESS_MAP_APPROVER_NEEDS_PROCESSES_EDIT).toBe('PROCESS_MAP_APPROVER_NEEDS_PROCESSES_EDIT');
    });

    it('does not dress any other failure up as the permission refusal', async () => {
        mockAssertPermission.mockRejectedValueOnce(new Error('audit write failed'));
        const r = await caught(assertMayApproveProcessMap(ctx, 'prop-1'));
        expect(r.message).toBe('audit write failed');
        expect(r.reason).toBeUndefined();
    });
});

describe('applyApprovedProcessMap', () => {
    const payloadJson = JSON.stringify(
        canonicaliseProposedProcessMap(
            ProposedProcessMapSchema.parse({
                name: 'Joiner onboarding',
                description: 'From signed offer to first-day access.',
                nodes: [
                    { nodeKey: 'offer', label: 'Offer signed' },
                    { nodeKey: 'check', nodeType: 'decision', label: 'Background check passed?' },
                ],
                edges: [{ sourceKey: 'offer', targetKey: 'check', labelOverride: 'Yes' }],
            }),
        ),
    );

    it('creates the prepared map in one call, names the proposal, and returns the map id', async () => {
        mockCreate.mockResolvedValueOnce('map-9');
        const prepared = prepareProcessMapApproval({ payloadJson, hasEdits: false });

        await expect(applyApprovedProcessMap(ctx, prepared, 'prop-1')).resolves.toBe('map-9');

        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(mockCreate).toHaveBeenCalledWith(ctx, {
            name: 'Joiner onboarding',
            description: 'From signed offer to first-day access.',
            nodes: prepared.graph.nodes,
            edges: prepared.graph.edges,
            sourceProposalId: 'prop-1',
        });
        expect(prepared.graph.nodes.map((n) => n.nodeKey)).toEqual(['n1', 'n2']);
    });

    it('lets a creation failure through, so the caller rolls the claim back', async () => {
        mockCreate.mockRejectedValueOnce(new Error('forced graph failure'));
        const prepared = prepareProcessMapApproval({ payloadJson, hasEdits: false });
        await expect(applyApprovedProcessMap(ctx, prepared, 'prop-1')).rejects.toThrow('forced graph failure');
    });
});
