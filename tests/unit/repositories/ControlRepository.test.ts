/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Branch-coverage unit test for ControlRepository.
 *
 * Pure unit test: every method takes a `db` (PrismaTx) parameter directly,
 * so we hand it a fake `db` whose model methods are `jest.fn()`s. No real
 * database, no `runInTenantContext`. `traceRepository` runs its no-op OTel
 * wrapper transparently in the test env.
 *
 * Each test names the branch class it protects: the `_buildWhere`
 * filter/status/applicability/owner/category/search arms, the cursor
 * AND-merge arms in `listPaginated`, the optional `take`, and the
 * not-found guards (`if (!existing) return null`) across every mutator.
 */

import { ControlRepository } from '@/app-layer/repositories/ControlRepository';
import { makeRequestContext } from '../../helpers/make-context';
import { encodeCursor } from '@/lib/pagination';

const ctx = makeRequestContext('ADMIN'); // tenantId: 'tenant-1', userId: 'user-1'

/** Build a fresh fake db with every model method this repo touches. */
function freshDb() {
    return {
        control: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn(),
            create: jest.fn().mockResolvedValue({ id: 'ctrl-1' }),
            update: jest.fn().mockResolvedValue({ id: 'ctrl-1' }),
            updateMany: jest.fn().mockResolvedValue({ count: 3 }),
        },
        controlRequirementLink: {
            findMany: jest.fn().mockResolvedValue([]),
        },
        controlContributor: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn(),
            create: jest.fn().mockResolvedValue({ id: 'contrib-1' }),
            delete: jest.fn().mockResolvedValue({}),
        },
        controlEvidenceLink: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn(),
            create: jest.fn().mockResolvedValue({ id: 'link-1' }),
            delete: jest.fn().mockResolvedValue({}),
        },
        controlAsset: {
            findFirst: jest.fn(),
            create: jest.fn().mockResolvedValue({ id: 'casset-1' }),
            delete: jest.fn().mockResolvedValue({}),
        },
        // Tenant-membership / file / asset existence guards. The repo now
        // verifies each body-supplied id belongs to the tenant before it
        // inserts a join row (FK checks bypass RLS), so the fake db must
        // carry the `findFirst` these guards call. Left bare here — each
        // happy-path / negative test drives the return via
        // `mockResolvedValueOnce`.
        tenantMembership: {
            findFirst: jest.fn(),
        },
        fileRecord: {
            findFirst: jest.fn(),
        },
        asset: {
            findFirst: jest.fn(),
        },
    };
}

let db: ReturnType<typeof freshDb>;

beforeEach(() => {
    jest.clearAllMocks();
    db = freshDb();
});

// ─── list + _buildWhere filter arms ───

describe('list / _buildWhere', () => {
    it('builds the tenant-OR-null base where with no filters and a bounded default take', async () => {
        // Branch: filters undefined → none of the optional arms apply;
        // options.take absent → the list still bounds itself with the
        // 500-row default cap (an unpaginated call can never stream an
        // unbounded result set).
        await ControlRepository.list(db as any, ctx);
        const arg = (db.control.findMany.mock.calls[0] as any[])[0];
        expect(arg.where).toEqual({ OR: [{ tenantId: 'tenant-1' }, { tenantId: null }] });
        expect(arg.orderBy).toEqual([{ code: 'asc' }, { annexId: 'asc' }]);
        expect(arg.take).toBe(500);
    });

    it('applies take when options.take is provided', async () => {
        // Branch: options.take truthy → spreads `take`.
        await ControlRepository.list(db as any, ctx, undefined, { take: 25 });
        const arg = (db.control.findMany.mock.calls[0] as any[])[0];
        expect(arg.take).toBe(25);
    });

    it('applies status, applicability, ownerUserId, category and search filters together', async () => {
        // Branches: status truthy; applicability === 'APPLICABLE'; ownerUserId
        // truthy; category truthy; q truthy → builds the OR-search AND clause.
        await ControlRepository.list(db as any, ctx, {
            status: 'IMPLEMENTED',
            applicability: 'APPLICABLE',
            ownerUserId: 'owner-9',
            category: 'CC',
            q: 'firewall',
        });
        const where = (db.control.findMany.mock.calls[0] as any[])[0].where;
        expect(where.status).toBe('IMPLEMENTED');
        expect(where.applicability).toBe('APPLICABLE');
        expect(where.ownerUserId).toBe('owner-9');
        expect(where.category).toBe('CC');
        expect(where.AND).toEqual([
            {
                OR: [
                    { name: { contains: 'firewall', mode: 'insensitive' } },
                    { code: { contains: 'firewall', mode: 'insensitive' } },
                    { objective: { contains: 'firewall', mode: 'insensitive' } },
                ],
            },
        ]);
    });

    it('accepts NOT_APPLICABLE applicability', async () => {
        // Branch: applicability === 'NOT_APPLICABLE' → set.
        await ControlRepository.list(db as any, ctx, { applicability: 'NOT_APPLICABLE' });
        const where = (db.control.findMany.mock.calls[0] as any[])[0].where;
        expect(where.applicability).toBe('NOT_APPLICABLE');
    });

    it('applies an `id: { in }` restriction from the ids branch (?ids= / health facet)', async () => {
        // Branch: filters.ids present → `where.id = { in: ids }` (server-side).
        await ControlRepository.list(db as any, ctx, { ids: ['c-1', 'c-2'] });
        const where = (db.control.findMany.mock.calls[0] as any[])[0].where;
        expect(where.id).toEqual({ in: ['c-1', 'c-2'] });
    });

    it('an EMPTY ids array restricts to zero rows (not "no restriction")', async () => {
        // A requested facet that matched nothing must yield `id in ()`, not all.
        await ControlRepository.list(db as any, ctx, { ids: [] });
        const where = (db.control.findMany.mock.calls[0] as any[])[0].where;
        expect(where.id).toEqual({ in: [] });
    });

    it('ignores an invalid applicability value', async () => {
        // Branch: applicability truthy but not one of the two allowed → skipped.
        await ControlRepository.list(db as any, ctx, { applicability: 'MAYBE' });
        const where = (db.control.findMany.mock.calls[0] as any[])[0].where;
        expect('applicability' in where).toBe(false);
    });
});

