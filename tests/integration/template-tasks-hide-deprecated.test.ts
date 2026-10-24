/**
 * A deprecated template task is never shown, counted or installed.
 *
 * `reconcileTemplateTasks` deprecates rather than deletes, so when authored
 * tasks replace the generic five the generic rows stay on the template,
 * deprecated. Install skipped them, but the framework template browser listed
 * them, and the install preview and the control-template list counted them. An
 * MGF template on production therefore showed ten tasks, four of them generic,
 * and promised ten while install created six.
 *
 * Each reader is driven here against one template holding a live task and a
 * deprecated generic one. The last assertion ties the preview's promise to what
 * install delivers, because that mismatch is the user-visible symptom.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { listTemplates } from '@/app-layer/usecases/framework/coverage';
import { previewPackInstall, installPack } from '@/app-layer/usecases/framework/install';
import { listControlTemplates } from '@/app-layer/usecases/control/mappings';
import { GENERIC_TEMPLATE_TASKS } from '../../prisma/generic-template-tasks';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `ttd-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const FRAMEWORK_KEY = `FW-${TAG}`;
const PACK_KEY = `PACK-${TAG}`;
const TEMPLATE_CODE = `${TAG}-T1`;
const LIVE_TITLE = 'Declare the authority limits of each agentic deployment';
// One of the generic five, as production holds it: deprecated beside the authored tasks.
const RETIRED_TITLE = GENERIC_TEMPLATE_TASKS[1].title;

let userId = '';
let frameworkId = '';
let templateId = '';

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.tenant.create({ data: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
    const email = `${TAG}@example.test`;
    userId = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
    });

    frameworkId = (await prisma.framework.create({ data: { key: FRAMEWORK_KEY, name: 'Fixture framework' } })).id;
    const requirement = await prisma.frameworkRequirement.create({
        data: { frameworkId, code: 'R-1', title: 'Fixture requirement' },
    });
    templateId = (await prisma.controlTemplate.create({ data: { code: TEMPLATE_CODE, title: 'Fixture control' } })).id;
    await prisma.controlTemplateRequirementLink.create({ data: { templateId, requirementId: requirement.id } });
    await prisma.controlTemplateTask.create({
        data: { templateId, title: LIVE_TITLE, sortOrder: 0 },
    });
    await prisma.controlTemplateTask.create({
        data: { templateId, title: RETIRED_TITLE, sortOrder: 0, deprecatedAt: new Date() },
    });
    const pack = await prisma.frameworkPack.create({ data: { key: PACK_KEY, name: 'Fixture pack', frameworkId } });
    await prisma.packTemplateLink.create({ data: { packId: pack.id, templateId } });
});

afterAll(async () => {
    if (DB_AVAILABLE) {
        await deleteAuditRowsForTenants(prisma, [TENANT_ID]);
        try { await prisma.task.deleteMany({ where: { tenantId: TENANT_ID } }); } catch { /* best effort */ }
        try { await prisma.controlRequirementLink.deleteMany({ where: { tenantId: TENANT_ID } }); } catch { /* best effort */ }
        try { await prisma.control.deleteMany({ where: { tenantId: TENANT_ID } }); } catch { /* best effort */ }
        try { await prisma.frameworkPack.deleteMany({ where: { key: PACK_KEY } }); } catch { /* best effort */ }
        try { await prisma.controlTemplate.deleteMany({ where: { id: templateId } }); } catch { /* best effort */ }
        try { await prisma.frameworkRequirement.deleteMany({ where: { frameworkId } }); } catch { /* best effort */ }
        try { await prisma.framework.deleteMany({ where: { id: frameworkId } }); } catch { /* best effort */ }
        try { await prisma.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } }); } catch { /* best effort */ }
        try { await prisma.user.deleteMany({ where: { id: userId } }); } catch { /* best effort */ }
        try { await prisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
    }
    await prisma.$disconnect();
});

describeFn('deprecated template tasks (integration)', () => {
    const ctx = () => makeRequestContext('ADMIN', { tenantId: TENANT_ID, userId, tenantSlug: TAG });

    it('the framework template browser lists only the live task', async () => {
        const templates = await listTemplates(ctx(), { frameworkKey: FRAMEWORK_KEY });
        const template = templates.find((t) => t.code === TEMPLATE_CODE);
        expect(template?.tasks.map((t) => t.title)).toEqual([LIVE_TITLE]);
    });

    it('the control-template list counts and returns only the live task', async () => {
        const templates = await listControlTemplates(ctx());
        const template = templates.find((t) => t.code === TEMPLATE_CODE);
        expect(template?._count.tasks).toBe(1);
        expect(template?.tasks.map((t) => t.title)).toEqual([LIVE_TITLE]);
    });

    it('the install preview promises exactly what install creates', async () => {
        const preview = await previewPackInstall(ctx(), PACK_KEY);
        const promised = preview.templates.find((t) => t.code === TEMPLATE_CODE)?.tasks;
        expect(promised).toBe(1);

        const result = await installPack(ctx(), PACK_KEY);
        expect(result.tasksCreated).toBe(promised);
        const created = await prisma.task.findMany({ where: { tenantId: TENANT_ID }, select: { title: true } });
        expect(created.map((t) => t.title)).toEqual([LIVE_TITLE]);
    });
});
