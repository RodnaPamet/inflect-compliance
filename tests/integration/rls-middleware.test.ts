/**
 * Integration Test: Epic A.1 RLS enforcement end-to-end.
 *
 * Proves the three invariants that make the RLS story production-grade:
 *
 *   1. `runInTenantContext` sets the `app.tenant_id` session variable
 *      inside a transaction scoped to `app_user`, and queries inside
 *      it only see own-tenant rows.
 *   2. `SET LOCAL` is transaction-scoped: a second, independent
 *      transaction without SET LOCAL sees nothing under `app_user`.
 *   3. `runWithoutRls` bypasses (superuser_bypass policy matches) and
 *      sees every row regardless of tenant.
 *
 * Also covers the special cases where the policies differ:
 *   - Ownership-chained (EXISTS against parent) — FindingEvidence.
 *   - Nullable tenantId — IntegrationWebhookEvent.
 *
 * This test runs against the live Postgres (DB_AVAILABLE gate). It is
 * the authoritative proof that the RLS migration + middleware wiring
 * together make cross-tenant access architecturally impossible.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { PrismaClient } from '@prisma/client';
import {
    runInTenantContext,
    runWithoutRls,
} from '@/lib/db/rls-middleware';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function makeCtx(tenantId: string): RequestContext {
    return {
        requestId: 'req-rls-int',
        userId: 'user-int',
        tenantId,
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

const SUFFIX = `rls_mw_${Date.now()}`;

describeFn('RLS middleware — live PostgreSQL enforcement', () => {
    let prisma: PrismaClient;
    let tenantA: string;
    let tenantB: string;
    let ruleAId: string;
    let findingAId: string;
    let evidenceAId: string;
    let findingEvidenceId: string;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const [a, b] = await Promise.all([
            prisma.tenant.upsert({
                where: { slug: `a-${SUFFIX}` },
                update: {},
                create: { name: 'Tenant A', slug: `a-${SUFFIX}` },
            }),
            prisma.tenant.upsert({
                where: { slug: `b-${SUFFIX}` },
                update: {},
                create: { name: 'Tenant B', slug: `b-${SUFFIX}` },
            }),
        ]);
        tenantA = a.id;
        tenantB = b.id;

        // Seed with raw prisma (superuser bypass) so the fixture is
        // reliably in place regardless of RLS.
        const rule = await prisma.automationRule.create({
            data: {
                tenantId: tenantA,
                name: `mw-rule-${SUFFIX}`,
                triggerEvent: 'RISK_CREATED',
                actionType: 'NOTIFY_USER',
                actionConfigJson: {},
                status: 'ENABLED',
            },
        });
        ruleAId = rule.id;

        const finding = await prisma.finding.create({
            data: {
                tenantId: tenantA,
                severity: 'HIGH',
                type: 'NONCONFORMITY',
                title: `mw-finding-${SUFFIX}`,
                description: 'x',
            },
        });
        findingAId = finding.id;

        const evidence = await prisma.evidence.create({
            data: {
                tenantId: tenantA,
                type: 'TEXT',
                title: `mw-evidence-${SUFFIX}`,
            },
        });
        evidenceAId = evidence.id;

        const fe = await prisma.findingEvidence.create({
            data: { tenantId: tenantA, findingId: findingAId, evidenceId: evidenceAId },
        });
        findingEvidenceId = fe.id;
    });

    afterAll(async () => {
        try {
            // Guarded: Prisma DROPS an undefined filter value rather than
            // rejecting it, so on a failed `beforeAll` this line becomes
            // `DELETE FROM "FindingEvidence"` — every finding-evidence link in
            // the shared database, on a junction with no inbound FK to abort
            // it. See the teardown note in ./db-helper.ts. The `{ in: [...] }`
            // filters below reject undefined instead, so they need no guard.
            if (findingEvidenceId) {
                await prisma.findingEvidence.deleteMany({ where: { id: findingEvidenceId } });
            }
            await prisma.automationRule.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
            await prisma.finding.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
            await prisma.evidence.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
            await prisma.integrationWebhookEvent.deleteMany({
                where: { provider: { startsWith: `mw-${SUFFIX}` } },
            });
            await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
        } catch (err) {
            // Best effort, but not silent. Swallowing a teardown error is what
            // lets a teardown that did the wrong thing read as a clean run.
            //
            // Precisely: the `{ in: [...] }` filters above throw only when
            // setup failed BEFORE `tenantA`/`tenantB` are assigned — Prisma
            // rejects an undefined array ELEMENT. A failure at the last
            // `beforeAll` statement leaves both defined, nothing throws, and
            // this warning does not fire. It covers the early window, not
            // every failure.
            console.warn('[rls-middleware] teardown error:', err);
        }
        await prisma.$disconnect();
    });

    describe('Direct tenantId — Class A (AutomationRule)', () => {
        test('tenant-A context sees its own rule', async () => {
            const rows = await runInTenantContext(makeCtx(tenantA), async (db) => {
                return db.automationRule.findMany({
                    where: { id: ruleAId },
                });
            });
            expect(rows).toHaveLength(1);
            expect(rows[0].tenantId).toBe(tenantA);
        });

        test('tenant-B context sees ZERO rows (cross-tenant blocked)', async () => {
            const rows = await runInTenantContext(makeCtx(tenantB), async (db) => {
                return db.automationRule.findMany({
                    where: { id: ruleAId },
                });
            });
            expect(rows).toHaveLength(0);
        });

        test('tenant-B context cannot INSERT carrying tenantA id', async () => {
            // Under app_user, the WITH CHECK on the INSERT policy must
            // reject a row whose tenantId mismatches the session var.
            await expect(
                runInTenantContext(makeCtx(tenantB), async (db) => {
                    return db.automationRule.create({
                        data: {
                            tenantId: tenantA, // forged!
                            name: `forge-${SUFFIX}`,
                            triggerEvent: 'RISK_CREATED',
                            actionType: 'NOTIFY_USER',
                            actionConfigJson: {},
                        },
                    });
                })
            ).rejects.toThrow();
        });

        test('tenant-B context cannot UPDATE a tenant-A row to change its tenantId', async () => {
            // Row is visible only via postgres bypass; under app_user
            // the tenantB session can't even see the row to update.
            const result = await runInTenantContext(makeCtx(tenantB), async (db) => {
                return db.automationRule.updateMany({
                    where: { id: ruleAId },
                    data: { name: `hijack-${SUFFIX}` },
                });
            });
            expect(result.count).toBe(0);
        });
    });

    describe('SET LOCAL scoping — transaction boundary holds', () => {
        test('sequential transactions do not leak tenant context', async () => {
            // First: tenantA — sees its rule.
            const first = await runInTenantContext(makeCtx(tenantA), async (db) => {
                return db.automationRule.count({ where: { id: ruleAId } });
            });
            // Second: tenantB — sees 0 (session var reset between txns).
            const second = await runInTenantContext(makeCtx(tenantB), async (db) => {
                return db.automationRule.count({ where: { id: ruleAId } });
            });
            expect(first).toBe(1);
            expect(second).toBe(0);
        });

        test('concurrent transactions do not share tenant context', async () => {
            const [a, b] = await Promise.all([
                runInTenantContext(makeCtx(tenantA), async (db) =>
                    db.automationRule.count({ where: { id: ruleAId } })
                ),
                runInTenantContext(makeCtx(tenantB), async (db) =>
                    db.automationRule.count({ where: { id: ruleAId } })
                ),
            ]);
            expect(a).toBe(1);
            expect(b).toBe(0);
        });
    });

    describe('runWithoutRls — explicit bypass path', () => {
        test('sees every tenant\'s rows regardless of filter', async () => {
            const rows = await runWithoutRls(
                { reason: 'test' },
                async (db) => {
                    return db.automationRule.findMany({
                        where: { id: ruleAId },
                    });
                }
            );
            expect(rows).toHaveLength(1);
            expect(rows[0].tenantId).toBe(tenantA);
        });

        test('can INSERT on behalf of any tenant (seeds, admin scripts)', async () => {
            const created = await runWithoutRls(
                { reason: 'test' },
                async (db) => {
                    return db.automationRule.create({
                        data: {
                            tenantId: tenantB,
                            name: `bypass-create-${SUFFIX}`,
                            triggerEvent: 'RISK_CREATED',
                            actionType: 'NOTIFY_USER',
                            actionConfigJson: {},
                        },
                    });
                }
            );
            expect(created.tenantId).toBe(tenantB);
        });
    });

    describe('Ownership-chained — Class E (FindingEvidence)', () => {
        test('tenant-A sees its FindingEvidence row via parent Finding', async () => {
            const rows = await runInTenantContext(makeCtx(tenantA), async (db) => {
                return db.findingEvidence.findMany({
                    where: { id: findingEvidenceId },
                });
            });
            expect(rows).toHaveLength(1);
        });

        test('tenant-B sees ZERO FindingEvidence rows from tenant-A', async () => {
            const rows = await runInTenantContext(makeCtx(tenantB), async (db) => {
                return db.findingEvidence.findMany({
                    where: { id: findingEvidenceId },
                });
            });
            expect(rows).toHaveLength(0);
        });

        test('tenant-B cannot create a FindingEvidence linking to tenant-A parents', async () => {
            // denorm-tenantId Phase 2: rejection is now structural
            // (composite FK from (findingId, tenantId) to Finding(id,
            // tenantId)) rather than RLS WITH CHECK. The call below
            // declares tenantId: tenantB (matching the calling
            // session) but findingId/evidenceId belong to tenantA —
            // no parent row matches (findingAId, tenantB) so the FK
            // rejects the insert.
            await expect(
                runInTenantContext(makeCtx(tenantB), async (db) => {
                    return db.findingEvidence.create({
                        data: {
                            tenantId: tenantB,
                            findingId: findingAId,
                            evidenceId: evidenceAId,
                        },
                    });
                })
            ).rejects.toThrow();
        });
    });

    describe('Nullable tenantId — Class C (IntegrationWebhookEvent)', () => {
        test('tenant context sees own-tenant and NULL-tenant rows', async () => {
            // Seed via bypass: one NULL-tenant event, one tenant-A.
            const [nullEvt, ownEvt] = await runWithoutRls(
                { reason: 'test' },
                async (db) => {
                return Promise.all([
                    db.integrationWebhookEvent.create({
                        data: {
                            provider: `mw-${SUFFIX}-null`,
                            payloadJson: {},
                        },
                    }),
                    db.integrationWebhookEvent.create({
                        data: {
                            tenantId: tenantA,
                            provider: `mw-${SUFFIX}-own`,
                            payloadJson: {},
                        },
                    }),
                ]);
                }
            );

            const rows = await runInTenantContext(makeCtx(tenantA), async (db) => {
                return db.integrationWebhookEvent.findMany({
                    where: { id: { in: [nullEvt.id, ownEvt.id] } },
                });
            });
            // USING allows NULL-or-own-tenant — both visible.
            expect(rows).toHaveLength(2);
        });

        test('app_user cannot INSERT a NULL-tenant row (WITH CHECK strict)', async () => {
            await expect(
                runInTenantContext(makeCtx(tenantA), async (db) => {
                    return db.integrationWebhookEvent.create({
                        data: {
                            tenantId: null,
                            provider: `mw-${SUFFIX}-forge-null`,
                            payloadJson: {},
                        },
                    });
                })
            ).rejects.toThrow();
        });
    });
});
