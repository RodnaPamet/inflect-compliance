/**
 * #5764 item 6 — the Training list reads its assignments a page at a time and
 * filters them in SQL, so every assignment is reachable and a filter covers
 * all of them, not the first page.
 *
 * Against a real database because what is under test is the query: the
 * keyset cursor over (createdAt, id) with ties, the case-insensitive search
 * through two relations, and the status filter that reads a stored ASSIGNED
 * past its due date as OVERDUE.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { listTrainingAssignments } from '@/app-layer/usecases/training';
import { TRAINING_PAGE_SIZE } from '@/lib/training-list';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `trpg-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const OTHER_TENANT = `t-${SUITE}-other`;

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});

const ctx = (tenantId = TENANT) => makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId });

/** More than two pages, so a walk crosses at least two cursors. */
const COUNT = TRAINING_PAGE_SIZE * 2 + 30;
const NOW = new Date('2026-11-18T12:00:00.000Z');
const BASE = new Date('2026-01-01T00:00:00.000Z').getTime();
/** The OLDEST rows sort last, so these sit on the last page of an unfiltered walk. */
const SECURE_INDEX = 5;
const PAST_DUE_INDEX = 3;
const STORED_OVERDUE_INDEX = 7;
const COMPLETED_INDEX = 9;

const ids: string[] = [];

async function walk(options: { q?: string; status?: string; limit?: number }) {
    const seen: string[] = [];
    const totals: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
        const page = await listTrainingAssignments(ctx(), { ...options, cursor }, NOW);
        seen.push(...page.rows.map((r) => r.id));
        totals.push(page.total);
        cursor = page.nextCursor;
        pages += 1;
        if (pages > 50) throw new Error('the walk did not end');
    } while (cursor !== null);
    return { seen, totals, pages };
}