// ─── listPaginated + cursor AND-merge arms ───

describe('listPaginated', () => {
    it('paginates without a cursor (no where.AND)', async () => {
        // Branch: buildCursorWhere(undefined) → null → AND-merge skipped.
        db.control.findMany.mockResolvedValueOnce([]);
        const res = await ControlRepository.listPaginated(db as any, ctx, {});
        const arg = (db.control.findMany.mock.calls[0] as any[])[0];
        expect('AND' in arg.where).toBe(false);
        expect(arg.take).toBeGreaterThan(0);
        expect(res.pageInfo.hasNextPage).toBe(false);
    });

    it('merges a valid cursor into a fresh AND array (no pre-existing AND)', async () => {
        // Branch: cursorWhere truthy AND where.AND undefined → new array path.
        const cursor = encodeCursor({ createdAt: new Date().toISOString(), id: 'c-prev' });
        await ControlRepository.listPaginated(db as any, ctx, { cursor });
        const where = (db.control.findMany.mock.calls[0] as any[])[0].where;
        expect(Array.isArray(where.AND)).toBe(true);
        expect(where.AND).toHaveLength(1);
        expect(where.AND[0]).toHaveProperty('OR');
    });

    it('appends a cursor onto an existing search-filter AND array', async () => {
        // Branch: cursorWhere truthy AND where.AND already an array → concat.
        const cursor = encodeCursor({ createdAt: new Date().toISOString(), id: 'c-prev' });
        await ControlRepository.listPaginated(db as any, ctx, {
            cursor,
            filters: { q: 'audit' },
        });
        const where = (db.control.findMany.mock.calls[0] as any[])[0].where;
        expect(Array.isArray(where.AND)).toBe(true);
        // The q-search clause plus the cursor clause.
        expect(where.AND).toHaveLength(2);
    });

    it('computes hasNextPage true when an extra item is returned', async () => {
        // Branch: items.length > limit → trimmed + nextCursor set.
        const rows = Array.from({ length: 51 }, (_v, i) => ({
            id: `c${i}`,
            createdAt: new Date(2026, 0, 1, 0, 0, i),
        }));
        db.control.findMany.mockResolvedValueOnce(rows);
        const res = await ControlRepository.listPaginated(db as any, ctx, { limit: 50 });
        expect(res.items).toHaveLength(50);
        expect(res.pageInfo.hasNextPage).toBe(true);
        expect(res.pageInfo.nextCursor).toBeTruthy();
    });
});

// ─── getById / getHeaderById / listControlRequirementLinks ───

