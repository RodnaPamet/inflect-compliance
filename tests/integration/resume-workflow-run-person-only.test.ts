/**
 * A PAUSED RUN IS RESUMED BY A PERSON, NEVER BY A CREDENTIAL (#5368).
 *
 * Resuming closes the run's PENDING `HUMAN_CHECKPOINT` as DONE — it is the
 * approval the checkpoint parked for. The resume route admits `admin.view` or
 * `admin.agent_registry_view`, which an API key gets from `admin:read`, and a
 * key carrying any `:write` scope beside it resolves to EDITOR and so held the
 * role-tier write the usecase asserted. So a key — an agent's own key included — approved its own parked
 * run.
 *
 * Real database, real usecase: an API key, an agent-bound context and a JOB
 * context are each refused with a hash-chained `AUTHZ_DENIED` row naming
 * `agent_run_resume_human_required`, and the checkpoint stays PENDING; a person
 * still resumes the run to completion.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import {
    RESUME_REQUIRES_PERSON,
    resumeWorkflowRun,
    startWorkflowRun,
} from '@/app-layer/usecases/workflow-runs';
import { keyAuthorityFromScopes } from '@/lib/auth/api-key-auth';
import { computePermissions } from '@/lib/tenant-context';
import { ForbiddenError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `resume-person-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
const CHECKPOINT_WF = `resume-person-wf-${SUITE}`;

const person = () => makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

/**
 * The context `api-key-auth.ts` mints for a key the route admits (`admin:read`)
 * that also carries a write scope, so it resolves to EDITOR.
 */
function adminReadKey(): RequestContext {
    const scopes = ['admin:read', 'risks:write'];
    const { role, appPermissions } = keyAuthorityFromScopes(scopes);
    return {
        ...person(),
        role,
        permissions: computePermissions(role),
        appPermissions,
        apiKeyId: `key-${SUITE}`,
        apiKeyScopes: scopes,
    };
}

async function parkedRun(): Promise<string> {
    const started = await startWorkflowRun(person(), CHECKPOINT_WF, {});
    expect(started.status).toBe('AWAITING_APPROVAL');
    return started.runId;
}

async function checkpointStatus(runId: string): Promise<string | undefined> {
    const step = await prisma.workflowStep.findFirst({
        where: { tenantId: TENANT, runId, kind: 'HUMAN_CHECKPOINT' },
    });
    return step?.status;
}

async function denialsFor(runId: string) {
    return prisma.auditLog.findMany({
        where: { tenantId: TENANT, entity: 'WorkflowRun', entityId: runId, action: 'AUTHZ_DENIED' },
    });
}

describeFn('resumeWorkflowRun is a person’s act (#5368)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${USER}@example.test`;
        await prisma.user.upsert({ where: { id: USER }, update: {}, create: { id: USER, email, emailHash: hashForLookup(email) } });
        registerWorkflow({
            key: CHECKPOINT_WF,
            name: 'checkpoint then synthesis',
            description: 'parks at a human checkpoint, then summarises',
            steps: [
                { kind: 'HUMAN_CHECKPOINT', label: 'review', approvalWindow: '24h' },
                { kind: 'SYNTHESIS', label: 'summary', synthesize: () => ({ text: 'resumed' }) },
            ],
        });
    });

    afterAll(async () => {
        await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } });
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
        await deleteAuditRowsForTenants(prisma, [TENANT]);
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.$disconnect();
    });

    it('the admin:read + write-scope key the route admits holds the role-tier write — the hole', () => {
        // The precondition of the finding: without the person check the
        // usecase's `assertCanWrite` alone would have let this key through.
        expect(adminReadKey().permissions.canWrite).toBe(true);
        expect(adminReadKey().appPermissions.admin.view).toBe(true);
    });

    const NON_PERSONS: Array<[string, () => RequestContext, string]> = [
        ['an API key holding admin:read and a write scope', adminReadKey, 'API_KEY'],
        ['an agent-bound context', () => ({ ...person(), agentId: `agent-${SUITE}` }), 'AGENT'],
        ['a JOB context', () => ({ ...person(), actorType: 'JOB' }), 'JOB'],
        ['a SYSTEM context', () => ({ ...person(), actorType: 'SYSTEM' }), 'SYSTEM'],
    ];

    it.each(NON_PERSONS)(
        'refuses %s: 403, an AUTHZ_DENIED row naming the reason, the checkpoint still PENDING',
        async (_label, makeCtx, callerKind) => {
            const runId = await parkedRun();

            const err = await resumeWorkflowRun(makeCtx(), runId).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(ForbiddenError);
            expect((err as ForbiddenError).message).toContain(RESUME_REQUIRES_PERSON);

            const denials = await denialsFor(runId);
            expect(denials).toHaveLength(1);
            expect(denials[0].detailsJson).toMatchObject({
                category: 'access',
                event: 'authz_denied',
                reason: RESUME_REQUIRES_PERSON,
                callerKind,
            });
            // Hash-chained, not a side log.
            expect(denials[0].entryHash).toBeTruthy();

            expect(await checkpointStatus(runId)).toBe('PENDING');
            const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true } });
            expect(run.status).toBe('AWAITING_APPROVAL');
        },
    );

    it('a person still resumes the run to completion, and writes no denial', async () => {
        const runId = await parkedRun();
        const resumed = await resumeWorkflowRun(person(), runId);
        expect(resumed.status).toBe('COMPLETED');
        expect(await checkpointStatus(runId)).toBe('DONE');
        expect(await denialsFor(runId)).toHaveLength(0);
    });
});
