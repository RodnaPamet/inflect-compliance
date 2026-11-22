/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Branch-coverage unit tests for the Policy Document PDF generator
 * (`src/app-layer/reports/pdf/policyDocument.ts`), previously ~0%.
 *
 * The generator runs the REAL PDFKit document + real policy-layout
 * helpers (both node-safe). Only the boundary deps are mocked:
 * Prisma tenant lookup, the tenant-context runner, the policy
 * repository, the audit emitter, and the read-policy assertion.
 *
 * Branch classes exercised:
 *   • parseSections: no-heading body, single `# Heading`, multiple
 *     headings, pre-heading prose then heading, `##`/`-` body
 *     transforms, empty-section "(no content)" arm, empty-content
 *     fallback section.
 *   • classification arms: default INTERNAL, explicit PUBLIC (no
 *     watermark), CONFIDENTIAL + RESTRICTED (DRAFT watermark band).
 *   • optional meta: category present/absent, nextReviewAt
 *     present/absent, ownerName present/absent, currentVersion
 *     present/absent (versionNumber + effectiveAt fallbacks).
 *   • tenant lookup present vs absent (name fallback).
 *   • not-found policy throws.
 */

const mockDbHolder: { db: any } = { db: {} };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDbHolder.db)),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

jest.mock('@/app-layer/policies/common', () => ({ assertCanRead: jest.fn() }));

const getByIdMock = jest.fn();
jest.mock('@/app-layer/repositories/PolicyRepository', () => ({
    PolicyRepository: { getById: (...args: any[]) => getByIdMock(...args) },
}));

const tenantFindUniqueMock = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenant: { findUnique: (...args: any[]) => tenantFindUniqueMock(...args) } },
}));

import { generatePolicyDocumentPdf } from '@/app-layer/reports/pdf/policyDocument';
import { logEvent } from '@/app-layer/events/audit';
import { assertCanRead } from '@/app-layer/policies/common';
import { makeRequestContext } from '../../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

/** Drain a buffered PDFKit document into a Buffer for assertions. */
function drain(doc: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}

/** Build a policy object as PolicyRepository.getById would return it. */
function makePolicy(overrides?: any): any {
    return {
        id: 'pol-1',
        title: 'Acceptable Use Policy',
        category: 'Security',
        lifecycleVersion: 3,
        nextReviewAt: new Date('2026-12-01T00:00:00.000Z'),
        owner: { name: 'Jane Owner' },
        currentVersion: {
            versionNumber: 4,
            contentText: '# Purpose\nThis is the purpose.\n\n# Scope\nApplies to all.',
            createdAt: new Date('2026-01-15T00:00:00.000Z'),
        },
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDbHolder.db = {};
    tenantFindUniqueMock.mockResolvedValue({ name: 'Acme Corp' });
    getByIdMock.mockResolvedValue(makePolicy());
});

describe('generatePolicyDocumentPdf — happy path & audit', () => {
    it('returns a non-empty PDF buffer, asserts read access, and audits the export', async () => {
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);

        expect(buf.length).toBeGreaterThan(0);
        expect(buf.slice(0, 4).toString()).toBe('%PDF');
        expect(assertCanRead).toHaveBeenCalledWith(ctx);
        // Audit fires AFTER build with the export action + default classification.
        const call = (logEvent as jest.Mock).mock.calls[0];
        expect(call[2].action).toBe('POLICY_EXPORTED');
        expect(call[2].detailsJson.after.classification).toBe('INTERNAL');
    });
});

describe('generatePolicyDocumentPdf — the granular read key', () => {
    it('refuses a role whose policies.view is off, before reading the policy', async () => {
        const base = makeRequestContext('EDITOR');
        const denied = {
            ...base,
            appPermissions: { ...base.appPermissions, policies: { ...base.appPermissions.policies, view: false } },
        };
        getByIdMock.mockClear();
        await expect(generatePolicyDocumentPdf(denied, 'pol-1')).rejects.toThrow(/permission to view policies/);
        expect(getByIdMock).not.toHaveBeenCalled();
    });
});

