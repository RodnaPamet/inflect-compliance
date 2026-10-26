/**
 * Unarchiving evidence the retention sweep archived returns it to the active
 * list, and the next sweep leaves it there (#4277).
 *
 * Before the fix, `unarchiveEvidence` cleared only `isArchived`. The sweep
 * sets `expiredAt` too, and the Active view requires `expiredAt: null`, so the
 * row stayed under Archived marked Expired. With its retention date still
 * past, the next nightly sweep archived it again. Setting a new retention date
 * did not clear `expiredAt` either, so the 365-day purge clock kept running.
 *
 * The way back (owner decision): while the retention date has passed,
 * Unarchive is refused (`RETENTION_DATE_PASSED`) and changes nothing; a new
 * or empty retention date ends the expiry, and Unarchive then returns the row.
 *
 * RUN: npx jest tests/integration/evidence-unarchive-restores.test.ts
 */
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { listEvidence } from '@/app-layer/usecases/evidence';
import { unarchiveEvidence, updateEvidenceRetention } from '@/app-layer/usecases/evidence-retention';
import { runEvidenceRetentionSweep } from '@/app-layer/jobs/retention';

const prisma = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const DAY = 86_400_000;

describeFn('unarchiving expired evidence (integration)', () => {
    const runId = randomUUID().slice(0, 12);
    let tenantId = '';
    let userId = '';
    let ctx: ReturnType<typeof makeRequestContext>;

    beforeAll(async () => {
        const tenant = await prisma.tenant.create({ data: { name: `eur-${runId}`, slug: `eur-${runId}` } });
        tenantId = tenant.id;
        userId = (await prisma.user.create({ data: { email: `eur-${runId}@test.com`, name: 'EUR' } })).id;
        ctx = makeRequestContext(Role.EDITOR, { userId, tenantId, tenantSlug: tenant.slug });
    });

    afterAll(async () => {
        // The sweep and the usecases audit, and those rows hold the tenant.
        await deleteAuditRowsForTenants(prisma, tenantId);
        await prisma.evidence.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { id: userId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
    });

    /** A TEXT record whose retention lapsed, archived by a real sweep. */
    async function sweptEvidence(title: string) {
        const created = await prisma.evidence.create({
            data: {
                tenantId,
                type: 'TEXT',
                title: `${title} ${runId}`,
                content: 'note',
                createdAt: new Date(Date.now() - 60 * DAY),
                retentionPolicy: 'DAYS_AFTER_UPLOAD',
                retentionDays: 30,
                retentionUntil: new Date(Date.now() - 30 * DAY),
            },
        });
        await runEvidenceRetentionSweep({ tenantId });
        const swept = await prisma.evidence.findUniqueOrThrow({ where: { id: created.id } });
        // Positive control: the sweep did what the fix has to undo.
        expect(swept.isArchived).toBe(true);
        expect(swept.expiredAt).not.toBeNull();
        return swept;
    }

    const activeIds = async () =>
        ((await listEvidence(ctx, { q: runId, tab: 'active' })) as Array<{ id: string }>).map((r) => r.id);
    const archivedIds = async () =>
        ((await listEvidence(ctx, { q: runId, tab: 'archived' })) as Array<{ id: string }>).map((r) => r.id);

    it('refuses while the retention date has passed, then returns once a new date is set, and stays after the next sweep', async () => {
        const ev = await sweptEvidence('Unarchived');
        expect(await archivedIds()).toContain(ev.id);

        await expect(unarchiveEvidence(ctx, ev.id)).rejects.toMatchObject({
            details: { reason: 'RETENTION_DATE_PASSED' },
        });
        const refused = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id } });
        // Nothing changed: the schedule is not erased as a side effect.
        expect(refused).toMatchObject({
            isArchived: true,
            retentionPolicy: 'DAYS_AFTER_UPLOAD',
            retentionDays: 30,
        });
        expect(refused.expiredAt).not.toBeNull();
        expect(refused.retentionUntil?.getTime()).toBe(ev.retentionUntil?.getTime());

        // The way back: remove the date in Edit evidence, then unarchive.
        await updateEvidenceRetention(ctx, ev.id, { retentionPolicy: 'NONE', retentionUntil: null });
        await unarchiveEvidence(ctx, ev.id);

        expect(await activeIds()).toContain(ev.id);
        expect(await archivedIds()).not.toContain(ev.id);

        await runEvidenceRetentionSweep({ tenantId });

        const after = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id } });
        expect(after).toMatchObject({ isArchived: false, expiredAt: null, retentionUntil: null });
        expect(await activeIds()).toContain(ev.id);
    });

    it('a new retention date ends the expiry, so the purge clock stops', async () => {
        const ev = await sweptEvidence('Extended');

        await updateEvidenceRetention(ctx, ev.id, {
            retentionPolicy: 'FIXED_DATE',
            retentionUntil: new Date(Date.now() + 90 * DAY).toISOString(),
        });

        const after = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id } });
        expect(after.expiredAt).toBeNull();
        // Still archived: extending retention is not unarchiving.
        expect(after.isArchived).toBe(true);

        // Unarchiving keeps the date that is still ahead.
        await unarchiveEvidence(ctx, ev.id);
        const restored = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id } });
        expect(restored.isArchived).toBe(false);
        expect(restored.retentionUntil?.getTime()).toBe(after.retentionUntil?.getTime());
        expect(await activeIds()).toContain(ev.id);
    });
});
