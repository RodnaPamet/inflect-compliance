/**
 * A RUN WHOSE RECORDED ENGINE THIS BUILD DOES NOT KNOW (#4241).
 *
 * `WorkflowRun.driver` is the second column on the Prisma enum
 * `AgentDriverMode`; #4224 fixed the first (`TenantSecuritySettings.agentDriver`,
 * `agent-driver-unknown-stored-mode.test.ts`). The same rollback poisons this
 * one: a later image ships a third engine, starts runs on it, and production is
 * redeployed from an image built before it. Here it was worse, because a run row
 * is usually read WHOLE — and Prisma returns every scalar when no `select` is
 * named — so the run store, the run list, the run page and every `update` that
 * returns the row failed with it. The driver could not read its own run, so it
 * could neither continue it nor settle it; an operator could not abort it.
 *
 * ═══ THE CONTROLS ═══
 *
 * `THE CONTROL` below is the measurement that a whole-row read of a poisoned run
 * fails through the generated client, and its sibling that an `update` naming no
 * `select` fails too — the second is the half that is easy to miss, because a
 * write does not look like a read. Without them a passing suite would not tell
 * "the omit fixed it" from "there was never a problem".
 *
 * ═══ HOW THE STATE IS BUILT ═══
 *
 * Exactly as #4224's suite builds it, and with the same label, so the two leave
 * one extra physical value behind between them rather than two:
 * `ALTER TYPE … ADD VALUE IF NOT EXISTS` widens the PHYSICAL type only, the
 * generated client still knows `STATIC` and `FLUE`, and the run's column is set
 * by raw SQL because the typed client cannot express the value. Postgres cannot
 * drop an enum value without recreating the type; an unused label is inert, and
 * `prisma-enum-values-exist-in-pg.test.ts` is one-way (it reports values Prisma
 * declares that Postgres LACKS), so an extra physical value is not a finding.
 * Concurrent `ADD VALUE`s on one type serialise on its lock, and `IF NOT EXISTS`
 * makes the second a no-op.
 *
 * ═══ WHAT IS DELIBERATELY NOT ASSERTED ═══
 *
 * The resume path. It reaches the run through `getRunRow` and the same `update`
 * shape asserted here, and then re-resolves the engine from the deployment and
 * the definition — never from this column — so a resumed run walks an engine
 * this build has. Driving it needs a definition, an agent and the Flue gate,
 * which would make this suite about those instead.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { readRecordedRunDrivers } from '@/lib/agentic/agent-driver-stored-mode';
import { getRunRow } from '@/lib/agentic/drivers/run-store';
import { failRun } from '@/lib/agentic/drivers/run-settlement';
import {
    abortWorkflowRun,
    getWorkflowRun,
    listWorkflowRuns,
} from '@/app-layer/usecases/workflow-runs';
import {
    captureReviewAttribution,
    REVIEW_WORKFLOW_KEY,
} from '@/app-layer/usecases/agent-harness-attribution';
import {
    captureAuditNarrative,
    NARRATIVE_WORKFLOW_KEY,
} from '@/app-layer/usecases/audit-workpaper-narrative';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const T = `run-driver-unknown-${SUITE}`;
/** The label #4224's suite adds too — a value this build's union does not contain. */
const UNKNOWN = 'TEST_UNKNOWN_DRIVER';

/**
 * A REAL user row: the usecases audit, and `AuditLog.userId` carries a foreign
 * key, so a fabricated id would fail inside `logEvent` and the test would
 * report the audit's FK rather than anything about #4241.
 */
let ownerId = '';
const ctx = (): RequestContext =>
    makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: ownerId });

/** A run this build wrote, then stamped with an engine it does not know. */
async function poisonedRun(data: {
    workflowKey: string;
    status?: 'RUNNING' | 'COMPLETED';
    completedAt?: Date;
}): Promise<string> {
    const { id } = await prisma.workflowRun.create({
        data: { tenantId: T, agentId: null, policyCardVersion: null, ...data },
        select: { id: true },
    });
    await prisma.$executeRawUnsafe(
        `UPDATE "WorkflowRun" SET "driver" = '${UNKNOWN}'::"AgentDriverMode" WHERE "id" = $1`,
        id,
    );
    return id;
}