describe('parseSections branches', () => {
    it('multiple top-level headings + `##` and `-` body transforms', async () => {
        getByIdMock.mockResolvedValue(
            makePolicy({
                currentVersion: {
                    versionNumber: 2,
                    contentText:
                        '# Purpose\n## Sub heading\n- bullet one\n- bullet two\n\n# Scope\nMore prose.',
                    createdAt: new Date('2026-02-02T00:00:00.000Z'),
                },
            }),
        );
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('pre-heading prose opens an implicit "Policy" section, then a heading', async () => {
        getByIdMock.mockResolvedValue(
            makePolicy({
                currentVersion: {
                    versionNumber: 1,
                    contentText: 'Intro prose before any heading.\n\n# Purpose\nThe purpose.',
                    createdAt: new Date('2026-03-03T00:00:00.000Z'),
                },
            }),
        );
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('body with no heading at all → single fallback "Policy" section', async () => {
        getByIdMock.mockResolvedValue(
            makePolicy({
                currentVersion: {
                    versionNumber: 1,
                    contentText: 'Just a flat body with no markdown headings at all.',
                    createdAt: new Date('2026-04-04T00:00:00.000Z'),
                },
            }),
        );
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('empty content → empty-section "(no content)" arm', async () => {
        getByIdMock.mockResolvedValue(
            makePolicy({
                currentVersion: {
                    versionNumber: 1,
                    contentText: '',
                    createdAt: new Date('2026-05-05T00:00:00.000Z'),
                },
            }),
        );
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('heading present but its body is blank → "(no content)" inside a real section', async () => {
        getByIdMock.mockResolvedValue(
            makePolicy({
                currentVersion: {
                    versionNumber: 1,
                    contentText: '# Empty Section\n\n   \n',
                    createdAt: new Date('2026-06-06T00:00:00.000Z'),
                },
            }),
        );
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });
});

describe('classification arms', () => {
    it('PUBLIC → watermark NONE', async () => {
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1', { classification: 'PUBLIC' });
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
        expect((logEvent as jest.Mock).mock.calls[0][2].detailsJson.after.classification).toBe('PUBLIC');
    });

    it('CONFIDENTIAL → DRAFT watermark band', async () => {
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1', { classification: 'CONFIDENTIAL' });
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('RESTRICTED → DRAFT watermark band', async () => {
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1', { classification: 'RESTRICTED' });
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });
});

describe('optional meta + fallback branches', () => {
    it('no currentVersion → versionNumber/effectiveAt/content fallbacks', async () => {
        getByIdMock.mockResolvedValue(
            makePolicy({
                currentVersion: null,
                lifecycleVersion: 7,
            }),
        );
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('no currentVersion AND no lifecycleVersion → version defaults to 1', async () => {
        getByIdMock.mockResolvedValue(
            makePolicy({ currentVersion: null, lifecycleVersion: null }),
        );
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('absent category / nextReviewAt / owner → optional rows skipped', async () => {
        getByIdMock.mockResolvedValue(
            makePolicy({
                category: null,
                nextReviewAt: null,
                owner: null,
                currentVersion: {
                    versionNumber: 2,
                    contentText: '# Only\nbody',
                    createdAt: 'not-a-date' as any, // non-Date createdAt → effectiveAt null branch
                },
            }),
        );
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('owner present but name null, nextReviewAt non-Date → both optional rows skipped', async () => {
        getByIdMock.mockResolvedValue(
            makePolicy({
                owner: { name: null },
                nextReviewAt: 'nope' as any,
            }),
        );
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('tenant lookup returns null → tenantName falls back to "Tenant"', async () => {
        tenantFindUniqueMock.mockResolvedValue(null);
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('tenant present but empty name → tenantName falls back to "Tenant"', async () => {
        tenantFindUniqueMock.mockResolvedValue({ name: '' });
        const doc = await generatePolicyDocumentPdf(ctx, 'pol-1');
        const buf = await drain(doc);
        expect(buf.length).toBeGreaterThan(0);
    });
});

describe('not-found path', () => {
    it('throws when the policy repo returns null', async () => {
        getByIdMock.mockResolvedValue(null);
        await expect(generatePolicyDocumentPdf(ctx, 'missing')).rejects.toThrow('Policy not found');
        expect(logEvent).not.toHaveBeenCalled();
    });
});
