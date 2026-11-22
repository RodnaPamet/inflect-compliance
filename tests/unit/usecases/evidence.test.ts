/**
 * Unit tests for src/app-layer/usecases/evidence.ts
 *
 * Wave 2 of GAP-02. Existing tests cover plumbing; this file locks
 * in the security-load-bearing review-flow assertions:
 *
 *   1. Cross-tenant control id rejection on createEvidence — admin
 *      in tenant A cannot link evidence to tenant B's control even
 *      if A knows B's controlId.
 *   2. reviewEvidence step gates: SUBMITTED requires canWrite,
 *      APPROVED / REJECTED require canAdmin (separation of duty).
 *      An unknown action errors out — no silent transition.
 *   3. STATUS_CHANGE audit fired with correct from/to status.
 *   4. Notification created for the evidence owner on APPROVED /
 *      REJECTED, NOT on SUBMITTED.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    EvidenceRepository: {
        create: jest.fn(),
        getById: jest.fn(),
        update: jest.fn(),
        // #5317 — the review's status move is conditional on the read status.
        transitionStatus: jest.fn(async () => true),
        addReview: jest.fn(),
        // SoD source (ep1 review gate) — empty map ⇒ fall back to owner.
        getLatestSubmitters: jest.fn(async () => new Map()),
        // EP-3 join-management — default: every requested control exists.
        filterExistingControlIds: jest.fn(async (_db, _ctx, ids: string[]) => new Set(ids)),
        createControlLinks: jest.fn(async () => undefined),
        listControlLinks: jest.fn(async () => []),
        linkControl: jest.fn(async () => true),
        unlinkControl: jest.fn(async () => 1),
    },
}));

jest.mock('@/lib/storage', () => ({
    uploadFile: jest.fn(),
    validateFile: jest.fn(),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    createEvidence,
    reviewEvidence,
    linkEvidenceToControl,
    unlinkEvidenceFromControl,
} from '@/app-layer/usecases/evidence';
import { runInTenantContext } from '@/lib/db-context';
import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockCreate = EvidenceRepository.create as jest.MockedFunction<typeof EvidenceRepository.create>;
const mockGetById = EvidenceRepository.getById as jest.MockedFunction<typeof EvidenceRepository.getById>;
const mockTransition = EvidenceRepository.transitionStatus as jest.MockedFunction<typeof EvidenceRepository.transitionStatus>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;
const mockFilterControls = EvidenceRepository.filterExistingControlIds as jest.MockedFunction<typeof EvidenceRepository.filterExistingControlIds>;
const mockCreateLinks = EvidenceRepository.createControlLinks as jest.MockedFunction<typeof EvidenceRepository.createControlLinks>;
const mockLinkControl = EvidenceRepository.linkControl as jest.MockedFunction<typeof EvidenceRepository.linkControl>;
const mockUnlinkControl = EvidenceRepository.unlinkControl as jest.MockedFunction<typeof EvidenceRepository.unlinkControl>;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('createEvidence — cross-tenant control rejection', () => {
    it('rejects when controlId points at a control NOT in caller tenant', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        // EP-3 — the control does not exist in the caller's tenant, so the
        // tenant-scoped existence check returns an empty set.
        mockFilterControls.mockResolvedValueOnce(new Set());

        await expect(
            createEvidence(
                makeRequestContext('EDITOR', { tenantId: 'tenant-A' }),
                {
                    type: 'LINK',
                    title: 'Bad cross-tenant evidence',
                    controlId: 'tenant-B-control',
                    content: 'https://example.com/file',
                },
            ),
        ).rejects.toThrow(/INVALID_CONTROL/);
        // Regression: a bug that drops `tenantId` from the existence check
        // would let admin in A attach evidence to a control in tenant B.
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockCreateLinks).not.toHaveBeenCalled();
    });

    it('rejects READER on create (canWrite gate)', async () => {
        await expect(
            createEvidence(makeRequestContext('READER'), {
                type: 'LINK',
                title: 'x',
            }),
        ).rejects.toThrow();
    });

    it('persists status=DRAFT by default', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockCreate.mockResolvedValue({ id: 'e1', fileRecordId: null } as never);

        await createEvidence(makeRequestContext('EDITOR'), {
            type: 'LINK',
            title: 'doc',
        });
        const repoArgs = mockCreate.mock.calls[0][2];
        expect(repoArgs.status).toBe('DRAFT');
    });

    it('EP-3 — multiple controlIds create ONE Evidence + N links (no clone)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockCreate.mockResolvedValue({ id: 'e-multi', fileRecordId: null } as never);

        await createEvidence(makeRequestContext('EDITOR', { tenantId: 'tenant-A' }), {
            type: 'LINK',
            title: 'shared artifact',
            content: 'https://example.com/a',
            controlIds: ['c1', 'c2', 'c3'],
        });

        // Exactly ONE Evidence row created — never one-per-control.
        expect(mockCreate).toHaveBeenCalledTimes(1);
        // N join rows for the single evidence.
        expect(mockCreateLinks).toHaveBeenCalledTimes(1);
        expect(mockCreateLinks).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'e-multi',
            ['c1', 'c2', 'c3'],
        );
    });

    it('EP-3 — legacy singular controlId is wrapped into the link set', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockCreate.mockResolvedValue({ id: 'e-legacy', fileRecordId: null } as never);

        await createEvidence(makeRequestContext('EDITOR'), {
            type: 'LINK',
            title: 'legacy',
            content: 'https://example.com/x',
            controlId: 'c-legacy',
        });
        expect(mockCreateLinks).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'e-legacy',
            ['c-legacy'],
        );
    });
});

describe('EP-3 — link / unlink evidence↔control', () => {
    const evidenceRow = { id: 'e1', title: 'doc', status: 'DRAFT' };

    it('linkEvidenceToControl creates one link + logs when new', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValue(evidenceRow as never);
        mockFilterControls.mockResolvedValueOnce(new Set(['c1']));
        mockLinkControl.mockResolvedValueOnce(true);

        const res = await linkEvidenceToControl(makeRequestContext('EDITOR'), 'e1', 'c1');
        expect(res).toEqual({ linked: true });
        expect(mockLinkControl).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'e1', 'c1');
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'CONTROL_EVIDENCE_LINKED' }),
        );
    });

    it('linkEvidenceToControl rejects a foreign control', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValue(evidenceRow as never);
        mockFilterControls.mockResolvedValueOnce(new Set());
        await expect(
            linkEvidenceToControl(makeRequestContext('EDITOR'), 'e1', 'foreign'),
        ).rejects.toThrow(/INVALID_CONTROL/);
        expect(mockLinkControl).not.toHaveBeenCalled();
    });

    it('unlinkEvidenceFromControl removes the link + logs', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValue(evidenceRow as never);
        mockUnlinkControl.mockResolvedValueOnce(1);
        const res = await unlinkEvidenceFromControl(makeRequestContext('EDITOR'), 'e1', 'c1');
        expect(res).toEqual({ success: true });
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'CONTROL_EVIDENCE_UNLINKED' }),
        );
    });

    it('unlinkEvidenceFromControl 404s when no link existed', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValue(evidenceRow as never);
        mockUnlinkControl.mockResolvedValueOnce(0);
        await expect(
            unlinkEvidenceFromControl(makeRequestContext('EDITOR'), 'e1', 'c1'),
        ).rejects.toThrow(/not linked/);
    });
});

describe('reviewEvidence — separation of duty', () => {
    const evidenceRow = {
        id: 'e1', title: 'doc', status: 'DRAFT',
        owner: null, ownerUserId: null,
    };

    function setupDbWithEvidence() {
        const fakeDb = {
            user: { findUnique: jest.fn(), findFirst: jest.fn() },
            notification: { create: jest.fn() },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));
        mockGetById.mockResolvedValue(evidenceRow as never);
        return fakeDb;
    }

    it('SUBMITTED: EDITOR can submit (canWrite), READER cannot', async () => {
        setupDbWithEvidence();
        await reviewEvidence(makeRequestContext('EDITOR'), 'e1', {
            action: 'SUBMITTED',
            comment: null,
        });
        expect(mockTransition).toHaveBeenCalled();

        await expect(
            reviewEvidence(makeRequestContext('READER'), 'e1', {
                action: 'SUBMITTED',
                comment: null,
            }),
        ).rejects.toThrow();
    });

    it('APPROVED requires canAdmin — EDITOR cannot approve their own submission', async () => {
        await expect(
            reviewEvidence(makeRequestContext('EDITOR'), 'e1', {
                action: 'APPROVED',
                comment: null,
            }),
        ).rejects.toThrow();
        // Regression: separation-of-duty gate — the user who CAN
        // submit must NOT be able to approve. A bug that collapses
        // both gates to canWrite would let any EDITOR self-approve.
        expect(mockTransition).not.toHaveBeenCalled();
    });

    it('REJECTED also requires canAdmin', async () => {
        await expect(
            reviewEvidence(makeRequestContext('EDITOR'), 'e1', {
                action: 'REJECTED',
                comment: 'no',
            }),
        ).rejects.toThrow();
    });

    it('ADMIN can APPROVE — emits STATUS_CHANGE audit with correct transition', async () => {
        // Audit S3 (2026-05-22) — DRAFT → APPROVED is now illegal
        // per the explicit state machine. Reviewers can only APPROVE
        // a row that's already SUBMITTED. Fixture overridden for
        // this case; the default `evidenceRow` (DRAFT) test the
        // SUBMITTED flow below.
        const fakeDb = {
            user: { findUnique: jest.fn(), findFirst: jest.fn() },
            notification: { create: jest.fn() },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));
        mockGetById.mockResolvedValue({
            ...evidenceRow,
            status: 'SUBMITTED',
        } as never);

        await reviewEvidence(makeRequestContext('ADMIN'), 'e1', {
            action: 'APPROVED',
            comment: 'looks good',
        });

        expect(mockTransition).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'e1',
            'SUBMITTED',
            'APPROVED',
        );
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'STATUS_CHANGE',
                entityType: 'Evidence',
                entityId: 'e1',
                detailsJson: expect.objectContaining({
                    fromStatus: 'SUBMITTED',
                    toStatus: 'APPROVED',
                }),
            }),
        );
    });

    it('rejects unknown actions — no silent state transition', async () => {
        await expect(
            reviewEvidence(makeRequestContext('ADMIN'), 'e1', {
                action: 'WHAT_IS_THIS',
                comment: null,
            }),
        ).rejects.toThrow(/Invalid review action/);
        expect(mockTransition).not.toHaveBeenCalled();
    });

    it('throws notFound for cross-tenant evidence id', async () => {
        const fakeDb = { user: { findUnique: jest.fn() }, notification: { create: jest.fn() } };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));
        mockGetById.mockResolvedValue(null);
        await expect(
            reviewEvidence(makeRequestContext('ADMIN'), 'cross-tenant-id', {
                action: 'APPROVED',
                comment: null,
            }),
        ).rejects.toThrow(/not found/);
    });

    it('does NOT create a notification on SUBMITTED (only APPROVED / REJECTED)', async () => {
        const fakeDb = setupDbWithEvidence();
        await reviewEvidence(makeRequestContext('EDITOR'), 'e1', {
            action: 'SUBMITTED',
            comment: null,
        });
        expect(fakeDb.notification.create).not.toHaveBeenCalled();
    });
});
