/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts; the file-level disable is this repo's standard for these
 * surfaces (see test-plan-cadence-and-bulk-gate.test.ts). */
/**
 * The tenant checks on CALLER-SUPPLIED ids in test-run evidence links.
 *
 * `linkEvidenceToRun` and `createAutomatedTestRun` both take `fileId` /
 * `evidenceId` straight from the request body and attach them to a test run —
 * the artefact an auditor reads as proof a control was tested. Both verify the
 * id resolves IN THIS TENANT before stamping. Both checks were uncovered
 * (`test-plans.ts:852-856`, `:979-994`).
 *
 * The FILE case is not merely a scoping check, and the source says why: the
 * `sha256` frozen at link time is what `verifyRunEvidence` later recomputes to
 * detect tampering. A file that does not resolve has no trustworthy hash, so
 * linking it anyway would store `null` and score VERIFIED against nothing —
 * the fail-open path the code calls out by name.
 *
 * The EVIDENCE case carries its own history: "a foreign evidenceId was
 * previously stamped blind". That is a fixed defect with no test, which is the
 * state a regression walks back into unnoticed.
 */

const mockTx = {
    fileRecord: { findFirst: jest.fn(), findMany: jest.fn() },
    evidence: { findFirst: jest.fn() },
    controlTestPlan: { findFirst: jest.fn(), update: jest.fn() },
    controlTestRun: { create: jest.fn(), update: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
    PrismaTx: {},
}));

const runRepo = { getById: jest.fn(), create: jest.fn(), update: jest.fn() };
jest.mock('@/app-layer/repositories/TestRunRepository', () => ({
    TestRunRepository: new Proxy({}, { get: (_t, k: string) => (runRepo as any)[k] }),
}));

const planRepo = { getById: jest.fn(), update: jest.fn(), updateNextDueAt: jest.fn() };
jest.mock('@/app-layer/repositories/TestPlanRepository', () => ({
    TestPlanRepository: new Proxy({}, { get: (_t, k: string) => (planRepo as any)[k] }),
}));

const evidenceRepo = { link: jest.fn(), unlink: jest.fn(), listForRun: jest.fn() };
jest.mock('@/app-layer/repositories/TestEvidenceRepository', () => ({
    TestEvidenceRepository: new Proxy({}, { get: (_t, k: string) => (evidenceRepo as any)[k] }),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/events/test.events', () => ({
    emitTestPlanCreated: jest.fn(), emitTestPlanUpdated: jest.fn(),
    emitTestPlanStatusChanged: jest.fn(), emitTestPlanStatusAutomationEvent: jest.fn(),
    emitTestRunCreated: jest.fn(), emitTestRunCompleted: jest.fn(),
    emitTestRunFailed: jest.fn(), emitTestEvidenceLinked: jest.fn(),
    emitTestEvidenceUnlinked: jest.fn(),
}));
jest.mock('@/lib/cache/list-cache', () => ({ bumpEntityCacheVersion: jest.fn() }));

import { linkEvidenceToRun } from '@/app-layer/usecases/control/test-plans';
import { makeRequestContext } from '../helpers/make-context';

const ctx = () => makeRequestContext('ADMIN', { tenantId: 't-1' });

beforeEach(() => {
    jest.clearAllMocks();
    runRepo.getById.mockResolvedValue({ id: 'run-1', status: 'IN_PROGRESS', testPlanId: 'p-1' });
    mockTx.fileRecord.findFirst.mockResolvedValue({ sha256: 'sha-abc' });
    mockTx.evidence.findFirst.mockResolvedValue({ id: 'ev-1' });
    evidenceRepo.link.mockResolvedValue({ id: 'link-1' });
});

