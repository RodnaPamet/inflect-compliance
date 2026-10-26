/**
 * The Flue engine, held to the admission half of the driver conformance suite
 * (`tests/helpers/driver-conformance.ts`, Step 0b). The run half is in
 * `tests/flue/driver-conformance.test.ts`.
 *
 * ═══ WHAT IS REAL HERE ═══
 *
 * `startWorkflowRun`, the registration gate (`evaluateAgentRegistration`,
 * reading real `RegisteredAgent` rows) and the database, whose `WorkflowRun`
 * rows are counted before and after each attempt.
 *
 * ═══ WHAT IS MOCKED, AND WHY ═══
 *
 * Two things a test database cannot supply. The deployment switch that permits
 * the engine is replaced by `resolveDriverForRun` answering Flue. The worker
 * the run is handed to is replaced by `enqueue`. Neither is the control under
 * test, and the gate is not mocked.
 */
jest.mock('@/lib/agentic/agent-driver-policy', () => ({
    ...jest.requireActual('@/lib/agentic/agent-driver-policy'),
    resolveDriverForRun: jest.fn(async () => ({ driver: 'flue', reason: null })),
}));
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async () => undefined),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    describeDriverAdmissionConformance,
    type AdmissionObservation,
    type AdmissionStanding,
} from '../helpers/driver-conformance';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `dca-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
const WORKFLOW = `dca-${SUITE}`;
const agents: { active?: string; suspended?: string } = {};

async function seedAgent(status: 'ACTIVE' | 'SUSPENDED'): Promise<string> {
    // One AI system per agent: `RegisteredAgent_aiSystemId_key` is unique.
    const system = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `conformance ${status.toLowerCase()}`, ownerUserId: USER },
    });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: system.id,
            name: `conformance ${status.toLowerCase()}`,
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: USER,
            status,
        },
    });
    return agent.id;
}

function agentIdFor(standing: AdmissionStanding): string | undefined {
    switch (standing) {
        case 'no_binding':
            return undefined;
        case 'unresolvable':
            return `agent-not-in-the-register-${SUITE}`;
        case 'suspended':
            return agents.suspended;
        case 'vouched':
            return agents.active;
    }
}

async function admitOnFlue(standing: AdmissionStanding): Promise<AdmissionObservation> {
    const ctx = makeRequestContext('ADMIN', {
        tenantId: TENANT,
        tenantSlug: TENANT,
        userId: USER,
        agentId: agentIdFor(standing),
    });
    const count = () => prisma.workflowRun.count({ where: { tenantId: TENANT, workflowKey: WORKFLOW } });
    const before = await count();
    let reason: string | null = null;
    try {
        await startWorkflowRun(ctx, WORKFLOW, {});
    } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
    }
    return { refused: reason !== null, reason, runRowsCreated: (await count()) - before };
}

describeFn('Flue admission (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${TENANT}@example.test`;
        await prisma.user.create({ data: { id: USER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });
        agents.active = await seedAgent('ACTIVE');
        agents.suspended = await seedAgent('SUSPENDED');
        registerWorkflow({
            key: WORKFLOW,
            name: 'Conformance admission',
            description: 'a Flue run that mounts nothing',
            driver: 'flue',
            steps: [{ kind: 'SYNTHESIS', label: 'summary', synthesize: () => ({ text: 'done' }) }],
        });
    });

    afterAll(async () => {
        await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await deleteAuditRowsForTenants(prisma, TENANT);
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "RegisteredAgent" WHERE "tenantId" = $1`, TENANT);
            await tx.$executeRawUnsafe(`DELETE FROM "AiSystem" WHERE "tenantId" = $1`, TENANT);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.$disconnect();
    });

    describeDriverAdmissionConformance({ engine: 'flue', admit: admitOnFlue });
});
