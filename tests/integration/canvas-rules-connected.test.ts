/**
 * Integration — an automation canvas and its rules stay connected.
 *
 * Proven against a real database through the real usecases:
 *
 *   • Saving an automation map gives a NEW Action step one rule, named after
 *     the step, with no trigger chosen, and the save's response carries the
 *     rule's id so the open canvas can use it.
 *   • Saving the same step again WITHOUT the id, which is what the canvas did
 *     before it read the response, creates no second rule. It used to: one
 *     more "Canvas rule" per autosave, for as long as the map stayed open.
 *   • A save does not store the display-only rule status the load merges in.
 *   • That rule cannot be enabled until it has a trigger and a complete action,
 *     and once it has them it can.
 *   • The rule knows its step: the Rules tab's "Open on canvas" names the map
 *     and the step.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createProcessMap, saveProcessMap } from '@/app-layer/usecases/process-map';
import {
    getAutomationRule,
    toggleAutomationRule,
    updateAutomationRule,
} from '@/app-layer/usecases/automation-rules';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `crc-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${TAG}`;
let adminId: string;
let ctx: ReturnType<typeof makeRequestContext>;

const step = (dataJson: Record<string, unknown> | null) => ({
    nodeKey: 'a1',
    nodeType: 'action',
    label: 'Notify the risk owner',
    subtitle: null,
    posX: 0,
    posY: 0,
    parentNodeKey: null,
    dataJson,
});

const ruleIdOf = (map: { nodes: Array<{ nodeKey: string; dataJson: unknown }> }, key: string) =>
    (map.nodes.find((n) => n.nodeKey === key)?.dataJson as { ruleId?: string } | null)?.ruleId;

describeFn('an automation canvas and its rules stay connected', () => {
    beforeAll(async () => {
        await db.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: `t ${TAG}`, slug: TENANT },
        });
        const email = `${TAG}-admin@example.test`;
        const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
        adminId = u.id;
        await db.tenantMembership.create({
            data: { tenantId: TENANT, userId: u.id, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
        });
        ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: adminId });
    });

    afterAll(async () => {
        try {
            await deleteAuditRowsForTenants(db, TENANT);
            await db.processEdge.deleteMany({ where: { tenantId: TENANT } });
            await db.processNode.deleteMany({ where: { tenantId: TENANT } });
            await db.processMap.deleteMany({ where: { tenantId: TENANT } });
            await db.automationRule.deleteMany({ where: { tenantId: TENANT } });
            await db.tenantMembership.deleteMany({ where: { tenantId: TENANT } });
            if (adminId) await db.user.deleteMany({ where: { id: adminId } });
            await db.tenant.delete({ where: { id: TENANT } });
        } catch {
            /* best effort */
        }
        await db.$disconnect();
    });

    test('one step, one rule, however many times it is saved', async () => {
        const map = await createProcessMap(ctx, { name: `${TAG} flow`, canvasMode: 'AUTOMATION' } as never);

        const first = await saveProcessMap(ctx, map.id, { nodes: [step({ color: 'blue' })], edges: [] } as never);
        const ruleId = ruleIdOf(first, 'a1');
        expect(ruleId).toBeTruthy();

        const rule = await db.automationRule.findUniqueOrThrow({ where: { id: ruleId! } });
        expect(rule.name).toBe('Notify the risk owner');
        expect(rule.triggerEvent).toBe('UNSET');
        expect(rule.status).toBe('DRAFT');

        // The canvas as it was: the step again, without the id the save made,
        // and with the display fields a load merges in.
        const second = await saveProcessMap(ctx, map.id, {
            nodes: [step({ color: 'blue', ruleStatus: 'DRAFT', executionCount: 0, ruleSubtitle: 'x' })],
            edges: [],
        } as never);
        expect(ruleIdOf(second, 'a1')).toBe(ruleId);
        expect(await db.automationRule.count({ where: { tenantId: TENANT, deletedAt: null } })).toBe(1);

        const stored = await db.processNode.findFirstOrThrow({ where: { processMapId: map.id, nodeKey: 'a1' } });
        expect(stored.dataJson).toEqual({ color: 'blue', ruleId });

        // Not enabled until it is complete…
        await expect(toggleAutomationRule(ctx, ruleId!, 'ENABLED')).rejects.toThrow(
            /cannot be enabled yet: choose the event that triggers it, and complete its action settings/,
        );
        expect((await db.automationRule.findUniqueOrThrow({ where: { id: ruleId! } })).status).toBe('DRAFT');

        // …and it knows its step.
        const detail = await getAutomationRule(ctx, ruleId!);
        expect(detail.readiness).toEqual(['TRIGGER_NOT_SET', 'ACTION_INCOMPLETE']);
        expect(detail.canvas).toEqual({
            mapId: map.id,
            mapName: `${TAG} flow`,
            nodeKey: 'a1',
            stepLabel: 'Notify the risk owner',
        });

        // Given a trigger and an action, it can be enabled.
        await updateAutomationRule(ctx, ruleId!, {
            triggerEvent: 'RISK_CREATED',
            actionType: 'NOTIFY_USER',
            actionConfig: { userIds: [adminId], message: 'A risk was raised' },
        } as never);
        const enabled = await toggleAutomationRule(ctx, ruleId!, 'ENABLED');
        expect(enabled.status).toBe('ENABLED');
        expect(enabled.readiness).toEqual([]);
    });

    test('a rule written on the Rules tab has no canvas step', async () => {
        const row = await db.automationRule.create({
            data: {
                tenantId: TENANT,
                name: `${TAG} tab rule`,
                triggerEvent: 'RISK_CREATED',
                actionType: 'NOTIFY_USER',
                actionConfigJson: { userIds: [adminId], message: 'x' },
                createdByUserId: adminId,
            },
        });
        expect((await getAutomationRule(ctx, row.id)).canvas).toBeNull();
    });
});