describe('linkEvidenceToRun — FILE kind', () => {
    it('freezes the file sha256 at link time', async () => {
        await linkEvidenceToRun(ctx(), 'run-1', { kind: 'FILE', fileId: 'f-1' });
        expect(evidenceRepo.link).toHaveBeenCalledWith(
            expect.anything(), expect.anything(),
            expect.objectContaining({ sha256Hash: 'sha-abc' }),
        );
    });

    it('scopes the file lookup to the tenant', async () => {
        await linkEvidenceToRun(ctx(), 'run-1', { kind: 'FILE', fileId: 'f-1' });
        expect(mockTx.fileRecord.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'f-1', tenantId: 't-1' } }),
        );
    });

    // The fail-open the source names: a foreign or missing fileId has no
    // trustworthy hash, so linking it would store null and later score
    // VERIFIED against nothing.
    it('REFUSES a fileId that does not resolve in this tenant', async () => {
        mockTx.fileRecord.findFirst.mockResolvedValue(null);
        await expect(
            linkEvidenceToRun(ctx(), 'run-1', { kind: 'FILE', fileId: 'other-tenants-file' }),
        ).rejects.toThrow(/does not exist in this tenant/);
        expect(evidenceRepo.link).not.toHaveBeenCalled();
    });

    it('REFUSES a FILE link with no fileId at all', async () => {
        await expect(linkEvidenceToRun(ctx(), 'run-1', { kind: 'FILE' }))
            .rejects.toThrow(/requires a fileId/);
        expect(evidenceRepo.link).not.toHaveBeenCalled();
    });

    // A file row with a null checksum links, but stores null rather than
    // inventing one — verifyRunEvidence can then report "unverifiable" instead
    // of comparing against a fabricated value.
    it('stores a null hash when the file has no checksum, rather than refusing', async () => {
        mockTx.fileRecord.findFirst.mockResolvedValue({ sha256: null });
        await linkEvidenceToRun(ctx(), 'run-1', { kind: 'FILE', fileId: 'f-1' });
        expect(evidenceRepo.link).toHaveBeenCalledWith(
            expect.anything(), expect.anything(),
            expect.objectContaining({ sha256Hash: null }),
        );
    });
});

describe('linkEvidenceToRun — EVIDENCE kind', () => {
    // "a foreign evidenceId was previously stamped blind" — the source's own
    // words. A fixed defect with no test is one a refactor walks back into.
    it('REFUSES an evidenceId that does not resolve in this tenant', async () => {
        mockTx.evidence.findFirst.mockResolvedValue(null);
        await expect(
            linkEvidenceToRun(ctx(), 'run-1', { kind: 'EVIDENCE', evidenceId: 'other-tenants-evidence' }),
        ).rejects.toThrow(/does not exist in this tenant/);
        expect(evidenceRepo.link).not.toHaveBeenCalled();
    });

    it('scopes the evidence lookup to the tenant', async () => {
        await linkEvidenceToRun(ctx(), 'run-1', { kind: 'EVIDENCE', evidenceId: 'ev-1' });
        expect(mockTx.evidence.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'ev-1', tenantId: 't-1' } }),
        );
    });

    // Deliberately asymmetric with FILE: an EVIDENCE link without an id is
    // allowed through (the check is `input.evidenceId &&`), because unlike a
    // FILE link it carries no integrity claim to be wrong about.
    it('permits an EVIDENCE link with no evidenceId', async () => {
        await expect(linkEvidenceToRun(ctx(), 'run-1', { kind: 'EVIDENCE' }))
            .resolves.toBeDefined();
        expect(mockTx.evidence.findFirst).not.toHaveBeenCalled();
    });
});

describe('linkEvidenceToRun — the completed-run freeze', () => {
    // A COMPLETED run is frozen audit evidence. Attaching to it after the fact
    // would let the record behind a verdict change without the verdict moving.
    it('refuses to attach evidence to a COMPLETED run', async () => {
        runRepo.getById.mockResolvedValue({ id: 'run-1', status: 'COMPLETED' });
        await expect(linkEvidenceToRun(ctx(), 'run-1', { kind: 'LINK', url: 'https://x' }))
            .rejects.toThrow(/completed .* frozen|frozen/i);
        expect(evidenceRepo.link).not.toHaveBeenCalled();
    });

    it('404s a run outside the tenant', async () => {
        runRepo.getById.mockResolvedValue(null);
        await expect(linkEvidenceToRun(ctx(), 'nope', { kind: 'LINK', url: 'https://x' }))
            .rejects.toThrow(/Test run not found/);
    });
});
