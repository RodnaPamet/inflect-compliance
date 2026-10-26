/**
 * Two list-page faults found while writing the help guides, against a live
 * Postgres:
 *
 *   - A multi-select facet's value arrives comma-joined, and the Controls
 *     Owner filter and the Policies Category filter compared the joined
 *     string for equality, so picking two values matched nothing (#4275,
 *     #4279).
 *   - The "Deleted controls" view listed every control, deleted or not, and
 *     ignored the page's filters (#4275). Its Health filter still matched
 *     nothing, because the verdict scan read live controls only (#4325).
 *
 * RUN: npx jest tests/integration/list-multi-select-and-deleted-views.test.ts
 */
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { listControls, listControlsWithDeleted } from '@/app-layer/usecases/control';
import { listPolicies } from '@/app-layer/usecases/policy';

const prisma = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('multi-select list filters and the deleted-controls view (integration)', () => {
    const runId = randomUUID().slice(0, 12);
    let tenantId = '';
    let ownerA = '';
    let ownerB = '';
    let ownerC = '';
    let ctx: ReturnType<typeof makeRequestContext>;

    beforeAll(async () => {
        const tenant = await prisma.tenant.create({ data: { name: `lmd-${runId}`, slug: `lmd-${runId}` } });
        tenantId = tenant.id;
        const mkUser = (tag: string) =>
            prisma.user.create({ data: { email: `lmd-${tag}-${runId}@test.com`, name: `LMD ${tag}` } });
        [ownerA, ownerB, ownerC] = (await Promise.all([mkUser('a'), mkUser('b'), mkUser('c')])).map((u) => u.id);
        ctx = makeRequestContext(Role.ADMIN, { userId: ownerA, tenantId, tenantSlug: tenant.slug });
    });

    afterAll(async () => {
        // The test client audits each create, and those rows hold the tenant.
        await deleteAuditRowsForTenants(prisma, tenantId);
        await prisma.policy.deleteMany({ where: { tenantId } });
        await prisma.control.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { id: { in: [ownerA, ownerB, ownerC] } } });
        await prisma.tenant.delete({ where: { id: tenantId } });
    });

    const mkControl = (
        name: string,
        data: { ownerUserId?: string; deletedAt?: Date; applicability?: 'APPLICABLE' | 'NOT_APPLICABLE' } = {},
    ) =>
        prisma.control.create({ data: { tenantId, name: `${name} ${runId}`, ...data } });

    it('the Owner filter returns the controls of every owner picked', async () => {
        const a = await mkControl('Owned A', { ownerUserId: ownerA });
        const b = await mkControl('Owned B', { ownerUserId: ownerB });
        const c = await mkControl('Owned C', { ownerUserId: ownerC });

        const ids = async (ownerUserId: string) =>
            ((await listControls(ctx, { q: runId, ownerUserId })) as Array<{ id: string }>)
                .map((r) => r.id)
                .sort();

        // Positive control: one owner was always fine.
        expect(await ids(ownerA)).toEqual([a.id]);
        // Two owners, as the facet sends them: both, and not the third.
        expect(await ids(`${ownerA},${ownerB}`)).toEqual([a.id, b.id].sort());
        expect(await ids(`${ownerA},${ownerB}`)).not.toContain(c.id);
    });

    it('the Deleted view lists only deleted controls, under the page filters', async () => {
        const live = await mkControl('Live', { ownerUserId: ownerA });
        const goneA = await mkControl('Gone A', { ownerUserId: ownerA, deletedAt: new Date() });
        const goneB = await mkControl('Gone B', { ownerUserId: ownerB, deletedAt: new Date() });

        const deleted = (await listControlsWithDeleted(ctx, { q: runId })) as Array<{
            id: string;
            deletedAt: Date | null;
            owner: { id: string } | null;
            taskTotal: number;
        }>;
        const ids = deleted.map((r) => r.id);
        expect(ids).toEqual(expect.arrayContaining([goneA.id, goneB.id]));
        expect(ids).not.toContain(live.id);
        expect(deleted.every((r) => r.deletedAt !== null)).toBe(true);
        // The same columns as the live list: the owner is joined, and the
        // task count is attached.
        expect(deleted.find((r) => r.id === goneA.id)?.owner?.id).toBe(ownerA);
        expect(deleted.every((r) => typeof r.taskTotal === 'number')).toBe(true);

        // A filter narrows the deleted view as it narrows the live one.
        const byOwner = (await listControlsWithDeleted(ctx, { q: runId, ownerUserId: ownerB })) as Array<{
            id: string;
        }>;
        expect(byOwner.map((r) => r.id)).toEqual([goneB.id]);
    });

    it('the Health filter narrows the Deleted view, and each deleted row carries its verdict', async () => {
        const liveNa = await mkControl('Live NA', { applicability: 'NOT_APPLICABLE' });
        const goneNa = await mkControl('Gone NA', { applicability: 'NOT_APPLICABLE', deletedAt: new Date() });
        // NOT_STARTED with no test runs: no operating signal at all.
        const goneUnknown = await mkControl('Gone unknown', { deletedAt: new Date() });

        type Row = { id: string; healthVerdict: string | null };
        const na = (await listControlsWithDeleted(ctx, { q: runId, health: 'NOT_APPLICABLE' })) as Row[];
        // The deleted N/A control — not the live one, and not the other deleted one.
        expect(na.map((r) => r.id)).toEqual([goneNa.id]);
        expect(na.map((r) => r.id)).not.toContain(liveNa.id);
        expect(na[0].healthVerdict).toBe('NOT_APPLICABLE');

        const all = (await listControlsWithDeleted(ctx, { q: runId })) as Row[];
        expect(all.find((r) => r.id === goneUnknown.id)?.healthVerdict).toBe('UNKNOWN');
    });

    it('the Category filter returns the policies of every category picked', async () => {
        const mkPolicy = (tag: string, category: string) =>
            prisma.policy.create({
                data: { tenantId, slug: `lmd-${tag}-${runId}`, title: `Policy ${tag} ${runId}`, category },
            });
        const hr = await mkPolicy('hr', 'HR');
        const ops = await mkPolicy('ops', 'Operations');
        const other = await mkPolicy('other', 'Other');
        // Category is free text, so one category can itself hold a comma.
        const comma = await mkPolicy('comma', 'Legal, Regulatory');

        const ids = async (category: string) =>
            ((await listPolicies(ctx, { q: runId, category })) as Array<{ id: string }>)
                .map((r) => r.id)
                .sort();

        expect(await ids('HR')).toEqual([hr.id]);
        expect(await ids('HR,Operations')).toEqual([hr.id, ops.id].sort());
        expect(await ids('HR,Operations')).not.toContain(other.id);
        // The comma-bearing category still matches when picked alone.
        expect(await ids('Legal, Regulatory')).toEqual([comma.id]);
    });
});