/** The fields a test reads back, through a select that names no `driver`. */
const statusOf = async (id: string) =>
    (await prisma.workflowRun.findFirst({ where: { id }, select: { status: true } }))?.status;

let runId = '';

beforeAll(async () => {
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const email = `owner@${T}.test`;
    const owner = await prisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    ownerId = owner.id;
    await prisma.tenantMembership.create({
        data: { tenantId: T, userId: ownerId, role: 'OWNER', status: 'ACTIVE' },
    });
    await prisma.$executeRawUnsafe(
        `ALTER TYPE "AgentDriverMode" ADD VALUE IF NOT EXISTS '${UNKNOWN}'`,
    );
    runId = await poisonedRun({ workflowKey: 'posture-review' });
});

afterAll(async () => {
    await prisma.workflowRun.deleteMany({ where: { tenantId: T } });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.tenant.deleteMany({ where: { id: T } });
    await prisma.$disconnect();
});

describe('a run whose recorded engine this build does not recognise', () => {
    it('THE CONTROL: the generated client cannot read this row whole', async () => {
        // If this ever stops throwing, the premise of #4241 is gone and the
        // omits are merely redundant rather than load-bearing — so this
        // failing is information, not noise.
        await expect(prisma.workflowRun.findFirst({ where: { id: runId } })).rejects.toThrow();
    });

    it('THE CONTROL, for writes: an update naming no select fails too, because it returns the row', async () => {
        await expect(
            prisma.workflowRun.update({ where: { id: runId }, data: { stepCount: 3 } }),
        ).rejects.toThrow();
    });

    it('the text reader returns it, coerced to UNRECOGNISED and never to a real engine', async () => {
        const driverOf = await readRecordedRunDrivers(prisma, T, [runId]);
        expect(driverOf(runId)).toBe('UNRECOGNISED');
    });

    it('the run store reads it', async () => {
        const run = await getRunRow(ctx(), runId);
        expect(run.id).toBe(runId);
        expect(run).not.toHaveProperty('driver');
    });

    it('the run page reads it, and says the engine is unrecognised', async () => {
        const run = await getWorkflowRun(ctx(), runId);
        expect(run.id).toBe(runId);
        expect(run.driver).toBe('UNRECOGNISED');
    });

    it('the run list answers for every run, the poisoned one included', async () => {
        const runs = await listWorkflowRuns(ctx(), {});
        expect(runs.find((r) => r.id === runId)?.driver).toBe('UNRECOGNISED');
    });

    it('an operator can abort it', async () => {
        const id = await poisonedRun({ workflowKey: 'posture-review' });
        await abortWorkflowRun(ctx(), id);
        expect(await statusOf(id)).toBe('ABORTED');
    });

    it('the engine can settle it FAILED — and the write survives the audit extension reading the row first', async () => {
        // `updateRun` runs inside a tenant transaction whose audit extension
        // reads the PRIOR row with an unqualified `findFirst` before the write.
        // That read fails on this row and is caught (it reports the write as
        // undiffed); this asserts the transaction it failed inside still commits.
        await expect(failRun(ctx(), runId, 'stopped by the #4241 suite')).resolves.toBe('FAILED');
        expect(await statusOf(runId)).toBe('FAILED');
    });

    it('the review attribution capture refuses it by name', async () => {
        const id = await poisonedRun({
            workflowKey: REVIEW_WORKFLOW_KEY,
            status: 'COMPLETED',
            completedAt: new Date(),
        });
        await expect(captureReviewAttribution(ctx(), id)).resolves.toMatchObject({
            outcome: 'UNRECOGNISED_ENGINE',
        });
    });

    it('the audit narrative capture refuses it by name', async () => {
        const id = await poisonedRun({
            workflowKey: NARRATIVE_WORKFLOW_KEY,
            status: 'COMPLETED',
            completedAt: new Date(),
        });
        await expect(captureAuditNarrative(ctx(), id)).resolves.toMatchObject({
            outcome: 'UNRECOGNISED_ENGINE',
        });
    });
});