describe('read helpers', () => {
    it('getById queries findFirst with tenant-or-null scope and flattens the evidence join', async () => {
        // EP-3 — getById includes the `evidenceControlLinks` join and flattens
        // it back to a `control.evidence` array; the mock row must carry the
        // join so the `.map((l) => l.evidence)` flatten has something to read.
        db.control.findFirst.mockResolvedValueOnce({
            id: 'x',
            evidenceControlLinks: [{ evidence: { id: 'ev-1', title: 'E1' } }],
        });
        const res = await ControlRepository.getById(db as any, ctx, 'x');
        const arg = (db.control.findFirst.mock.calls[0] as any[])[0];
        expect(arg.where.id).toBe('x');
        expect(arg.where.OR).toEqual([{ tenantId: 'tenant-1' }, { tenantId: null }]);
        // Flattened back to the `evidence` array the detail page expects.
        expect((res as any).evidence).toEqual([{ id: 'ev-1', title: 'E1' }]);
    });

    it('getHeaderById queries findFirst with a _count include', async () => {
        db.control.findFirst.mockResolvedValueOnce({ id: 'x' });
        await ControlRepository.getHeaderById(db as any, ctx, 'x');
        const arg = (db.control.findFirst.mock.calls[0] as any[])[0];
        expect(arg.include._count).toBeTruthy();
    });

    it('listControlRequirementLinks reads canonical controlRequirementLink scoped to control + tenant', async () => {
        await ControlRepository.listControlRequirementLinks(db as any, ctx, 'ctrl-9');
        const arg = (db.controlRequirementLink.findMany.mock.calls[0] as any[])[0];
        expect(arg.where.controlId).toBe('ctrl-9');
        expect(arg.where.tenantId).toBe('tenant-1');
    });
});

// ─── create ───

describe('create', () => {
    it('injects tenantId into the create data', async () => {
        await ControlRepository.create(db as any, ctx, { code: 'A.1', name: 'n' } as any);
        const arg = (db.control.create.mock.calls[0] as any[])[0];
        expect(arg.data.tenantId).toBe('tenant-1');
        expect(arg.data.code).toBe('A.1');
    });
});

// ─── update — not-found guard ───

describe('update', () => {
    it('returns null when the control does not exist', async () => {
        // Branch: !existing → return null (no update issued).
        db.control.findFirst.mockResolvedValueOnce(null);
        const res = await ControlRepository.update(db as any, ctx, 'missing', { name: 'n' });
        expect(res).toBeNull();
        expect(db.control.update).not.toHaveBeenCalled();
    });

    it('updates when the control exists', async () => {
        // Branch: existing truthy → update.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        await ControlRepository.update(db as any, ctx, 'c1', { name: 'n' });
        expect(db.control.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { name: 'n' } });
    });
});

// ─── setApplicability — not-found + NA-justification arms ───

describe('setApplicability', () => {
    it('returns null when the control does not exist', async () => {
        // Branch: !existing → null.
        db.control.findFirst.mockResolvedValueOnce(null);
        expect(await ControlRepository.setApplicability(db as any, ctx, 'x', 'APPLICABLE', null)).toBeNull();
        expect(db.control.update).not.toHaveBeenCalled();
    });

    it('keeps the justification when marking NOT_APPLICABLE', async () => {
        // Branch: applicability === 'NOT_APPLICABLE' → justification persisted.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        await ControlRepository.setApplicability(db as any, ctx, 'c1', 'NOT_APPLICABLE', 'reason');
        const data = (db.control.update.mock.calls[0] as any[])[0].data;
        expect(data.applicability).toBe('NOT_APPLICABLE');
        expect(data.applicabilityJustification).toBe('reason');
        expect(data.applicabilityDecidedByUserId).toBe('user-1');
    });

    it('nulls the justification when marking APPLICABLE', async () => {
        // Branch: applicability !== 'NOT_APPLICABLE' → justification forced null.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        await ControlRepository.setApplicability(db as any, ctx, 'c1', 'APPLICABLE', 'ignored');
        const data = (db.control.update.mock.calls[0] as any[])[0].data;
        expect(data.applicability).toBe('APPLICABLE');
        expect(data.applicabilityJustification).toBeNull();
    });
});

// ─── setOwner — not-found guard ───

describe('setOwner', () => {
    it('returns null when the control does not exist', async () => {
        db.control.findFirst.mockResolvedValueOnce(null);
        expect(await ControlRepository.setOwner(db as any, ctx, 'x', 'owner-1')).toBeNull();
    });

    it('updates the owner when the control exists', async () => {
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        await ControlRepository.setOwner(db as any, ctx, 'c1', 'owner-7');
        expect((db.control.update.mock.calls[0] as any[])[0].data).toEqual({ ownerUserId: 'owner-7' });
    });
});

// ─── Contributors ───

