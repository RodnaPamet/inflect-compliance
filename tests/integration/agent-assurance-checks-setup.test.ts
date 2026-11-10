/**
 * SCHEDULING THE FOUR AGENT ASSURANCE CHECKS, AGAINST A REAL DATABASE (#5014).
 *
 * The register's Assurance section read "never run" for every check in every
 * tenant, because nothing in the product could create a plan carrying a check's
 * config. What is asserted here is the setup's contract:
 *
 *   - a dry run names each check's control and writes nothing, not even an audit row;
 *   - apply schedules one daily 06:40 UTC INTEGRATION plan per check, on the
 *     control linked to the OWASP Agentic risk the check evidences;
 *   - a second apply writes nothing, and a plan somebody re-scheduled is left;
 *   - the register then reads every check as scheduled, and the plans run on
 *     the real runner;
 *   - a missing or ambiguous control is refused, by name, before any write.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { runControlTestRunner, runnerHandlerRegistry } from '@/app-layer/jobs/control-test-runner';
import {
    AGENTIC_CHECK_IDS,
    parseAgenticCheckConfig,
    registerAgenticControlTestHandler,
} from '@/app-layer/services/agent-control-tests';
import {
    ASSURANCE_CHECK_CRON,
    setUpAgentAssuranceChecks,
    type AssuranceSetupResult,
} from '@/app-layer/usecases/agent-assurance-checks-setup';
import { getAgenticAssuranceSignals } from '@/app-layer/usecases/agent-registry';
import { ASI_LIBRARY_URN } from '@/lib/agentic/evidence-artefact';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(300_000);

const SUITE = `asurchk-${randomUUID().slice(0, 8)}`;
const ADMIN = `${SUITE}-admin`;
const email = (id: string) => `${id}@example.test`;

/** The first OWASP Agentic risk each check covers, which is the one its plan is mapped by. */
const FIRST_CODE = {
    AGENTIC_POLICY_CARD_CONFORMANCE: 'ASI02',
    AGENTIC_TOOL_MANIFEST_INTEGRITY: 'ASI04',
    AGENTIC_REVIEW_QUALITY: 'ASI09',
    AGENTIC_KILL_SWITCH_DRILL: 'ASI08',
} as const;

let requirementIds: Record<string, string> = {};

async function seedTenant(label: string): Promise<{ tenantId: string; ctx: RequestContext }> {
    const tenantId = `${SUITE}-${label}`;
    await createTenantWithDek({ id: tenantId, name: tenantId, slug: tenantId });
    await prisma.tenantMembership.create({ data: { tenantId, userId: ADMIN, role: 'ADMIN', status: 'ACTIVE' } });
    return { tenantId, ctx: makeRequestContext('ADMIN', { tenantId, tenantSlug: tenantId, userId: ADMIN }) };
}

/** A control linked to one OWASP Agentic risk. */
async function linkedControl(tenantId: string, code: string, name = `Control for ${code}`): Promise<string> {
    const c = await prisma.control.create({ data: { tenantId, name, code: `${code}-C-${randomUUID().slice(0, 4)}` } });
    await prisma.controlRequirementLink.create({ data: { tenantId, controlId: c.id, requirementId: requirementIds[code] } });
    return c.id;
}

/** Every row the setup could write, counted. Equal before and after means it wrote nothing. */
async function footprint(tenantId: string) {
    const [plans, auditRows] = await Promise.all([
        prisma.controlTestPlan.count({ where: { tenantId } }),
        prisma.auditLog.count({ where: { tenantId } }),
    ]);
    return { plans, auditRows };
}

const outcomes = (r: AssuranceSetupResult) => (r.ok ? Object.fromEntries(r.steps.map((s) => [s.check, s.outcome])) : r);

