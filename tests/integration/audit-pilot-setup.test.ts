/**
 * THE PILOT SET-UP SCRIPT, RUN TWICE AGAINST A REAL DATABASE
 * (#3676, owner decision 8, 2026-10-19).
 *
 * `scripts/audit-pilot-setup.ts` is how step 3c's exit is met: it registers the
 * pilot auditor and schedules the five procedure plans through the real
 * usecases. What is asserted here is the contract it states:
 *
 *   - a dry run writes nothing, not even an audit row;
 *   - `--apply` reaches the state, and a second `--apply` writes nothing;
 *   - activation waits for the owner's risk assessment, then happens on a re-run;
 *   - the plans it scheduled run on the real runner and each writes a workpaper;
 *   - every named refusal is decided before the first write.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { runControlTestRunner, runnerHandlerRegistry } from '@/app-layer/jobs/control-test-runner';
import { registerAgenticControlTestHandler } from '@/app-layer/services/agent-control-tests';
import { LIBRARY_V1_PROCEDURE_IDS } from '@/lib/agentic/audit-procedure-library';
import {
    DEFAULT_AUDITOR_NAME,
    iso27001Identifiers,
    setUpAuditPilot,
    type PilotSetupOptions,
    type PilotSetupResult,
} from '../../scripts/audit-pilot-setup';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(300_000);

const SUITE = `apilot-${randomUUID().slice(0, 8)}`;
const OWNER = `${SUITE}-second`;
const FIRST = `${SUITE}-first`;
const OUTSIDER = `${SUITE}-outsider`;
const email = (id: string) => `${id}@example.test`;
const quiet = () => undefined;

async function seedUser(id: string): Promise<void> {
    await prisma.user.upsert({
        where: { id },
        update: {},
        create: { id, email: email(id), emailHash: hashForLookup(email(id)) },
    });
}

/** A tenant whose SECOND-line ADMIN will own the auditor, a FIRST-line OWNER, and the three Annex A controls the mapping reaches. */
async function seedTenant(label: string, opts: { controls?: boolean } = {}): Promise<{ tenantId: string; slug: string }> {
    const tenantId = `${SUITE}-${label}`;
    // With its DEK from the start, as every real tenant has: a tenant without one
    // is given one lazily on the first encrypted read, which would be a write the
    // dry run did not make.
    await createTenantWithDek({ id: tenantId, name: tenantId, slug: tenantId });
    await prisma.tenantMembership.createMany({
        data: [
            { tenantId, userId: OWNER, role: 'ADMIN', status: 'ACTIVE', lineOfDefence: 'SECOND' },
            { tenantId, userId: FIRST, role: 'OWNER', status: 'ACTIVE', lineOfDefence: 'FIRST' },
        ],
    });
    if (opts.controls !== false) {
        // One by `annexId`, two by the template's `code` spelling — both reach the mapping.
        await prisma.control.create({ data: { tenantId, name: 'Identity management', annexId: 'A.5.16', createdByUserId: FIRST } });
        await prisma.control.create({ data: { tenantId, name: 'Access rights', code: 'A-5.18', createdByUserId: FIRST } });
        await prisma.control.create({ data: { tenantId, name: 'Access control', code: 'A-5.15', createdByUserId: FIRST } });
    }
    return { tenantId, slug: tenantId };
}

const opts = (slug: string, extra: Partial<PilotSetupOptions> = {}): PilotSetupOptions => ({
    tenantSlug: slug,
    ownerEmail: email(OWNER),
    apply: false,
    log: quiet,
    ...extra,
});

/** Every row the script could write, counted. Equal before and after means it wrote nothing. */
async function footprint(tenantId: string) {
    const [agents, tools, plans, auditRows, aiSystems] = await Promise.all([
        prisma.registeredAgent.count({ where: { tenantId } }),
        prisma.registeredAgentTool.count({ where: { tenantId } }),
        prisma.controlTestPlan.count({ where: { tenantId } }),
        prisma.auditLog.count({ where: { tenantId } }),
        prisma.aiSystem.count({ where: { tenantId } }),
    ]);
    return { agents, tools, plans, auditRows, aiSystems };
}