describeFn('the Training list, paged and filtered on the server', () => {
    beforeAll(async () => {
        await prisma.$connect();
        for (const id of [TENANT, OTHER_TENANT]) {
            await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
        }
        const ada = await prisma.employee.create({
            data: { tenantId: TENANT, fullName: 'Ada Lovelace', workEmail: `ada-${SUITE}@acme.test` },
        });
        const grace = await prisma.employee.create({
            data: { tenantId: TENANT, fullName: 'Grace Hopper', workEmail: `grace-${SUITE}@acme.test` },
        });
        const phishing = await prisma.trainingCourse.create({ data: { tenantId: TENANT, name: 'Phishing basics' } });
        const secure = await prisma.trainingCourse.create({ data: { tenantId: TENANT, name: 'Secure Coding' } });

        const rows = Array.from({ length: COUNT }, (_, i) => {
            // Pairs share a createdAt, so the order must fall back to the id.
            const createdAt = new Date(BASE + Math.floor(i / 2) * 1000);
            const status =
                i === STORED_OVERDUE_INDEX ? 'OVERDUE' : i === COMPLETED_INDEX ? 'COMPLETED' : 'ASSIGNED';
            const dueAt =
                i === PAST_DUE_INDEX ? new Date('2026-06-01T00:00:00.000Z') : new Date('2099-01-01T00:00:00.000Z');
            return {
                id: `${SUITE}-${String(i).padStart(4, '0')}`,
                tenantId: TENANT,
                employeeId: i % 2 === 0 ? ada.id : grace.id,
                courseId: i === SECURE_INDEX ? secure.id : phishing.id,
                status: status as 'ASSIGNED' | 'OVERDUE' | 'COMPLETED',
                assignedAt: createdAt,
                createdAt,
                dueAt,
                completedAt: i === COMPLETED_INDEX ? createdAt : null,
            };
        });
        await prisma.trainingAssignment.createMany({ data: rows });
        ids.push(...rows.map((r) => r.id));

        // Another tenant's assignment, which no page and no count may include.
        const otherEmp = await prisma.employee.create({
            data: { tenantId: OTHER_TENANT, fullName: 'Ada Elsewhere', workEmail: `ada-${SUITE}@other.test` },
        });
        const otherCourse = await prisma.trainingCourse.create({ data: { tenantId: OTHER_TENANT, name: 'Secure Coding' } });
        await prisma.trainingAssignment.create({
            data: { tenantId: OTHER_TENANT, employeeId: otherEmp.id, courseId: otherCourse.id, status: 'ASSIGNED' },
        });
    });

    afterAll(async () => {
        for (const tenantId of [TENANT, OTHER_TENANT]) {
            await prisma.trainingAssignment.deleteMany({ where: { tenantId } });
            await prisma.trainingCourse.deleteMany({ where: { tenantId } });
            await prisma.employee.deleteMany({ where: { tenantId } });
        }
        // Audit rows reference the tenant: clear them through the helper that
        // lifts the immutability trigger, or this delete depends on suite order.
        await deleteAuditRowsForTenants(prisma, [TENANT, OTHER_TENANT]);
        await prisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER_TENANT] } } });
        await prisma.$disconnect();
    });

    it('walks every assignment, newest first, past the first page and through ties', async () => {
        const first = await listTrainingAssignments(ctx(), {}, NOW);
        expect(first.rows).toHaveLength(TRAINING_PAGE_SIZE);
        expect(first.total).toBe(COUNT);
        expect(first.nextCursor).not.toBeNull();

        const { seen, totals, pages } = await walk({});
        expect(pages).toBe(3);
        expect(totals.every((t) => t === COUNT)).toBe(true);
        expect(new Set(seen).size).toBe(COUNT);
        // createdAt DESC, then id DESC within a shared createdAt.
        expect(seen).toEqual([...ids].reverse());
    });

    it('a search reaches an assignment that lies past the first page', async () => {
        const first = await listTrainingAssignments(ctx(), {}, NOW);
        expect(first.rows.map((r) => r.id)).not.toContain(ids[SECURE_INDEX]);

        const found = await listTrainingAssignments(ctx(), { q: '  secure coding ' }, NOW);
        expect(found.rows.map((r) => r.id)).toEqual([ids[SECURE_INDEX]]);
        expect(found.total).toBe(1);
        expect(found.nextCursor).toBeNull();
    });

    it('the search covers the employee name and email too, and pages its matches', async () => {
        const byName = await walk({ q: 'GRACE', limit: 40 });
        const graceIds = ids.filter((_, i) => i % 2 === 1);
        expect(byName.pages).toBe(Math.ceil(graceIds.length / 40));
        expect(byName.seen).toEqual([...graceIds].reverse());
        expect(byName.totals.every((t) => t === graceIds.length)).toBe(true);

        const byEmail = await listTrainingAssignments(ctx(), { q: `ada-${SUITE}@` }, NOW);
        expect(byEmail.total).toBe(ids.filter((_, i) => i % 2 === 0).length);
    });

    it('Overdue finds a stored OVERDUE and an open assignment past its due date, wherever they sit', async () => {
        const overdue = await listTrainingAssignments(ctx(), { status: 'OVERDUE' }, NOW);
        expect(overdue.rows.map((r) => r.id).sort()).toEqual([ids[PAST_DUE_INDEX], ids[STORED_OVERDUE_INDEX]].sort());
        expect(overdue.total).toBe(2);
    });

    it('Assigned leaves out the assignment that is past due, and statuses combine', async () => {
        const assigned = await walk({ status: 'ASSIGNED' });
        expect(assigned.seen).not.toContain(ids[PAST_DUE_INDEX]);
        expect(assigned.seen).toHaveLength(COUNT - 3);

        const two = await listTrainingAssignments(ctx(), { status: ['COMPLETED,OVERDUE'] }, NOW);
        expect(two.total).toBe(3);
        expect(two.rows.map((r) => r.id).sort()).toEqual(
            [ids[PAST_DUE_INDEX], ids[STORED_OVERDUE_INDEX], ids[COMPLETED_INDEX]].sort(),
        );
    });

    it('a search and a status filter apply together', async () => {
        const page = await listTrainingAssignments(ctx(), { q: 'ada', status: 'OVERDUE' }, NOW);
        // PAST_DUE_INDEX (3) is Grace's; STORED_OVERDUE_INDEX (7) is Grace's too.
        expect(page.total).toBe(0);
        const graceOverdue = await listTrainingAssignments(ctx(), { q: 'grace', status: 'OVERDUE' }, NOW);
        expect(graceOverdue.total).toBe(2);
    });

    it('a malformed cursor reads as the first page, and the limit is clamped', async () => {
        const page = await listTrainingAssignments(ctx(), { cursor: 'not-a-cursor', limit: 10_000 }, NOW);
        expect(page.rows).toHaveLength(TRAINING_PAGE_SIZE);
        expect(page.rows[0].id).toBe(ids[ids.length - 1]);
    });
});