describeFn('setUpAgentAssuranceChecks', () => {
    beforeAll(async () => {
        runnerHandlerRegistry._reset();
        registerAgenticControlTestHandler();
        await prisma.user.upsert({
            where: { id: ADMIN },
            update: {},
            create: { id: ADMIN, email: email(ADMIN), emailHash: hashForLookup(email(ADMIN)) },
        });
        // A framework of the OWASP Agentic family under a key of this suite's own:
        // the setup matches by family (`sourceUrn`), as the evidence emitter does.
        const framework = await prisma.framework.create({
            data: { key: `${SUITE}-asi`, name: 'OWASP Agentic Top 10 (test)', sourceUrn: ASI_LIBRARY_URN },
        });
        requirementIds = {};
        for (const [i, code] of ['ASI02', 'ASI03', 'ASI04', 'ASI08', 'ASI09', 'ASI10'].entries()) {
            const r = await prisma.frameworkRequirement.create({
                data: { frameworkId: framework.id, code, title: `${code} (test)`, sortOrder: i },
            });
            requirementIds[code] = r.id;
        }
    });

    afterAll(() => {
        runnerHandlerRegistry._reset();
    });

    describe('on a tenant whose controls cover every check', () => {
        let t: { tenantId: string; ctx: RequestContext };
        const controlOf: Record<string, string> = {};

        beforeAll(async () => {
            t = await seedTenant('mapped');
            for (const check of AGENTIC_CHECK_IDS) controlOf[check] = await linkedControl(t.tenantId, FIRST_CODE[check]);
        });

        it('the register reads every check as not scheduled before the setup runs', async () => {
            const signals = await getAgenticAssuranceSignals(t.ctx);
            expect(signals.controlTests.map((c) => [c.checkId, c.scheduled, c.result])).toEqual(
                AGENTIC_CHECK_IDS.map((c) => [c, false, null]),
            );
        });

        it('a dry run names the control each plan would be on and writes nothing', async () => {
            const before = await footprint(t.tenantId);
            const r = await setUpAgentAssuranceChecks(t.ctx, { apply: false });
            if (!r.ok) throw new Error(r.detail);
            expect(r.applied).toBe(false);
            expect(r.steps.map((s) => [s.check, s.outcome, s.control?.id])).toEqual(
                AGENTIC_CHECK_IDS.map((c) => [c, 'WOULD_CHANGE', controlOf[c]]),
            );
            expect(await footprint(t.tenantId)).toEqual(before);
        });

        it('apply schedules one daily INTEGRATION plan per check, on its mapped control', async () => {
            const r = await setUpAgentAssuranceChecks(t.ctx, { apply: true });
            expect(outcomes(r)).toEqual(Object.fromEntries(AGENTIC_CHECK_IDS.map((c) => [c, 'CHANGED'])));

            const plans = await prisma.controlTestPlan.findMany({
                where: { tenantId: t.tenantId, deletedAt: null },
                select: { controlId: true, automationType: true, schedule: true, scheduleTimezone: true, automationConfig: true, nextRunAt: true },
            });
            expect(plans).toHaveLength(AGENTIC_CHECK_IDS.length);
            for (const p of plans) {
                const check = parseAgenticCheckConfig(p.automationConfig)?.check;
                expect(check).toBeDefined();
                expect(p).toMatchObject({
                    controlId: controlOf[check!],
                    automationType: 'INTEGRATION',
                    schedule: ASSURANCE_CHECK_CRON,
                    scheduleTimezone: 'UTC',
                    automationConfig: { check },
                });
                expect(p.nextRunAt).not.toBeNull();
            }
            expect(ASSURANCE_CHECK_CRON).toBe('40 6 * * *');
        });

        it('a second apply writes nothing', async () => {
            const before = await footprint(t.tenantId);
            const r = await setUpAgentAssuranceChecks(t.ctx, { apply: true });
            expect(outcomes(r)).toEqual(Object.fromEntries(AGENTIC_CHECK_IDS.map((c) => [c, 'UNCHANGED'])));
            expect(await footprint(t.tenantId)).toEqual(before);
        });

        it('the register reads every check as scheduled, and each plan runs on the real runner', async () => {
            const plans = await prisma.controlTestPlan.findMany({
                where: { tenantId: t.tenantId, deletedAt: null },
                select: { id: true },
            });
            for (const plan of plans) {
                const result = await runControlTestRunner({
                    tenantId: t.tenantId,
                    testPlanId: plan.id,
                    scheduledForIso: new Date().toISOString(),
                    schedulerJobRunId: `${SUITE}-${plan.id}`,
                });
                expect(result.runId).toBeTruthy();
            }
            const signals = await getAgenticAssuranceSignals(t.ctx);
            for (const c of signals.controlTests) {
                expect(c.scheduled).toBe(true);
                // An empty tenant has nothing to examine: never a PASS it did not earn.
                expect(c.result).not.toBeNull();
                expect(c.result).not.toBe('PASS');
            }
        });

        it('a plan somebody re-scheduled is reported DIFFERS and left as they set it', async () => {
            const plan = await prisma.controlTestPlan.findFirstOrThrow({
                where: { tenantId: t.tenantId, automationConfig: { path: ['check'], equals: 'AGENTIC_REVIEW_QUALITY' } },
                select: { id: true },
            });
            await prisma.controlTestPlan.update({ where: { id: plan.id }, data: { schedule: '0 7 * * 1' } });

            const r = await setUpAgentAssuranceChecks(t.ctx, { apply: true });
            if (!r.ok) throw new Error(r.detail);
            expect(r.steps.find((s) => s.check === 'AGENTIC_REVIEW_QUALITY')).toMatchObject({
                outcome: 'DIFFERS',
                planId: plan.id,
                schedule: '0 7 * * 1',
            });
            const after = await prisma.controlTestPlan.findUniqueOrThrow({ where: { id: plan.id }, select: { schedule: true } });
            expect(after.schedule).toBe('0 7 * * 1');
        });
    });

    describe('refusals, decided before any write', () => {
        it('CONTROL_MISSING when no live control is linked to a check\'s risks', async () => {
            const t = await seedTenant('missing');
            await linkedControl(t.tenantId, 'ASI02');
            await linkedControl(t.tenantId, 'ASI04');
            await linkedControl(t.tenantId, 'ASI09');
            // Nothing for ASI08 or ASI10: the kill-switch drill check has no control.
            const before = await footprint(t.tenantId);
            const r = await setUpAgentAssuranceChecks(t.ctx, { apply: true });
            expect(r).toMatchObject({ ok: false, refusal: 'CONTROL_MISSING', check: 'AGENTIC_KILL_SWITCH_DRILL' });
            expect(await footprint(t.tenantId)).toEqual(before);
        });

        it('falls through to the next risk a check covers', async () => {
            const t = await seedTenant('fallthrough');
            await linkedControl(t.tenantId, 'ASI02');
            await linkedControl(t.tenantId, 'ASI04');
            await linkedControl(t.tenantId, 'ASI09');
            const asi10 = await linkedControl(t.tenantId, 'ASI10');
            const r = await setUpAgentAssuranceChecks(t.ctx, { apply: false });
            if (!r.ok) throw new Error(r.detail);
            expect(r.steps.find((s) => s.check === 'AGENTIC_KILL_SWITCH_DRILL')?.control?.id).toBe(asi10);
        });

        it('CONTROL_AMBIGUOUS when two controls discharge the risk, until one is named', async () => {
            const t = await seedTenant('ambiguous');
            await linkedControl(t.tenantId, 'ASI02');
            const first = await linkedControl(t.tenantId, 'ASI04', 'Tool provenance');
            const second = await linkedControl(t.tenantId, 'ASI04', 'Supply chain review');
            await linkedControl(t.tenantId, 'ASI09');
            await linkedControl(t.tenantId, 'ASI08');

            const before = await footprint(t.tenantId);
            const refused = await setUpAgentAssuranceChecks(t.ctx, { apply: true });
            expect(refused).toMatchObject({ ok: false, refusal: 'CONTROL_AMBIGUOUS', check: 'AGENTIC_TOOL_MANIFEST_INTEGRITY' });
            if (refused.ok) throw new Error('expected a refusal');
            expect(refused.candidates?.map((c) => c.id).sort()).toEqual([first, second].sort());
            expect(await footprint(t.tenantId)).toEqual(before);

            const named = await setUpAgentAssuranceChecks(t.ctx, {
                apply: false,
                controls: { AGENTIC_TOOL_MANIFEST_INTEGRITY: second },
            });
            if (!named.ok) throw new Error(named.detail);
            expect(named.steps.find((s) => s.check === 'AGENTIC_TOOL_MANIFEST_INTEGRITY')?.control?.id).toBe(second);
        });

        it('UNKNOWN_CHECK for a control named against a check that does not exist', async () => {
            const t = await seedTenant('unknown');
            const r = await setUpAgentAssuranceChecks(t.ctx, { apply: false, controls: { NOT_A_CHECK: 'x' } });
            expect(r).toMatchObject({ ok: false, refusal: 'UNKNOWN_CHECK' });
        });

        it('LACKS_PERMISSION for a reader', async () => {
            const t = await seedTenant('reader');
            const reader = makeRequestContext('READER', { tenantId: t.tenantId, tenantSlug: t.tenantId, userId: ADMIN });
            const r = await setUpAgentAssuranceChecks(reader, { apply: true });
            expect(r).toMatchObject({ ok: false, refusal: 'LACKS_PERMISSION' });
        });
    });
});
