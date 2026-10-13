/**
 * Epic 60 — Automation schema integrity.
 *
 * The persistence foundation is load-bearing for every future
 * automation-builder feature. This suite pins the parts that can
 * silently drift between schema edits and migrations:
 *
 *   1. **Enum membership.** The Prisma enums, the TypeScript union
 *      types in `automation/types.ts`, and the runtime catalogue
 *      in `automation/events.ts` must all agree.
 *   2. **Unique constraints + FK behaviour.** `(tenantId, name)`
 *      on rules and `(tenantId, idempotencyKey)` on executions
 *      are the dedupe primitives the dispatcher depends on. FK
 *      RESTRICT on Tenant + Rule protects execution history from
 *      accidental cascade deletion.
 *   3. **JSON column shape + defaults.** `status = DRAFT`,
 *      `triggeredBy = 'event'`, `deletedAt` nullable — these
 *      defaults are why the app layer is thin.
 *
 * DB-backed checks use the live Postgres via `prismaTestClient()`.
 * The enum-vs-catalogue checks are pure TypeScript and always run.
 */

import {
    AutomationRuleStatus,
    AutomationExecutionStatus,
    AutomationActionType,
    Prisma,
} from '@prisma/client';
import { DB_AVAILABLE } from '../integration/db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

// ─── Always-on compile+runtime enum checks ─────────────────────────────

describe('Automation schema — enum integrity (Prisma ↔ TypeScript)', () => {
    test('AutomationRuleStatus has exactly the 4 expected members', () => {
        expect(Object.keys(AutomationRuleStatus).sort()).toEqual(
            ['ARCHIVED', 'DISABLED', 'DRAFT', 'ENABLED'].sort()
        );
    });

    test('AutomationExecutionStatus has exactly the 5 expected members', () => {
        expect(Object.keys(AutomationExecutionStatus).sort()).toEqual(
            ['FAILED', 'PENDING', 'RUNNING', 'SKIPPED', 'SUCCEEDED'].sort()
        );
    });

    test('AutomationActionType has exactly the 6 expected members', () => {
        expect(Object.keys(AutomationActionType).sort()).toEqual(
            // VR-7 added INVOKE_SUBFLOW; #3471 added INVOKE_AGENT.
            //
            // This reads the GENERATED CLIENT, which is why it is a registration
            // point the source-reading `automation-action-vocabulary` guard
            // cannot name: with a stale client it passes for a schema that has
            // already moved, and regenerating is what makes it speak.
            [
                'CREATE_TASK',
                'INVOKE_AGENT',
                'INVOKE_SUBFLOW',
                'NOTIFY_USER',
                'UPDATE_STATUS',
                'WEBHOOK',
            ].sort()
        );
    });
});

// ─── DB-backed schema integrity checks ─────────────────────────────────

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUFFIX = `schema_${Date.now()}`;
const tenantSlug = `auto-schema-${SUFFIX}`;
const otherTenantSlug = `auto-schema-other-${SUFFIX}`;

