/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/vendor.ts`.
 *
 * Roadmap Q2 — Vendor (worst-covered domain at 30% statements,
 * +40 to its tier floor). Mocks VendorRepository, the assessment
 * repositories, the scoring service, sanitizePlainText, and the
 * audit emitter.
 *
 * Covers:
 *   - Read paths: list / listPaginated / getVendor.
 *   - createVendor — Epic D.2 sanitisation across every free-text
 *     column AND the tags array.
 *   - updateVendor — Epic D.2 free-text patch sanitisation,
 *     status-change branch (VENDOR_STATUS_CHANGED vs VENDOR_UPDATED).
 *   - Documents: add/remove/list — sanitisation, audit, notFound.
 *   - getVendorAssessment — read gate + notFound.
 *   - listVendorLinks / addVendorLink / removeVendorLink.
 *   - setVendorReviewDates.
 */

const mockDb = {
    // updateVendor loads the current vendor (+ latest assessment) via
    // db.vendor.findFirst when the patch carries a `status`.
    vendor: { findFirst: jest.fn() },
    // listVendorLinks hydrates each link's target entity name via a
    // batched findMany per entityType. Default to empty ⇒ entityName null.
    // addVendorLink now resolves the target within the tenant before
    // writing, so each linkable type needs a findFirst too. Default to a
    // resolvable row — the reject path is asserted explicitly below.
    risk: {
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => ({ id: 'target-1' })),
    },
    control: {
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => ({ id: 'target-1' })),
    },
    asset: {
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => ({ id: 'target-1' })),
    },
    finding: { findFirst: jest.fn(async () => ({ id: 'target-1' })) },
    evidence: { findFirst: jest.fn(async () => ({ id: 'target-1' })) },
    task: { findMany: jest.fn(async () => []) },
    // Owner assignment resolves an ACTIVE membership in this tenant.
    tenantMembership: { findFirst: jest.fn(async () => ({ id: 'mem-1' })) },
    fileRecord: { findFirst: jest.fn(async () => ({ id: 'file-1' })) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/VendorRepository', () => ({
    VendorRepository: {
        list: jest.fn(),
        listPaginated: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    VendorDocumentRepository: {
        listByVendor: jest.fn(),
        create: jest.fn(),
        deleteById: jest.fn(),
    },
    VendorLinkRepository: {
        listByVendor: jest.fn(),
        create: jest.fn(),
        deleteById: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/AssessmentRepository', () => ({
    QuestionnaireRepository: {
        getByKey: jest.fn(),
        listTemplates: jest.fn(),
    },
    VendorAssessmentRepository: {
        create: jest.fn(),
        getById: jest.fn(),
        updateScore: jest.fn(),
        submit: jest.fn(),
        decide: jest.fn(),
    },
    VendorAnswerRepository: {
        upsertMany: jest.fn(),
        listByAssessment: jest.fn(),
    },
}));

jest.mock('@/app-layer/services/vendor-scoring', () => ({
    computeAnswerPoints: jest.fn(() => 5),
    computeAssessmentScore: jest.fn(() => ({ score: 42, percentScore: 84 })),
    scoreToRiskRating: jest.fn(() => 'LOW'),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
}));

import {
    VendorRepository,
    VendorDocumentRepository,
    VendorLinkRepository,
} from '@/app-layer/repositories/VendorRepository';
import {
    QuestionnaireRepository,
    VendorAssessmentRepository,
} from '@/app-layer/repositories/AssessmentRepository';
import { logEvent } from '@/app-layer/events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    listVendors,
    listVendorsPaginated,
    getVendor,
    createVendor,
    updateVendor,
    listVendorDocuments,
    addVendorDocument,
    removeVendorDocument,
    getVendorAssessment,
    listQuestionnaireTemplates,
    getQuestionnaireTemplate,
    setVendorReviewDates,
    listVendorLinks,
    addVendorLink,
    removeVendorLink,
} from '@/app-layer/usecases/vendor';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
    (sanitizePlainText as jest.Mock).mockImplementation((s: string) => `SAN::${s}`);
});

const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');

// ─── Reads ─────────────────────────────────────────────────────────

describe('vendor reads', () => {
    it('listVendors delegates under the read gate', async () => {
        (VendorRepository.list as jest.Mock).mockResolvedValue([{ id: 'v-1' }]);
        const rows = await listVendors(readerCtx);
        expect(rows).toEqual([{ id: 'v-1' }]);
    });

    it('listVendorsPaginated delegates', async () => {
        (VendorRepository.listPaginated as jest.Mock).mockResolvedValue({ items: [], pageInfo: {} });
        await listVendorsPaginated(readerCtx, { limit: 25 } as any);
        expect(VendorRepository.listPaginated).toHaveBeenCalled();
    });

    it('getVendor returns the row on hit', async () => {
        (VendorRepository.getById as jest.Mock).mockResolvedValue({ id: 'v-1' });
        await expect(getVendor(readerCtx, 'v-1')).resolves.toEqual({ id: 'v-1' });
    });

    it('getVendor throws notFound on miss', async () => {
        (VendorRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getVendor(readerCtx, 'missing')).rejects.toThrow(/Vendor not found/i);
    });
});

// ─── createVendor ──────────────────────────────────────────────────

describe('createVendor', () => {
    it('sanitises every free-text column AND each tags entry', async () => {
        (VendorRepository.create as jest.Mock).mockResolvedValue({ id: 'v-1', name: 'SAN::Acme', status: 'ACTIVE', criticality: 'HIGH' });

        await createVendor(editorCtx, {
            name: 'Acme',
            legalName: 'Acme Corp',
            country: 'US',
            domain: 'acme.com',
            websiteUrl: 'https://acme.com',
            description: 'A vendor',
            tags: ['it', 'critical'],
        } as any);

        const createArgs = (VendorRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.name).toBe('SAN::Acme');
        expect(createArgs.legalName).toBe('SAN::Acme Corp');
        expect(createArgs.description).toBe('SAN::A vendor');
        expect(createArgs.tags).toEqual(['SAN::it', 'SAN::critical']);
    });

    it('passes undefined optional fields through unchanged', async () => {
        (VendorRepository.create as jest.Mock).mockResolvedValue({ id: 'v-1', name: 'X', status: 'ACTIVE', criticality: 'HIGH' });

        await createVendor(editorCtx, { name: 'X' } as any);

        const createArgs = (VendorRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.legalName).toBeUndefined();
        expect(createArgs.tags).toBeUndefined();
    });

    it('emits VENDOR_CREATED audit', async () => {
        (VendorRepository.create as jest.Mock).mockResolvedValue({ id: 'v-1', name: 'X', status: 'ACTIVE', criticality: 'HIGH' });
        await createVendor(editorCtx, { name: 'X' } as any);
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('VENDOR_CREATED');
    });

    it('rejects READER (manage-vendors gate)', async () => {
        await expect(createVendor(readerCtx, { name: 'X' } as any)).rejects.toBeDefined();
    });
});

// ─── updateVendor ──────────────────────────────────────────────────

describe('updateVendor', () => {
    it('sanitises free-text fields in the patch (string-typed only)', async () => {
        (VendorRepository.update as jest.Mock).mockResolvedValue({ id: 'v-1', name: 'SAN::X' });

        await updateVendor(editorCtx, 'v-1', { name: 'X', description: 'd' });

        const updateArgs = (VendorRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.name).toBe('SAN::X');
        expect(updateArgs.description).toBe('SAN::d');
    });

    it('leaves non-string keys (enums, ids, dates) untouched', async () => {
        // patch carries `status` ⇒ updateVendor loads the current vendor
        // via db.vendor.findFirst. Target is not ACTIVE ⇒ gate does not fire.
        (mockDb.vendor.findFirst as jest.Mock).mockResolvedValue({ status: 'ACTIVE', assessments: [] });
        (VendorRepository.update as jest.Mock).mockResolvedValue({ id: 'v-1', name: 'X' });

        const now = new Date('2026-01-01');
        await updateVendor(editorCtx, 'v-1', { status: 'INACTIVE', criticality: 'HIGH', nextReviewAt: now });

        const updateArgs = (VendorRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.status).toBe('INACTIVE');
        expect(updateArgs.criticality).toBe('HIGH');
        expect(updateArgs.nextReviewAt).toBe(now);
    });

    it('sanitises tags array entries that are strings', async () => {
        (VendorRepository.update as jest.Mock).mockResolvedValue({ id: 'v-1', name: 'X' });

        await updateVendor(editorCtx, 'v-1', { tags: ['it', 'sso'] });

        const updateArgs = (VendorRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.tags).toEqual(['SAN::it', 'SAN::sso']);
    });

    it('emits VENDOR_STATUS_CHANGED when status changes', async () => {
        // Status change now loads current-vendor state via db.vendor.findFirst.
        (mockDb.vendor.findFirst as jest.Mock).mockResolvedValue({ id: 'v-1', status: 'ACTIVE', assessments: [] });
        (VendorRepository.update as jest.Mock).mockResolvedValue({ id: 'v-1', name: 'X' });

        await updateVendor(editorCtx, 'v-1', { status: 'INACTIVE' });

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('VENDOR_STATUS_CHANGED');
        expect(payload.detailsJson.fromStatus).toBe('ACTIVE');
        expect(payload.detailsJson.toStatus).toBe('INACTIVE');
    });

    it('emits VENDOR_UPDATED when status is unchanged', async () => {
        (VendorRepository.update as jest.Mock).mockResolvedValue({ id: 'v-1', name: 'X' });

        await updateVendor(editorCtx, 'v-1', { name: 'New' });

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('VENDOR_UPDATED');
    });

    it('throws notFound when the vendor is missing', async () => {
        (VendorRepository.update as jest.Mock).mockResolvedValue(null);
        await expect(updateVendor(editorCtx, 'missing', { name: 'X' })).rejects.toThrow(/Vendor not found/i);
    });
});

// ─── Vendor Documents ──────────────────────────────────────────────

describe('vendor documents', () => {
    it('listVendorDocuments delegates under read gate', async () => {
        (VendorDocumentRepository.listByVendor as jest.Mock).mockResolvedValue([{ id: 'd-1' }]);
        const rows = await listVendorDocuments(readerCtx, 'v-1');
        expect(rows).toEqual([{ id: 'd-1' }]);
    });

    it('addVendorDocument sanitises text fields, emits VENDOR_DOCUMENT_ADDED', async () => {
        (VendorDocumentRepository.create as jest.Mock).mockResolvedValue({
            id: 'd-1', vendorId: 'v-1', type: 'SOC2', title: 'SAN::Report',
        });

        await addVendorDocument(editorCtx, 'v-1', {
            type: 'SOC2',
            title: 'Report',
            notes: 'See attached',
            folder: 'IT',
        });

        const docArgs = (VendorDocumentRepository.create as jest.Mock).mock.calls[0][3];
        expect(docArgs.title).toBe('SAN::Report');
        expect(docArgs.notes).toBe('SAN::See attached');
        expect(docArgs.folder).toBe('SAN::IT');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('VENDOR_DOCUMENT_ADDED');
    });

    it('addVendorDocument passes null fields through (clear contract)', async () => {
        (VendorDocumentRepository.create as jest.Mock).mockResolvedValue({ id: 'd-1', vendorId: 'v-1', type: 'SOC2' });
        await addVendorDocument(editorCtx, 'v-1', { type: 'SOC2', title: null, notes: null });
        const docArgs = (VendorDocumentRepository.create as jest.Mock).mock.calls[0][3];
        expect(docArgs.title).toBeNull();
        expect(docArgs.notes).toBeNull();
    });

    it('removeVendorDocument throws notFound when missing', async () => {
        (VendorDocumentRepository.deleteById as jest.Mock).mockResolvedValue(null);
        await expect(removeVendorDocument(editorCtx, 'missing')).rejects.toThrow(/Document not found/i);
    });

    it('removeVendorDocument emits VENDOR_DOCUMENT_REMOVED', async () => {
        (VendorDocumentRepository.deleteById as jest.Mock).mockResolvedValue({
            id: 'd-1', vendorId: 'v-1', type: 'SOC2', title: 'X',
        });
        await removeVendorDocument(editorCtx, 'd-1');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('VENDOR_DOCUMENT_REMOVED');
    });
});

// ─── Assessments ───────────────────────────────────────────────────

describe('getVendorAssessment', () => {
    it('returns the row on hit', async () => {
        (VendorAssessmentRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1' });
        await expect(getVendorAssessment(readerCtx, 'a-1')).resolves.toEqual({ id: 'a-1' });
    });

    it('throws notFound on miss', async () => {
        (VendorAssessmentRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getVendorAssessment(readerCtx, 'missing')).rejects.toThrow(/Assessment not found/i);
    });
});

describe('questionnaire templates', () => {
    it('lists templates under the read gate', async () => {
        (QuestionnaireRepository.listTemplates as jest.Mock).mockResolvedValue([{ key: 'sig' }]);
        const rows = await listQuestionnaireTemplates(readerCtx);
        expect(rows).toEqual([{ key: 'sig' }]);
    });

    it('throws notFound when key does not exist', async () => {
        (QuestionnaireRepository.getByKey as jest.Mock).mockResolvedValue(null);
        await expect(getQuestionnaireTemplate(readerCtx, 'missing')).rejects.toThrow(/Template not found/i);
    });
});

// ─── setVendorReviewDates ──────────────────────────────────────────

describe('setVendorReviewDates', () => {
    it('updates dates and emits VENDOR_UPDATED', async () => {
        (VendorRepository.update as jest.Mock).mockResolvedValue({ id: 'v-1' });
        await setVendorReviewDates(editorCtx, 'v-1', { nextReviewAt: '2027-06-01' });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('VENDOR_UPDATED');
        expect(payload.detailsJson.changedFields).toContain('nextReviewAt');
    });

    it('throws notFound when missing', async () => {
        (VendorRepository.update as jest.Mock).mockResolvedValue(null);
        await expect(setVendorReviewDates(editorCtx, 'missing', {})).rejects.toThrow(/Vendor not found/i);
    });
});

// ─── Vendor Links ──────────────────────────────────────────────────

describe('vendor links', () => {
    it('listVendorLinks delegates under read gate + hydrates entityName', async () => {
        (VendorLinkRepository.listByVendor as jest.Mock).mockResolvedValue([{ id: 'l-1' }]);
        const rows = await listVendorLinks(readerCtx, 'v-1');
        // Each link is now hydrated with a resolved target-entity name.
        // No entityType on the raw row ⇒ nothing to resolve ⇒ entityName null.
        expect(rows).toEqual([{ id: 'l-1', entityName: null }]);
    });

    it('addVendorLink creates and returns', async () => {
        (VendorLinkRepository.create as jest.Mock).mockResolvedValue({ id: 'l-1' });
        const res = await addVendorLink(editorCtx, 'v-1', { entityType: 'CONTROL' as any, entityId: 'c-1' });
        expect(res).toEqual({ id: 'l-1' });
    });

    it('removeVendorLink throws notFound when missing', async () => {
        (VendorLinkRepository.deleteById as jest.Mock).mockResolvedValue(null);
        await expect(removeVendorLink(editorCtx, 'missing')).rejects.toThrow(/not found/i);
    });

    it('removeVendorLink returns the deleted row on success', async () => {
        (VendorLinkRepository.deleteById as jest.Mock).mockResolvedValue({ id: 'l-1' });
        const res = await removeVendorLink(editorCtx, 'l-1');
        expect(res).toEqual({ id: 'l-1' });
    });
});

// ═══════════════════════════════════════════════════════════════════
// Cross-tenant target validation
// ═══════════════════════════════════════════════════════════════════
//
// The link row is written with ctx.tenantId, so RLS is satisfied either
// way — but nothing checked the id it POINTS AT. A foreign entityId
// persisted happily and then rendered as a dangling reference, because RLS
// hides the target from every later read. That is what makes it insidious:
// it fails silently rather than loudly.

describe('cross-tenant link targets', () => {
    beforeEach(() => {
        mockDb.control.findFirst.mockResolvedValue({ id: 'target-1' });
        mockDb.tenantMembership.findFirst.mockResolvedValue({ id: 'mem-1' });
        (VendorLinkRepository.create as jest.Mock).mockResolvedValue({ id: 'link-1' });
    });

    it('rejects a link whose target does not resolve in this tenant', async () => {
        mockDb.control.findFirst.mockResolvedValueOnce(null);
        await expect(
            addVendorLink(editorCtx, 'vendor-1', {
                entityType: 'CONTROL',
                entityId: 'control-from-another-tenant',
            }),
        ).rejects.toThrow();
        expect(VendorLinkRepository.create).not.toHaveBeenCalled();
    });

    it('scopes the target lookup to the caller tenant', async () => {
        await addVendorLink(editorCtx, 'vendor-1', {
            entityType: 'CONTROL',
            entityId: 'control-1',
        });
        const where = mockDb.control.findFirst.mock.calls[0][0].where;
        expect(where.tenantId).toBe(editorCtx.tenantId);
        expect(where.id).toBe('control-1');
    });

    it('rejects an unsupported entity type rather than writing it', async () => {
        await expect(
            addVendorLink(editorCtx, 'vendor-1', {
                entityType: 'NOT_A_THING',
                entityId: 'x',
            }),
        ).rejects.toThrow();
        expect(VendorLinkRepository.create).not.toHaveBeenCalled();
    });

    it('refuses an owner who is not an active member of this tenant', async () => {
        mockDb.tenantMembership.findFirst.mockResolvedValueOnce(null);
        await expect(
            createVendor(editorCtx, {
                name: 'Acme',
                ownerUserId: 'user-from-another-tenant',
            } as any),
        ).rejects.toThrow();
        expect(VendorRepository.create).not.toHaveBeenCalled();
    });

    it('requires the membership to be ACTIVE, not merely present', async () => {
        (VendorRepository.create as jest.Mock).mockResolvedValue({
            id: 'v-1', name: 'X', status: 'ACTIVE', criticality: 'HIGH',
        });
        await createVendor(editorCtx, { name: 'X', ownerUserId: 'user-2' } as any);
        const where = mockDb.tenantMembership.findFirst.mock.calls[0][0].where;
        expect(where.status).toBe('ACTIVE');
        expect(where.tenantId).toBe(editorCtx.tenantId);
    });

    it('skips the owner lookup entirely when no owner is supplied', async () => {
        (VendorRepository.create as jest.Mock).mockResolvedValue({
            id: 'v-1', name: 'X', status: 'ACTIVE', criticality: 'HIGH',
        });
        await createVendor(editorCtx, { name: 'X' } as any);
        expect(mockDb.tenantMembership.findFirst).not.toHaveBeenCalled();
    });
});