const outcomes = (r: PilotSetupResult) => (r.ok ? Object.fromEntries(r.steps.map((s) => [s.step, s.outcome])) : {});

describeFn('scripts/audit-pilot-setup', () => {
    beforeAll(async () => {
        runnerHandlerRegistry._reset();
        registerAgenticControlTestHandler();
        for (const u of [OWNER, FIRST, OUTSIDER]) await seedUser(u);
    });

    afterAll(() => {
        runnerHandlerRegistry._reset();
    });

    it('maps each procedure by its ISO/IEC 27001:2022 identifiers, in catalogue order', () => {
        expect(iso27001Identifiers('iam.leaver_timeliness')).toEqual(['A.5.16', 'A.5.18', 'A.6.5']);
        // ISO/IEC 42001 A.9.4 is not an ISO/IEC 27001 Annex A control, and is not offered.
        expect(iso27001Identifiers('agent.authority_conformance')).toEqual(['A.5.15', 'A.8.2']);
    });

    describe('on a tenant with nothing set up', () => {
        let t: { tenantId: string; slug: string };
        beforeAll(async () => {
            t = await seedTenant('fresh');
        });

        it('a dry run reports every step and writes nothing', async () => {
            const before = await footprint(t.tenantId);
            const r = await setUpAuditPilot(opts(t.slug));
            expect(r.ok).toBe(true);
            expect(outcomes(r)).toEqual({
                'register auditor': 'WOULD_CHANGE',
                'grant propose_finding': 'WOULD_CHANGE',
                activate: 'PENDING',
                ...Object.fromEntries(LIBRARY_V1_PROCEDURE_IDS.map((p) => [`plan ${p}`, 'WOULD_CHANGE'])),
            });
            expect(await footprint(t.tenantId)).toEqual(before);
        });

        it('--apply registers the auditor, grants one tool, waits on the assessment and schedules five plans', async () => {
            const r = await setUpAuditPilot(opts(t.slug, { apply: true }));
            if (!r.ok) throw new Error(r.detail);
            expect(outcomes(r)).toMatchObject({
                'register auditor': 'CHANGED',
                'grant propose_finding': 'CHANGED',
                activate: 'PENDING',
            });
            expect(r.steps.find((s) => s.step === 'activate')?.detail).toMatch(/^UNSCORED/);

            const agent = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: r.agentId! },
                select: { name: true, isAuditor: true, status: true, ownerUserId: true, dataAccessScope: true, autonomyLevel: true },
            });
            expect(agent).toEqual({
                name: DEFAULT_AUDITOR_NAME,
                isAuditor: true,
                status: 'DRAFT',
                ownerUserId: OWNER,
                dataAccessScope: 'WRITE_TENANT_DATA',
                autonomyLevel: 2,
            });
            const tools = await prisma.registeredAgentTool.findMany({ where: { agentId: r.agentId! }, select: { toolName: true } });
            expect(tools.map((x) => x.toolName)).toEqual(['propose_finding']);

            const plans = await prisma.controlTestPlan.findMany({
                where: { tenantId: t.tenantId },
                select: { automationType: true, schedule: true, scheduleTimezone: true, automationConfig: true, ownerUserId: true, control: { select: { name: true } } },
            });
            const byProcedure = Object.fromEntries(
                plans.map((p) => [(p.automationConfig as { procedure: string }).procedure, p]),
            );
            expect(Object.keys(byProcedure).sort()).toEqual([...LIBRARY_V1_PROCEDURE_IDS].sort());
            expect(byProcedure['iam.leaver_timeliness']).toMatchObject({
                automationType: 'INTEGRATION',
                schedule: '17 6 2 * *',
                scheduleTimezone: 'UTC',
                ownerUserId: OWNER,
                automationConfig: { procedure: 'iam.leaver_timeliness', auditorAgentId: r.agentId, parameters: { leaverWindowHours: 24 } },
                control: { name: 'Identity management' },
            });
            expect(byProcedure['iam.recertification_completeness']).toMatchObject({
                schedule: '17 6 2 1,4,7,10 *',
                automationConfig: { parameters: { remediationWindowDays: 14 } },
                control: { name: 'Access rights' },
            });
            expect(byProcedure['agent.authority_conformance']).toMatchObject({ control: { name: 'Access control' } });
            expect(byProcedure['iam.privileged_access'].automationConfig).toEqual({
                procedure: 'iam.privileged_access',
                auditorAgentId: r.agentId,
            });
        });

        it('a second --apply changes nothing, not even an audit row', async () => {
            const before = await footprint(t.tenantId);
            const r = await setUpAuditPilot(opts(t.slug, { apply: true }));
            expect(outcomes(r)).toEqual({
                'register auditor': 'UNCHANGED',
                'grant propose_finding': 'UNCHANGED',
                activate: 'PENDING',
                ...Object.fromEntries(LIBRARY_V1_PROCEDURE_IDS.map((p) => [`plan ${p}`, 'UNCHANGED'])),
            });
            expect(await footprint(t.tenantId)).toEqual(before);
        });

        it('activates once the owner has assessed the agent, then is idempotent again', async () => {
            const agent = await prisma.registeredAgent.findFirstOrThrow({
                where: { tenantId: t.tenantId, name: DEFAULT_AUDITOR_NAME },
                select: { id: true },
            });
            // The owner's assessment, which the script never answers.
            await prisma.registeredAgent.update({ where: { id: agent.id }, data: { riskTier: 'LOW', riskTierScoredAt: new Date() } });

            const dry = await setUpAuditPilot(opts(t.slug));
            expect(outcomes(dry).activate).toBe('WOULD_CHANGE');
            const r = await setUpAuditPilot(opts(t.slug, { apply: true }));
            expect(outcomes(r).activate).toBe('CHANGED');
            expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agent.id } })).status).toBe('ACTIVE');

            const before = await footprint(t.tenantId);
            const again = await setUpAuditPilot(opts(t.slug, { apply: true }));
            expect(new Set(Object.values(outcomes(again)))).toEqual(new Set(['UNCHANGED']));
            expect(await footprint(t.tenantId)).toEqual(before);
        });

        it('leaves the plans runnable: each one runs on the real runner as the auditor and writes one workpaper', async () => {
            const plans = await prisma.controlTestPlan.findMany({
                where: { tenantId: t.tenantId },
                select: { id: true, automationConfig: true },
            });
            for (const plan of plans) {
                const result = await runControlTestRunner({
                    tenantId: t.tenantId,
                    testPlanId: plan.id,
                    scheduledForIso: new Date().toISOString(),
                    schedulerJobRunId: `${SUITE}-${plan.id}`,
                });
                const workpapers = await prisma.auditWorkpaper.findMany({
                    where: { controlTestRunId: result.runId ?? '' },
                    select: { procedureId: true },
                });
                expect(workpapers).toEqual([{ procedureId: (plan.automationConfig as { procedure: string }).procedure }]);
            }
        });

        it('reports a plan the second line has since changed, and does not overwrite it', async () => {
            const plan = await prisma.controlTestPlan.findFirstOrThrow({
                where: { tenantId: t.tenantId, automationConfig: { path: ['procedure'], equals: 'iam.leaver_timeliness' } },
            });
            const changed = { ...(plan.automationConfig as object), parameters: { leaverWindowHours: 48 } };
            await prisma.controlTestPlan.update({ where: { id: plan.id }, data: { automationConfig: changed } });
            const before = await footprint(t.tenantId);
            const r = await setUpAuditPilot(opts(t.slug, { apply: true }));
            expect(outcomes(r)['plan iam.leaver_timeliness']).toBe('DIFFERS');
            expect(await footprint(t.tenantId)).toEqual(before);
            expect((await prisma.controlTestPlan.findUniqueOrThrow({ where: { id: plan.id } })).automationConfig).toEqual(changed);
        });
    });

    it('takes an explicit control id over the mapping', async () => {
        const t = await seedTenant('explicit');
        const named = await prisma.control.create({ data: { tenantId: t.tenantId, name: 'Leaver process', createdByUserId: FIRST } });
        const r = await setUpAuditPilot(opts(t.slug, { apply: true, controls: { 'iam.leaver_timeliness': named.id } }));
        if (!r.ok) throw new Error(r.detail);
        const plan = await prisma.controlTestPlan.findFirstOrThrow({
            where: { tenantId: t.tenantId, automationConfig: { path: ['procedure'], equals: 'iam.leaver_timeliness' } },
            select: { controlId: true },
        });
        expect(plan.controlId).toBe(named.id);
    });

    describe('refuses, by name, before writing anything', () => {
        async function expectRefusal(slug: string, tenantId: string, refusal: string, extra: Partial<PilotSetupOptions> = {}) {
            const before = await footprint(tenantId);
            for (const apply of [false, true]) {
                const r = await setUpAuditPilot(opts(slug, { apply, ...extra }));
                expect(r).toMatchObject({ ok: false, refusal });
            }
            expect(await footprint(tenantId)).toEqual(before);
        }

        it('when the owner is not a member, or no such person exists', async () => {
            const t = await seedTenant('outsider');
            await expectRefusal(t.slug, t.tenantId, 'OWNER_NOT_A_MEMBER', { ownerEmail: email(OUTSIDER) });
            await expectRefusal(t.slug, t.tenantId, 'OWNER_NOT_A_MEMBER', { ownerEmail: email(`${SUITE}-nobody`) });
        });

        it('when the owner is not an ACTIVE member', async () => {
            const t = await seedTenant('inactive');
            await prisma.tenantMembership.update({
                where: { tenantId_userId: { tenantId: t.tenantId, userId: OWNER } },
                data: { status: 'DEACTIVATED' },
            });
            await expectRefusal(t.slug, t.tenantId, 'OWNER_NOT_ACTIVE');
        });

        it('when the owner is not second line', async () => {
            const t = await seedTenant('first-line');
            await expectRefusal(t.slug, t.tenantId, 'OWNER_NOT_SECOND_LINE', { ownerEmail: email(FIRST) });
            await prisma.tenantMembership.update({
                where: { tenantId_userId: { tenantId: t.tenantId, userId: OWNER } },
                data: { lineOfDefence: null },
            });
            await expectRefusal(t.slug, t.tenantId, 'OWNER_NOT_SECOND_LINE');
        });

        it('when a control is missing, by the mapping or by an explicit id', async () => {
            const bare = await seedTenant('no-controls', { controls: false });
            await expectRefusal(bare.slug, bare.tenantId, 'CONTROL_MISSING');
            const t = await seedTenant('bad-id');
            await expectRefusal(t.slug, t.tenantId, 'CONTROL_MISSING', { controls: { 'iam.privileged_access': `${SUITE}-no-such-control` } });
        });

        it('when the mapping is not clean', async () => {
            const t = await seedTenant('ambiguous');
            await prisma.control.create({ data: { tenantId: t.tenantId, name: 'Identity management (copy)', code: 'A-5.16', createdByUserId: FIRST } });
            await expectRefusal(t.slug, t.tenantId, 'CONTROL_AMBIGUOUS');
        });

        it('when a non-auditor agent already holds the name', async () => {
            const t = await seedTenant('name-taken');
            const sys = await prisma.aiSystem.create({ data: { tenantId: t.tenantId, name: 'host', ownerUserId: FIRST } });
            await prisma.registeredAgent.create({
                data: {
                    tenantId: t.tenantId,
                    aiSystemId: sys.id,
                    name: DEFAULT_AUDITOR_NAME,
                    autonomyLevel: 2,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: FIRST,
                    status: 'ACTIVE',
                },
            });
            await expectRefusal(t.slug, t.tenantId, 'NAME_HELD_BY_NON_AUDITOR');
        });

        it('when the tenant or a procedure does not exist', async () => {
            const t = await seedTenant('unknown');
            await expectRefusal(`${SUITE}-no-such-tenant`, t.tenantId, 'TENANT_NOT_FOUND');
            await expectRefusal(t.slug, t.tenantId, 'UNKNOWN_PROCEDURE', { controls: { 'agent.stop_control': 'x' } });
        });
    });
});