describe('contributors', () => {
    it('listContributors filters by controlId + tenant', async () => {
        await ControlRepository.listContributors(db as any, ctx, 'c1');
        expect((db.controlContributor.findMany.mock.calls[0] as any[])[0].where).toEqual({
            controlId: 'c1',
            tenantId: 'tenant-1',
        });
    });

    it('addContributor returns null when the control is missing', async () => {
        // Branch: !control → null.
        db.control.findFirst.mockResolvedValueOnce(null);
        expect(await ControlRepository.addContributor(db as any, ctx, 'c1', 'u1')).toBeNull();
        expect(db.controlContributor.create).not.toHaveBeenCalled();
    });

    it('addContributor creates when the control exists and the user is an active member', async () => {
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        // The user must be an ACTIVE tenant member — an active membership row
        // lets the guard through to the insert.
        db.tenantMembership.findFirst.mockResolvedValueOnce({ id: 'm1' });
        await ControlRepository.addContributor(db as any, ctx, 'c1', 'u1');
        expect((db.controlContributor.create.mock.calls[0] as any[])[0].data).toMatchObject({
            tenantId: 'tenant-1',
            controlId: 'c1',
            userId: 'u1',
        });
    });

    it('addContributor throws notFound when the user is not an active member of the tenant', async () => {
        // Branch: control present, but tenantMembership.findFirst → null.
        // FK checks bypass RLS, so a cross-tenant / inactive userId must be
        // rejected here rather than inserted as a dangling contributor.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        db.tenantMembership.findFirst.mockResolvedValueOnce(null);
        await expect(ControlRepository.addContributor(db as any, ctx, 'c1', 'u1')).rejects.toThrow();
        expect(db.controlContributor.create).not.toHaveBeenCalled();
    });

    it('removeContributor returns null when the control is missing', async () => {
        // Branch: !control → null.
        db.control.findFirst.mockResolvedValueOnce(null);
        expect(await ControlRepository.removeContributor(db as any, ctx, 'c1', 'u1')).toBeNull();
    });

    it('removeContributor returns null when the link is missing', async () => {
        // Branch: control present, !link → null.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        db.controlContributor.findFirst.mockResolvedValueOnce(null);
        expect(await ControlRepository.removeContributor(db as any, ctx, 'c1', 'u1')).toBeNull();
        expect(db.controlContributor.delete).not.toHaveBeenCalled();
    });

    it('removeContributor deletes when both exist', async () => {
        // Branch: control + link present → delete + true.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        db.controlContributor.findFirst.mockResolvedValueOnce({ id: 'cc1' });
        expect(await ControlRepository.removeContributor(db as any, ctx, 'c1', 'u1')).toBe(true);
        expect(db.controlContributor.delete).toHaveBeenCalledWith({ where: { id: 'cc1' } });
    });
});


describe('evidence links', () => {
    it('listEvidenceLinks filters by controlId + tenant', async () => {
        await ControlRepository.listEvidenceLinks(db as any, ctx, 'c1');
        expect((db.controlEvidenceLink.findMany.mock.calls[0] as any[])[0].where).toEqual({
            controlId: 'c1',
            tenantId: 'tenant-1',
        });
    });

    it('linkEvidence returns null when the control is missing', async () => {
        // Branch: !control → null.
        db.control.findFirst.mockResolvedValueOnce(null);
        expect(
            await ControlRepository.linkEvidence(db as any, ctx, 'c1', { kind: 'LINK' }),
        ).toBeNull();
    });

    it('linkEvidence coerces optional fields with || null', async () => {
        // Branches: fileId/url/note all falsy → null defaults.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        await ControlRepository.linkEvidence(db as any, ctx, 'c1', { kind: 'FILE' });
        const data = (db.controlEvidenceLink.create.mock.calls[0] as any[])[0].data;
        expect(data).toMatchObject({ kind: 'FILE', fileId: null, url: null, note: null });
        expect(data.createdByUserId).toBe('user-1');
    });

    it('linkEvidence keeps provided optional fields', async () => {
        // Branches: fileId/url/note truthy → kept.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        // A provided fileId is verified against the tenant's FileRecords
        // before the insert; the matching row lets the guard through.
        db.fileRecord.findFirst.mockResolvedValueOnce({ id: 'f1' });
        await ControlRepository.linkEvidence(db as any, ctx, 'c1', {
            kind: 'LINK',
            fileId: 'f1',
            url: 'http://x',
            note: 'n',
        });
        const data = (db.controlEvidenceLink.create.mock.calls[0] as any[])[0].data;
        expect(data).toMatchObject({ fileId: 'f1', url: 'http://x', note: 'n' });
    });

    it('linkEvidence throws notFound when the fileId is not in the tenant', async () => {
        // Branch: control present, fileId supplied, but fileRecord.findFirst
        // → null. A cross-tenant fileId must be rejected before the insert,
        // not persisted as a link to a FileRecord the tenant cannot read.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        db.fileRecord.findFirst.mockResolvedValueOnce(null);
        await expect(
            ControlRepository.linkEvidence(db as any, ctx, 'c1', { kind: 'FILE', fileId: 'f1' }),
        ).rejects.toThrow();
        expect(db.controlEvidenceLink.create).not.toHaveBeenCalled();
    });

    it('unlinkEvidence returns null when the link is missing', async () => {
        // Branch: !link → null.
        db.controlEvidenceLink.findFirst.mockResolvedValueOnce(null);
        expect(await ControlRepository.unlinkEvidence(db as any, ctx, 'c1', 'l1')).toBeNull();
        expect(db.controlEvidenceLink.delete).not.toHaveBeenCalled();
    });

    it('unlinkEvidence deletes and returns true when present', async () => {
        db.controlEvidenceLink.findFirst.mockResolvedValueOnce({ id: 'l1' });
        expect(await ControlRepository.unlinkEvidence(db as any, ctx, 'c1', 'l1')).toBe(true);
        expect(db.controlEvidenceLink.delete).toHaveBeenCalledWith({ where: { id: 'l1' } });
    });
});

