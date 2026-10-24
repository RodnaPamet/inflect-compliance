/**
 * `backfillTemplateTaskChecklists`, against a real database.
 *
 * Every rule the backfill holds is a row it must leave alone, so each fixture
 * below is a task that looks like a candidate in all respects but one — and the
 * single task meant to be filled is checked to come out with the template's
 * steps, sanitised and unticked. A second run proves the idempotence the
 * per-start entrypoint step depends on: it fills nothing and changes nothing.
 *
 * The backfill reads every tenant, so assertions are made on this file's own
 * rows rather than on the run's totals, which another suite's rows can move.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { backfillTemplateTaskChecklists } from '../../prisma/task-checklist-backfill';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `tcb-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const STEPS = [
    { text: { en: 'List every deployment able to act on its own' } },
    { text: { en: 'Record the authority limit for each <b>one</b>' }, hint: { en: 'Spend, reach and change' } },
    { text: { en: 'Have the accountable owner approve each record' } },
];

let userId = '';
let templateId = '';
const tmplTask: Record<'withSteps' | 'noSteps' | 'deprecated', string> = { withSteps: '', noSteps: '', deprecated: '' };
const task: Record<string, string> = {};

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.tenant.create({ data: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
    const email = `${TAG}@example.test`;
    userId = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
    });

    templateId = (await prisma.controlTemplate.create({ data: { code: `${TAG}-T`, title: 'Backfill fixture' } })).id;
    tmplTask.withSteps = (await prisma.controlTemplateTask.create({
        data: { templateId, title: 'Declare the authority limits', sortOrder: 0, stepsJson: STEPS },
    })).id;
    tmplTask.noSteps = (await prisma.controlTemplateTask.create({
        data: { templateId, title: 'Record the decision holders', sortOrder: 1 },
    })).id;
    tmplTask.deprecated = (await prisma.controlTemplateTask.create({
        data: { templateId, title: 'Withdrawn advice', sortOrder: 2, stepsJson: STEPS, deprecatedAt: new Date() },
    })).id;

    const make = async (key: string, data: Record<string, unknown>) => {
        task[key] = (await prisma.task.create({
            data: { tenantId: TENANT_ID, title: key, createdByUserId: userId, ...data },
        })).id;
    };
    await make('fill', { templateTaskId: tmplTask.withSteps, source: 'TEMPLATE' });
    await make('hasChecklist', {
        templateTaskId: tmplTask.withSteps,
        checklistJson: [{ id: 'mine', text: 'A step the tenant already ticked', done: true }],
    });
    await make('closed', { templateTaskId: tmplTask.withSteps, status: 'CLOSED' });
    await make('deleted', { templateTaskId: tmplTask.withSteps, deletedAt: new Date() });
    await make('noSteps', { templateTaskId: tmplTask.noSteps });
    await make('deprecated', { templateTaskId: tmplTask.deprecated });
    await make('handWritten', {});
});

afterAll(async () => {
    if (DB_AVAILABLE) {
        try { await prisma.task.deleteMany({ where: { tenantId: TENANT_ID } }); } catch { /* best effort */ }
        try { await prisma.controlTemplate.deleteMany({ where: { id: templateId } }); } catch { /* best effort */ }
        try { await prisma.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } }); } catch { /* best effort */ }
        try { await prisma.user.deleteMany({ where: { id: userId } }); } catch { /* best effort */ }
        try { await prisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
    }
    await prisma.$disconnect();
});

describeFn('backfillTemplateTaskChecklists (integration)', () => {
    const checklistOf = async (key: string) =>
        (await prisma.task.findUnique({ where: { id: task[key] }, select: { checklistJson: true } }))?.checklistJson;

    it('fills an open template task from its template steps, sanitised and unticked', async () => {
        const result = await backfillTemplateTaskChecklists(prisma);
        expect(result.filled).toBeGreaterThanOrEqual(1);

        const items = (await checklistOf('fill')) as Array<Record<string, unknown>>;
        expect(items.map((i) => ({ text: i.text, hint: i.hint, done: i.done }))).toEqual([
            { text: 'List every deployment able to act on its own', hint: undefined, done: false },
            { text: 'Record the authority limit for each one', hint: 'Spend, reach and change', done: false },
            { text: 'Have the accountable owner approve each record', hint: undefined, done: false },
        ]);
        expect(items.every((i) => typeof i.id === 'string' && (i.id as string).length > 0)).toBe(true);
    });

    it('leaves every other kind of task exactly as it was', async () => {
        expect(await checklistOf('hasChecklist')).toEqual([
            { id: 'mine', text: 'A step the tenant already ticked', done: true },
        ]);
        for (const key of ['closed', 'deleted', 'noSteps', 'deprecated', 'handWritten']) {
            expect({ key, checklist: await checklistOf(key) }).toEqual({ key, checklist: null });
        }
    });

    it('fills nothing on a second run, and keeps the ids it gave the first time', async () => {
        const before = await checklistOf('fill');
        await backfillTemplateTaskChecklists(prisma);
        expect(await checklistOf('fill')).toEqual(before);
    });
});
