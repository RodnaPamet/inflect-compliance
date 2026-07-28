/**
 * Cross-tenant target validation for vendor associations.
 *
 * These four asserts sit in front of every vendor write that stores a
 * caller-supplied id. The row itself is written with ctx.tenantId, so RLS is
 * satisfied either way — what was missing is any check on the id it POINTS
 * AT. The failure mode is quiet: RLS then hides the foreign target from
 * every later read, so the association renders as a dangling id rather than
 * raising anything.
 *
 * Each assert must (a) scope its lookup to the caller's tenant, and
 * (b) fail CLOSED when the target does not resolve.
 */
import {
    assertTargetInTenant,
    assertBundleTargetInTenant,
    assertOwnerInTenant,
    assertFileInTenant,
} from '@/app-layer/usecases/vendor-link-targets';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('EDITOR');

/** A db stub whose every model resolves, unless a test says otherwise. */
function db(overrides: Record<string, unknown> = {}) {
    const hit = jest.fn(async () => ({ id: 'target-1' }));
    return {
        asset: { findFirst: hit },
        risk: { findFirst: hit },
        finding: { findFirst: hit },
        control: { findFirst: hit },
        evidence: { findFirst: hit },
        vendorDocument: { findFirst: hit },
        vendorAssessment: { findFirst: hit },
        tenantMembership: { findFirst: hit },
        fileRecord: { findFirst: hit },
        ...overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

describe('assertTargetInTenant — link targets', () => {
    it.each([
        ['ASSET', 'asset'],
        ['RISK', 'risk'],
        ['CONTROL', 'control'],
        ['EVIDENCE', 'evidence'],
    ])('resolves %s against its own model, tenant-scoped', async (type, model) => {
        const d = db();
        await assertTargetInTenant(d, ctx, type, 'x-1');
        const where = d[model].findFirst.mock.calls[0][0].where;
        expect(where).toEqual({ id: 'x-1', tenantId: ctx.tenantId });
    });

    it('routes ISSUE to the Finding model — there is no Issue table', async () => {
        const d = db();
        await assertTargetInTenant(d, ctx, 'ISSUE', 'f-1');
        expect(d.finding.findFirst).toHaveBeenCalled();
    });

    it('accepts a lowercase type', async () => {
        const d = db();
        await expect(assertTargetInTenant(d, ctx, 'asset', 'a-1')).resolves.toBeUndefined();
    });

    it('rejects a target that does not resolve', async () => {
        const d = db({ control: { findFirst: jest.fn(async () => null) } });
        await expect(
            assertTargetInTenant(d, ctx, 'CONTROL', 'foreign'),
        ).rejects.toThrow(/not found/i);
    });

    it('rejects an unknown entity type rather than skipping the check', async () => {
        // Falling through to "no validator, therefore fine" would be the
        // worst outcome — an unrecognised type must fail closed.
        await expect(
            assertTargetInTenant(db(), ctx, 'VENDOR_DOCUMENT', 'x'),
        ).rejects.toThrow(/Unsupported link entity type/i);
    });
});

describe('assertBundleTargetInTenant — bundle items', () => {
    it.each([
        ['VENDOR_DOCUMENT', 'vendorDocument'],
        ['ASSESSMENT', 'vendorAssessment'],
    ])('resolves %s tenant-scoped', async (type, model) => {
        const d = db();
        await assertBundleTargetInTenant(d, ctx, type, 'x-1');
        const where = d[model].findFirst.mock.calls[0][0].where;
        expect(where).toEqual({ id: 'x-1', tenantId: ctx.tenantId });
    });

    it('rejects a link-vocabulary type — the two sets do not overlap', async () => {
        await expect(
            assertBundleTargetInTenant(db(), ctx, 'ASSET', 'a-1'),
        ).rejects.toThrow(/Unsupported bundle item type/i);
    });

    it('rejects an unresolvable item', async () => {
        const d = db({ vendorAssessment: { findFirst: jest.fn(async () => null) } });
        await expect(
            assertBundleTargetInTenant(d, ctx, 'ASSESSMENT', 'foreign'),
        ).rejects.toThrow(/not found/i);
    });
});

describe('assertOwnerInTenant', () => {
    it('requires an ACTIVE membership in this tenant', async () => {
        const d = db();
        await assertOwnerInTenant(d, ctx, 'user-2');
        expect(d.tenantMembership.findFirst.mock.calls[0][0].where).toEqual({
            userId: 'user-2',
            tenantId: ctx.tenantId,
            status: 'ACTIVE',
        });
    });

    it('rejects a user with no active membership', async () => {
        // Covers both "member of another tenant" and "deactivated here" —
        // assigning ownership to either parks the vendor with nobody
        // accountable while review notifications keep addressing them.
        const d = db({ tenantMembership: { findFirst: jest.fn(async () => null) } });
        await expect(assertOwnerInTenant(d, ctx, 'ghost')).rejects.toThrow(
            /active member/i,
        );
    });
});

describe('assertFileInTenant', () => {
    it('scopes the lookup to the caller tenant', async () => {
        const d = db();
        await assertFileInTenant(d, ctx, 'file-1');
        expect(d.fileRecord.findFirst.mock.calls[0][0].where).toEqual({
            id: 'file-1',
            tenantId: ctx.tenantId,
        });
    });

    it('rejects a foreign fileId', async () => {
        // This id feeds the document text-extraction path, which reads the
        // object out of storage — an unchecked fileId is the front half of a
        // cross-tenant file read.
        const d = db({ fileRecord: { findFirst: jest.fn(async () => null) } });
        await expect(assertFileInTenant(d, ctx, 'foreign')).rejects.toThrow(
            /File not found/i,
        );
    });
});