// ─── Asset linking ───

describe('asset linking', () => {
    it('linkAsset returns null when the control is missing', async () => {
        // Branch: !control → null.
        db.control.findFirst.mockResolvedValueOnce(null);
        expect(await ControlRepository.linkAsset(db as any, ctx, 'c1', 'a1')).toBeNull();
    });

    it('linkAsset creates the join row when the control exists and the asset is in the tenant', async () => {
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        // The assetId is verified against the tenant's assets before the
        // insert; the matching row lets the guard through.
        db.asset.findFirst.mockResolvedValueOnce({ id: 'a1' });
        await ControlRepository.linkAsset(db as any, ctx, 'c1', 'a1');
        expect((db.controlAsset.create.mock.calls[0] as any[])[0].data).toEqual({
            tenantId: 'tenant-1',
            controlId: 'c1',
            assetId: 'a1',
        });
    });

    it('linkAsset throws notFound when the asset is not in the tenant', async () => {
        // Branch: control present, but asset.findFirst → null. A cross-tenant
        // assetId must be rejected before the insert rather than persisted as
        // a join to an Asset the tenant cannot read.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        db.asset.findFirst.mockResolvedValueOnce(null);
        await expect(ControlRepository.linkAsset(db as any, ctx, 'c1', 'a1')).rejects.toThrow();
        expect(db.controlAsset.create).not.toHaveBeenCalled();
    });

    it('unlinkAsset returns null when the control is missing', async () => {
        // Branch: !control → null.
        db.control.findFirst.mockResolvedValueOnce(null);
        expect(await ControlRepository.unlinkAsset(db as any, ctx, 'c1', 'a1')).toBeNull();
    });

    it('unlinkAsset returns null when the join row is missing', async () => {
        // Branch: control present, !link → null.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        db.controlAsset.findFirst.mockResolvedValueOnce(null);
        expect(await ControlRepository.unlinkAsset(db as any, ctx, 'c1', 'a1')).toBeNull();
        expect(db.controlAsset.delete).not.toHaveBeenCalled();
    });

    it('unlinkAsset deletes when both exist', async () => {
        // Branch: control + link present → delete + true.
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1' });
        db.controlAsset.findFirst.mockResolvedValueOnce({ id: 'ca1' });
        expect(await ControlRepository.unlinkAsset(db as any, ctx, 'c1', 'a1')).toBe(true);
        expect(db.controlAsset.delete).toHaveBeenCalledWith({ where: { id: 'ca1' } });
    });
});

// ─── Bulk ───

describe('bulk', () => {
    it('listByIds scopes to the tenant and the id set', async () => {
        await ControlRepository.listByIds(db as any, ctx, ['a', 'b']);
        expect((db.control.findMany.mock.calls[0] as any[])[0].where).toEqual({
            id: { in: ['a', 'b'] },
            tenantId: 'tenant-1',
        });
    });

    it('bulkUpdate issues a tenant-scoped updateMany and returns the count', async () => {
        const res = await ControlRepository.bulkUpdate(db as any, ctx, ['a'], { status: 'IMPLEMENTED' } as any);
        expect((db.control.updateMany.mock.calls[0] as any[])[0]).toEqual({
            where: { id: { in: ['a'] }, tenantId: 'tenant-1' },
            data: { status: 'IMPLEMENTED' },
        });
        expect(res).toEqual({ count: 3 });
    });
});