describeFn('Automation schema — DB constraints (live Postgres)', () => {
    let prisma: PrismaClient;
    let tenantId: string;
    let otherTenantId: string;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const tenant = await prisma.tenant.upsert({
            where: { slug: tenantSlug },
            update: {},
            create: { name: 'Automation Schema Test', slug: tenantSlug },
        });
        tenantId = tenant.id;

        const other = await prisma.tenant.upsert({
            where: { slug: otherTenantSlug },
            update: {},
            create: { name: 'Other', slug: otherTenantSlug },
        });
        otherTenantId = other.id;
    });

    afterAll(async () => {
        try {
            await prisma.automationExecution.deleteMany({
                where: { tenantId: { in: [tenantId, otherTenantId] } },
            });
            await prisma.automationRule.deleteMany({
                where: { tenantId: { in: [tenantId, otherTenantId] } },
            });
            await prisma.tenant.deleteMany({
                where: { id: { in: [tenantId, otherTenantId] } },
            });
        } catch {
            /* best effort */
        }
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await prisma.automationExecution.deleteMany({
            where: { tenantId: { in: [tenantId, otherTenantId] } },
        });
        await prisma.automationRule.deleteMany({
            where: { tenantId: { in: [tenantId, otherTenantId] } },
        });
    });

    describe('AutomationRule', () => {
        test('migration is applied (model reachable via Prisma)', async () => {
            // A simple findMany proves the table + indexes + FKs exist.
            const rows = await prisma.automationRule.findMany({
                where: { tenantId },
                take: 1,
            });
            expect(Array.isArray(rows)).toBe(true);
        });

        test('status defaults to DRAFT when not supplied', async () => {
            const rule = await prisma.automationRule.create({
                data: {
                    tenantId,
                    name: `default-status-${SUFFIX}`,
                    triggerEvent: 'RISK_CREATED',
                    actionType: 'NOTIFY_USER',
                    actionConfigJson: { userIds: ['u'], message: 'm' },
                },
            });
            expect(rule.status).toBe('DRAFT');
            expect(rule.priority).toBe(0);
            expect(rule.executionCount).toBe(0);
            expect(rule.deletedAt).toBeNull();
        });

        test('(tenantId, name) is unique per tenant', async () => {
            const name = `dup-name-${SUFFIX}`;
            await prisma.automationRule.create({
                data: {
                    tenantId,
                    name,
                    triggerEvent: 'RISK_CREATED',
                    actionType: 'NOTIFY_USER',
                    actionConfigJson: {},
                },
            });

            await expect(
                prisma.automationRule.create({
                    data: {
                        tenantId,
                        name,
                        triggerEvent: 'RISK_CREATED',
                        actionType: 'NOTIFY_USER',
                        actionConfigJson: {},
                    },
                })
            ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
        });

        test('same name is allowed in different tenants', async () => {
            const name = `cross-tenant-${SUFFIX}`;
            await prisma.automationRule.create({
                data: {
                    tenantId,
                    name,
                    triggerEvent: 'RISK_CREATED',
                    actionType: 'NOTIFY_USER',
                    actionConfigJson: {},
                },
            });

            // Must not throw — uniqueness is scoped to tenant.
            const other = await prisma.automationRule.create({
                data: {
                    tenantId: otherTenantId,
                    name,
                    triggerEvent: 'RISK_CREATED',
                    actionType: 'NOTIFY_USER',
                    actionConfigJson: {},
                },
            });
            expect(other.tenantId).toBe(otherTenantId);
        });

        test('triggerFilterJson accepts null (optional filter)', async () => {
            const rule = await prisma.automationRule.create({
                data: {
                    tenantId,
                    name: `nullable-filter-${SUFFIX}`,
                    triggerEvent: 'RISK_CREATED',
                    triggerFilterJson: Prisma.JsonNull,
                    actionType: 'NOTIFY_USER',
                    actionConfigJson: {},
                },
            });
            expect(rule.triggerFilterJson).toBeNull();
        });

        test('deleting a tenant with rules is RESTRICTED (FK ON DELETE RESTRICT)', async () => {
            const ephemeral = await prisma.tenant.create({
                data: {
                    name: 'ephemeral',
                    slug: `ephemeral-${SUFFIX}`,
                },
            });
            await prisma.automationRule.create({
                data: {
                    tenantId: ephemeral.id,
                    name: `fk-restrict-${SUFFIX}`,
                    triggerEvent: 'RISK_CREATED',
                    actionType: 'NOTIFY_USER',
                    actionConfigJson: {},
                },
            });

            await expect(
                prisma.tenant.delete({ where: { id: ephemeral.id } })
            ).rejects.toThrow();

            // Clean up: remove the rule first, then the tenant.
            await prisma.automationRule.deleteMany({
                where: { tenantId: ephemeral.id },
            });
            await prisma.tenant.delete({ where: { id: ephemeral.id } });
        });
    });

    describe('AutomationExecution', () => {
        let ruleId: string;

        beforeEach(async () => {
            const rule = await prisma.automationRule.create({
                data: {
                    tenantId,
                    name: `exec-parent-${SUFFIX}-${Math.random()}`,
                    triggerEvent: 'RISK_CREATED',
                    actionType: 'NOTIFY_USER',
                    actionConfigJson: {},
                    status: 'ENABLED',
                },
            });
            ruleId = rule.id;
        });

        test('status defaults to PENDING and triggeredBy to "event"', async () => {
            const exec = await prisma.automationExecution.create({
                data: {
                    tenantId,
                    ruleId,
                    triggerEvent: 'RISK_CREATED',
                    triggerPayloadJson: { title: 't' },
                },
            });
            expect(exec.status).toBe('PENDING');
            expect(exec.triggeredBy).toBe('event');
            expect(exec.idempotencyKey).toBeNull();
            expect(exec.completedAt).toBeNull();
        });

        test('(tenantId, idempotencyKey) is unique when key is set', async () => {
            const key = `dup-idem-${SUFFIX}`;
            await prisma.automationExecution.create({
                data: {
                    tenantId,
                    ruleId,
                    triggerEvent: 'RISK_CREATED',
                    triggerPayloadJson: {},
                    idempotencyKey: key,
                },
            });

            await expect(
                prisma.automationExecution.create({
                    data: {
                        tenantId,
                        ruleId,
                        triggerEvent: 'RISK_CREATED',
                        triggerPayloadJson: {},
                        idempotencyKey: key,
                    },
                })
            ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
        });

        test('multiple rows with null idempotencyKey coexist', async () => {
            // Postgres treats NULLs as distinct in unique constraints,
            // which is exactly what we want: rules without stableKey
            // may legitimately fire many executions.
            await prisma.automationExecution.create({
                data: {
                    tenantId,
                    ruleId,
                    triggerEvent: 'RISK_CREATED',
                    triggerPayloadJson: {},
                    idempotencyKey: null,
                },
            });
            await prisma.automationExecution.create({
                data: {
                    tenantId,
                    ruleId,
                    triggerEvent: 'RISK_CREATED',
                    triggerPayloadJson: {},
                    idempotencyKey: null,
                },
            });
            const count = await prisma.automationExecution.count({
                where: { tenantId, ruleId },
            });
            expect(count).toBe(2);
        });

        test('deleting a rule with executions is RESTRICTED (FK ON DELETE RESTRICT)', async () => {
            await prisma.automationExecution.create({
                data: {
                    tenantId,
                    ruleId,
                    triggerEvent: 'RISK_CREATED',
                    triggerPayloadJson: {},
                },
            });

            await expect(
                prisma.automationRule.delete({ where: { id: ruleId } })
            ).rejects.toThrow();
        });

        test('execution survives archiving its parent rule (soft delete)', async () => {
            const exec = await prisma.automationExecution.create({
                data: {
                    tenantId,
                    ruleId,
                    triggerEvent: 'RISK_CREATED',
                    triggerPayloadJson: {},
                },
            });
            await prisma.automationRule.update({
                where: { id: ruleId },
                data: { status: 'ARCHIVED', deletedAt: new Date() },
            });

            const found = await prisma.automationExecution.findUnique({
                where: { id: exec.id },
            });
            expect(found).not.toBeNull();
            // Rule is still reachable by id — only its status/deletedAt
            // flipped, so execution history joins continue to work.
            const rule = await prisma.automationRule.findUnique({
                where: { id: ruleId },
            });
            expect(rule?.status).toBe('ARCHIVED');
            expect(rule?.deletedAt).toBeInstanceOf(Date);
        });

        test('status enum rejects unknown values at the DB layer', async () => {
            // Prisma would reject at the TS level; this test uses raw
            // SQL to bypass and prove the Postgres enum itself rejects.
            await expect(
                prisma.$executeRawUnsafe(
                    `INSERT INTO "AutomationExecution"
                     ("id", "tenantId", "ruleId", "triggerEvent",
                      "triggerPayloadJson", "status", "createdAt")
                     VALUES
                     ($1, $2, $3, $4, $5, $6, now())`,
                    `bad-${SUFFIX}-${Math.random()}`,
                    tenantId,
                    ruleId,
                    'RISK_CREATED',
                    '{}',
                    'BOGUS_STATUS'
                )
            ).rejects.toThrow();
        });
    });
});
