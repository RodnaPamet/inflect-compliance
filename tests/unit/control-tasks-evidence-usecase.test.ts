/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/control/evidence.ts`.
 *
 * Roadmap Q1 — Compliance core. Covers the detail-page Evidence tab
 * (tab-lazy #102 payload) and the contributor/asset linking surfaces.
 * All are thin orchestration over ControlRepository — RBAC +
 * repo-returns-null → notFound + audit event shape is what we're
 * locking. (The legacy control/tasks.ts stack was removed in TP-2;
 * the Tasks tab now renders the unified Task model.)
 */

const mockDb = {
    control: { findFirst: jest.fn() },
    evidence: { findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/ControlRepository', () => ({
    ControlRepository: {
        listEvidenceLinks: jest.fn(),
        linkEvidence: jest.fn(),
        unlinkEvidence: jest.fn(),
        linkAsset: jest.fn(),
        unlinkAsset: jest.fn(),
        listContributors: jest.fn(),
        addContributor: jest.fn(),
        removeContributor: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

import { ControlRepository } from '@/app-layer/repositories/ControlRepository';
import { logEvent } from '@/app-layer/events/audit';
import {
    listEvidenceLinks,
    getControlEvidenceTab,
    linkEvidence,
    unlinkEvidence,
    linkAssetToControl,
    unlinkAssetFromControl,
    listContributors,
    addContributor,
    removeContributor,
} from '@/app-layer/usecases/control';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');

// ─── control/evidence.ts ───────────────────────────────────────────

describe('listEvidenceLinks', () => {
    it('delegates to ControlRepository.listEvidenceLinks under the read gate', async () => {
        (ControlRepository.listEvidenceLinks as jest.Mock).mockResolvedValue([{ id: 'l-1' }]);
        const rows = await listEvidenceLinks(readerCtx, 'c-1');
        expect(rows).toEqual([{ id: 'l-1' }]);
    });
});

describe('getControlEvidenceTab', () => {
    it('returns links + direct evidence in a single bundled payload', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue({ id: 'c-1' });
        (ControlRepository.listEvidenceLinks as jest.Mock).mockResolvedValue([{ id: 'l-1' }]);
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([{ id: 'e-1' }]);

        const res = await getControlEvidenceTab(readerCtx, 'c-1');

        expect(res).toEqual({ links: [{ id: 'l-1' }], evidence: [{ id: 'e-1' }] });
    });

    it('throws notFound when the control is missing (neither query fires)', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(getControlEvidenceTab(readerCtx, 'missing')).rejects.toThrow(/Control not found/i);
        expect(ControlRepository.listEvidenceLinks).not.toHaveBeenCalled();
        expect(mockDb.evidence.findMany).not.toHaveBeenCalled();
    });
});

describe('linkEvidence', () => {
    it('creates a link and emits CONTROL_EVIDENCE_LINKED', async () => {
        (ControlRepository.linkEvidence as jest.Mock).mockResolvedValue({ id: 'l-1' });

        const res = await linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'f-1' });

        expect(res).toEqual({ id: 'l-1' });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_EVIDENCE_LINKED');
        expect(payload.detailsJson.relation).toBe('FILE');
    });

    it('throws notFound when the control is missing', async () => {
        (ControlRepository.linkEvidence as jest.Mock).mockResolvedValue(null);
        await expect(linkEvidence(editorCtx, 'missing', { kind: 'FILE' })).rejects.toThrow(/Control not found/i);
    });

    it('rejects READER (link-evidence gate)', async () => {
        await expect(linkEvidence(readerCtx, 'c-1', { kind: 'FILE' })).rejects.toBeDefined();
    });
});

describe('unlinkEvidence', () => {
    it('removes link and emits CONTROL_EVIDENCE_UNLINKED', async () => {
        (ControlRepository.unlinkEvidence as jest.Mock).mockResolvedValue(true);

        const res = await unlinkEvidence(editorCtx, 'c-1', 'l-1');

        expect(res).toEqual({ success: true });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_EVIDENCE_UNLINKED');
    });

    it('throws notFound when the link is missing', async () => {
        (ControlRepository.unlinkEvidence as jest.Mock).mockResolvedValue(null);
        await expect(unlinkEvidence(editorCtx, 'c-1', 'missing')).rejects.toThrow(/Evidence link not found/i);
    });

    it('rejects READER', async () => {
        await expect(unlinkEvidence(readerCtx, 'c-1', 'l-1')).rejects.toBeDefined();
    });
});

describe('linkAssetToControl', () => {
    it('returns the link row when successful', async () => {
        (ControlRepository.linkAsset as jest.Mock).mockResolvedValue({ controlId: 'c-1', assetId: 'a-1' });
        const res = await linkAssetToControl(editorCtx, 'c-1', 'a-1');
        expect(res).toEqual({ controlId: 'c-1', assetId: 'a-1' });
    });

    it('throws notFound when the control does not exist', async () => {
        (ControlRepository.linkAsset as jest.Mock).mockResolvedValue(null);
        await expect(linkAssetToControl(editorCtx, 'missing', 'a-1')).rejects.toThrow(/Control not found/i);
    });

    it('rejects READER', async () => {
        await expect(linkAssetToControl(readerCtx, 'c-1', 'a-1')).rejects.toBeDefined();
    });
});

describe('unlinkAssetFromControl', () => {
    it('returns success on delete', async () => {
        (ControlRepository.unlinkAsset as jest.Mock).mockResolvedValue(true);
        const res = await unlinkAssetFromControl(editorCtx, 'c-1', 'a-1');
        expect(res).toEqual({ success: true });
    });

    it('throws notFound when the row is missing', async () => {
        (ControlRepository.unlinkAsset as jest.Mock).mockResolvedValue(null);
        await expect(unlinkAssetFromControl(editorCtx, 'c-1', 'missing')).rejects.toThrow(/Control or asset link not found/i);
    });
});

describe('listContributors', () => {
    it('delegates to ControlRepository.listContributors', async () => {
        (ControlRepository.listContributors as jest.Mock).mockResolvedValue([{ id: 'u-1' }]);
        const rows = await listContributors(readerCtx, 'c-1');
        expect(rows).toEqual([{ id: 'u-1' }]);
    });
});

describe('addContributor', () => {
    it('adds a contributor and emits CONTROL_CONTRIBUTOR_ADDED', async () => {
        (ControlRepository.addContributor as jest.Mock).mockResolvedValue({ id: 'cb-1' });
        const res = await addContributor(editorCtx, 'c-1', 'u-1');
        expect(res).toEqual({ id: 'cb-1' });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_CONTRIBUTOR_ADDED');
    });

    it('throws notFound when the control is missing', async () => {
        (ControlRepository.addContributor as jest.Mock).mockResolvedValue(null);
        await expect(addContributor(editorCtx, 'missing', 'u-1')).rejects.toThrow(/Control not found/i);
    });

    it('rejects READER', async () => {
        await expect(addContributor(readerCtx, 'c-1', 'u-1')).rejects.toBeDefined();
    });
});

describe('removeContributor', () => {
    it('removes a contributor and emits CONTROL_CONTRIBUTOR_REMOVED', async () => {
        (ControlRepository.removeContributor as jest.Mock).mockResolvedValue(true);
        const res = await removeContributor(editorCtx, 'c-1', 'u-1');
        expect(res).toEqual({ success: true });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_CONTRIBUTOR_REMOVED');
    });

    it('throws notFound when the row is missing', async () => {
        (ControlRepository.removeContributor as jest.Mock).mockResolvedValue(null);
        await expect(removeContributor(editorCtx, 'c-1', 'missing')).rejects.toThrow(/Control or contributor not found/i);
    });
});
