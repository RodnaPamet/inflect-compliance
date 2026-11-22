/**
 * THE RISK USECASES EMIT THE RISK AUTOMATION TRIGGERS (found in the A2A
 * production pilot, 2026-11-22).
 *
 * The rule builder offered "Risk created", "Risk updated", "Risk status
 * changed" and "Risk controls mapped", and nothing emitted any of them: a rule
 * on one saved, enabled and never ran. Real usecases against Postgres, with
 * the bus's dispatcher replaced by a recorder (production's dispatcher puts
 * each event on the `automation-event-dispatch` queue). The last case hands a
 * recorded event to the real dispatcher job and sees the rule's execution.
 */
const enqueued: Array<{ name: string; payload: Record<string, unknown> }> = [];
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async (name: string, payload: Record<string, unknown>) => {
        enqueued.push({ name, payload });
        return undefined;
    }),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import {
    getAutomationBus,
    resetAutomationBus,
    toDispatchPayload,
    type AutomationDomainEvent,
} from '@/app-layer/automation';
import { runAutomationEventDispatch } from '@/app-layer/jobs/automation-event-dispatch';
import {
    bulkImportRisks,
    bulkSetRiskStatus,
    createRisk,
    linkControlToRisk,
    updateRisk,
} from '@/app-layer/usecases/risk';
import { emitRiskCreatedEvent } from '@/app-layer/usecases/risk-automation-events';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `riskev-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const OWNER = `u-${SUITE}`;

const ctx = () => makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: OWNER });

const recorded: AutomationDomainEvent[] = [];
const of = (event: string) => recorded.filter((e) => e.event === event);

async function cleanup(): Promise<void> {
    await prisma.notification.deleteMany({ where: { tenantId: TENANT } });
    await prisma.automationExecution.deleteMany({ where: { tenantId: TENANT } });
    await prisma.automationRule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.riskControl.deleteMany({ where: { tenantId: TENANT } });
    await prisma.riskScoreEvent.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "Risk" WHERE "tenantId" = $1`, TENANT);
        await tx.$executeRawUnsafe(`DELETE FROM "Control" WHERE "tenantId" = $1`, TENANT);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
    });
    await deleteAuditRowsForTenants(prisma, TENANT);
    await prisma.user.deleteMany({ where: { id: OWNER } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

describeFn('the risk usecases emit the risk automation triggers (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        await createTenantWithDek({ id: TENANT, name: TENANT, slug: TENANT });
        const email = `${OWNER}@example.test`;
        await prisma.user.create({ data: { id: OWNER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({ data: { tenantId: TENANT, userId: OWNER, role: 'OWNER', status: 'ACTIVE' } });
    });

    afterAll(async () => {
        resetAutomationBus();
        await cleanup();
        await prisma.$disconnect();
    });

    beforeEach(() => {
        recorded.length = 0;
        enqueued.length = 0;
        getAutomationBus().setDispatcher(async (e) => {
            recorded.push(e);
        });
    });

    it('creating a risk emits RISK_CREATED once, with its title, score, category and status', async () => {
        const risk = await createRisk(ctx(), { title: `Ransomware ${SUITE}`, category: 'Security', likelihood: 4, impact: 4 });
        expect(of('RISK_CREATED')).toHaveLength(1);
        const [evt] = of('RISK_CREATED');
        expect(evt).toMatchObject({
            tenantId: TENANT,
            entityType: 'Risk',
            entityId: risk.id,
            actorUserId: OWNER,
            stableKey: risk.id,
            data: { title: `Ransomware ${SUITE}`, score: risk.score, category: 'Security', status: 'OPEN' },
        });
    });

    it('the shared RISK_CREATED emitter keys the event on the risk, and carries a null category as null', async () => {
        await emitRiskCreatedEvent(ctx(), { id: `r-${SUITE}`, title: 'x', score: 9, category: null, status: 'ACCEPTED' });
        expect(of('RISK_CREATED')).toEqual([
            expect.objectContaining({
                entityId: `r-${SUITE}`,
                stableKey: `r-${SUITE}`,
                data: { title: 'x', score: 9, category: null, status: 'ACCEPTED' },
            }),
        ]);
    });

    it('a create that fails emits nothing', async () => {
        await expect(
            createRisk(ctx(), { title: `Orphan owner ${SUITE}`, ownerUserId: `nobody-${SUITE}` }),
        ).rejects.toThrow();
        expect(recorded).toEqual([]);
    });

    it('a CSV import emits RISK_CREATED once per created risk, and none for a skipped duplicate', async () => {
        const result = await bulkImportRisks(ctx(), [
            { title: `Imported A ${SUITE}` },
            { title: `Imported B ${SUITE}` },
            { title: `Imported A ${SUITE}` },
        ]);
        expect(result.created).toBe(2);
        expect(of('RISK_CREATED').map((e) => e.entityId).sort()).toEqual([...result.createdIds].sort());
    });

    it('an update emits RISK_UPDATED with the changed fields, and a status change RISK_STATUS_CHANGED', async () => {
        const risk = await createRisk(ctx(), { title: `To mitigate ${SUITE}` });
        recorded.length = 0;

        await updateRisk(ctx(), risk.id, { status: 'MITIGATING', treatmentNotes: 'patching' });
        expect(of('RISK_UPDATED')).toHaveLength(1);
        expect((of('RISK_UPDATED')[0].data as { changedFields: string[] }).changedFields.sort()).toEqual([
            'status',
            'treatmentNotes',
        ]);
        expect(of('RISK_STATUS_CHANGED').map((e) => e.data)).toEqual([{ fromStatus: 'OPEN', toStatus: 'MITIGATING' }]);

        recorded.length = 0;
        await updateRisk(ctx(), risk.id, { status: 'MITIGATING', treatmentNotes: 'still patching' });
        expect(of('RISK_UPDATED')).toHaveLength(1);
        expect(of('RISK_STATUS_CHANGED')).toEqual([]);
    });

    it('a bulk status change emits RISK_STATUS_CHANGED only for the risks whose status moved', async () => {
        const open = await createRisk(ctx(), { title: `Bulk open ${SUITE}` });
        const closed = await createRisk(ctx(), { title: `Bulk closed ${SUITE}` });
        await bulkSetRiskStatus(ctx(), [closed.id], 'CLOSED');
        recorded.length = 0;

        const { updated } = await bulkSetRiskStatus(ctx(), [open.id, closed.id], 'CLOSED');
        expect(updated).toBe(2);
        expect(of('RISK_STATUS_CHANGED').map((e) => ({ id: e.entityId, ...(e.data as object) }))).toEqual([
            { id: open.id, fromStatus: 'OPEN', toStatus: 'CLOSED' },
        ]);
    });

    it('mapping a control emits RISK_CONTROLS_MAPPED', async () => {
        const risk = await createRisk(ctx(), { title: `Mapped ${SUITE}` });
        const control = await prisma.control.create({ data: { tenantId: TENANT, name: `Control ${SUITE}` } });
        recorded.length = 0;

        await linkControlToRisk(ctx(), risk.id, control.id);
        expect(of('RISK_CONTROLS_MAPPED').map((e) => ({ id: e.entityId, ...(e.data as object) }))).toEqual([
            { id: risk.id, controlId: control.id, action: 'LINKED' },
        ]);
    });

    it('a recorded RISK_CREATED, dispatched, runs an enabled "Risk created" rule', async () => {
        const rule = await prisma.automationRule.create({
            data: {
                tenantId: TENANT,
                name: `notify-${SUITE}`,
                triggerEvent: 'RISK_CREATED',
                actionType: 'NOTIFY_USER',
                actionConfigJson: { userIds: [OWNER], message: 'a risk was created' },
                status: 'ENABLED',
                createdByUserId: OWNER,
            },
        });
        await createRisk(ctx(), { title: `Dispatched ${SUITE}` });
        const [evt] = of('RISK_CREATED');

        const dispatched = await runAutomationEventDispatch(toDispatchPayload(evt));
        expect(dispatched.executionsCreated).toBe(1);
        const execution = await prisma.automationExecution.findFirstOrThrow({
            where: { tenantId: TENANT, ruleId: rule.id },
            select: { status: true, triggerEvent: true },
        });
        expect(execution).toEqual({ status: 'SUCCEEDED', triggerEvent: 'RISK_CREATED' });
    });
});
