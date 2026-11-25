/**
 * The DSAR erasure's operator entry point, `scripts/dsar-erase-user.ts`
 * (#5802, owner decision 2026-11-25), over a real database and a faux
 * Anthropic workspace (`tests/helpers/managed-agents-faux.ts`).
 *
 * The case #5802 named: a person added to workspace B by SCIM, who never
 * acted there, with a KEPT Managed Agents session recorded in B. Before
 * #5802 the erasure found its workspaces from the person's OWN audit rows,
 * which B does not hold, so B's kept session survived the erasure. The
 * command's plan must name B, and after `--confirm` B's session must be gone.
 *
 * The command runs with its production wiring (`productionDeps`); only the
 * printer is replaced, so the test reads every line it would have printed.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { ManagedAgentsFaux } from '../helpers/managed-agents-faux';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants, deleteAuditRowsForUsers } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import { sessionMetadataFor } from '@/lib/agentic/managed-agents/definition';
import { SESSION_STEP_LABEL } from '@/lib/agentic/managed-agents/execute';
import { purgeSoftDeletedTenants } from '@/app-layer/usecases/tenant-purge';
import { scimCreateUser } from '@/app-layer/usecases/scim-users';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import { prisma as appPrisma } from '@/lib/prisma';
import { EXIT_OK, EXIT_REFUSED, productionDeps, runDsarEraseUser } from '../../scripts/dsar-erase-user';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `dsarcmd-${randomUUID().slice(0, 8)}`;
const KEY = 'sk-ant-faux-workspace-key-for-dsar-command'; // pragma: allowlist secret -- a placeholder for the faux
const ctxOf = (tenantId: string) => makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: `${tenantId}-owner` });

const tenants: string[] = [];
const users: string[] = [];
let faux: ManagedAgentsFaux;

/** A workspace with an `anthropic-workspace` connection that keeps sessions, and one KEPT session on its ledger. */
async function seedWorkspace(label: string): Promise<{ tenantId: string; kept: string }> {
    const tenantId = `t-${SUITE}-${label}`;
    tenants.push(tenantId);
    await createTenantWithDek({ id: tenantId, name: tenantId, slug: tenantId });
    const owner = `${tenantId}-owner`;
    users.push(owner);
    await prisma.user.create({ data: { id: owner, email: `${owner}@example.test`, emailHash: hashForLookup(`${owner}@example.test`) } });
    const connectionId = (
        await prisma.integrationConnection.create({
            data: {
                tenantId,
                provider: 'anthropic-workspace',
                name: 'Anthropic workspace',
                configJson: { workspaceId: `wrkspc_${label}`, keepSessions: true },
                secretEncrypted: encryptField(JSON.stringify({ apiKey: KEY })),
            },
            select: { id: true },
        })
    ).id;
    const agentId = faux.seedAgent(`inflect-${label}`);
    await prisma.agentProfileProvision.create({
        data: {
            tenantId,
            profileId: `profile-${label}`,
            profileVersionId: `version-${label}`,
            connectionId,
            anthropicAgentId: agentId,
            anthropicAgentVersion: 1,
            environmentId: 'env_faux',
            systemHash: 'a'.repeat(64),
            toolsHash: 'b'.repeat(64),
        },
    });
    const runId = (
        await prisma.workflowRun.create({
            data: { tenantId, workflowKey: 'agent-profile:p@v1', status: 'COMPLETED', driver: 'MANAGED_AGENTS' },
            select: { id: true },
        })
    ).id;
    const kept = faux.seedSession({ agentId, metadata: sessionMetadataFor(tenantId, runId) });
    let seq = 1;
    for (const lifecycle of ['SESSION_CREATED', 'SESSION_KEPT'] as const) {
        await recordStep(ctxOf(tenantId), runId, seq++, 'SYNTHESIS', {
            status: 'DONE',
            label: SESSION_STEP_LABEL,
            input: { lifecycle, sessionId: kept, connectionId },
        });
    }
    return { tenantId, kept };
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const deps = { ...(await productionDeps()), log: (line: string) => lines.push(line) };
    const code = await runDsarEraseUser(args, deps);
    return { code, out: lines.join('\n') };
}

beforeEach(() => {
    faux = new ManagedAgentsFaux();
    faux.install();
});

afterEach(() => {
    faux.uninstall();
});

afterAll(async () => {
    await prisma.managedAgentsCleanup.deleteMany({ where: { tenantId: { in: tenants } } });
    for (const tenantId of tenants) {
        const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
        if (!t) continue;
        await prisma.tenant.update({ where: { id: tenantId }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
        await purgeSoftDeletedTenants({ tenantId, dryRun: false }).catch(() => undefined);
    }
    await prisma.managedAgentsCleanup.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenantMembership.deleteMany({ where: { userId: { in: users } } });
    await deleteAuditRowsForTenants(prisma, tenants).catch(() => undefined);
    await deleteAuditRowsForUsers(prisma, users).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await appPrisma.$disconnect();
    await prisma.$disconnect();
    // Every audit row above was also buffered for the tenant's SIEM stream;
    // the buffer's flush timer must not outlive this file's environment.
    __resetAuditStreamForTests();
});

describeFn('scripts/dsar-erase-user — the erasure\'s operator entry point (#5802)', () => {
    it('plans and cleans up a workspace the person joined through SCIM and never acted in, printing no e-mail and no name', async () => {
        const a = await seedWorkspace('acted');
        const b = await seedWorkspace('scim');
        const subject = `u-${SUITE}-subject`;
        const email = `${subject}@example.test`;
        const name = `Subject Person ${SUITE}`;
        users.push(subject);
        await prisma.user.create({ data: { id: subject, email, emailHash: hashForLookup(email), name } });

        // A: the person accepted an invite (an audit row with them as actor).
        await appendAuditEntry({
            tenantId: a.tenantId,
            userId: subject,
            actorType: 'USER',
            entity: 'TenantMembership',
            entityId: `m-${subject}`,
            action: 'MEMBER_INVITE_ACCEPTED',
            detailsJson: { category: 'entity_lifecycle', entityName: 'TenantMembership', operation: 'created' },
        });
        // B: the identity provider pushed them through SCIM. The real writer:
        // a membership, and a SCIM_USER_CREATED row naming them as entity,
        // with no user as actor. They never act in B.
        await scimCreateUser(
            { tenantId: b.tenantId, tokenId: `tok-${SUITE}`, tokenLabel: 'idp' },
            { userName: email, displayName: name },
            'https://inflect.example/api/scim/v2',
        );

        // The rule before #5802 — the subject's own rows — does not reach B.
        const ownRowTenants = await prisma.auditLog.findMany({
            where: { userId: subject },
            select: { tenantId: true },
            distinct: ['tenantId'],
        });
        expect(ownRowTenants.map((r) => r.tenantId)).toEqual([a.tenantId]);

        // While the SCIM membership exists the erasure is refused, as
        // `eraseUser` refuses it: a membership is a RESTRICT reference.
        const blocked = await run(['--user', subject, '--confirm']);
        expect(blocked.code).toBe(EXIT_REFUSED);
        expect(blocked.out).toContain('TenantMembership.userId rows=1 RESTRICT_REFERENCE');
        expect(await prisma.user.count({ where: { id: subject } })).toBe(1);

        // The operator removes the membership first (the members page deletes
        // the row and audits it by MEMBERSHIP id, which names nobody).
        await prisma.tenantMembership.deleteMany({ where: { userId: subject } });

        // The plan: B is named, by its SCIM record; nothing is written.
        const plan = await run(['--user', subject]);
        expect(plan.code).toBe(EXIT_OK);
        expect(plan.out).toContain(`workspaces where the subject held a membership: 2`);
        expect(plan.out).toContain(`${a.tenantId} evidence=OWN_ACTION rows=1`);
        expect(plan.out).toContain(`${b.tenantId} evidence=MEMBERSHIP_RECORD rows=1`);
        expect(plan.out).toContain('dry run: nothing written');
        expect(await prisma.user.count({ where: { id: subject } })).toBe(1);
        expect(faux.holdsSession(b.kept)).toBe(true);
        expect(await prisma.managedAgentsCleanup.count({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } })).toBe(0);

        // Confirmed: erased, and B's kept session is gone with A's.
        const done = await run(['--user', subject, '--confirm']);
        expect(done.code).toBe(EXIT_OK);
        expect(await prisma.user.count({ where: { id: subject } })).toBe(0);
        expect(faux.holdsSession(a.kept)).toBe(false);
        expect(faux.holdsSession(b.kept)).toBe(false);
        const [recordB] = await prisma.managedAgentsCleanup.findMany({ where: { tenantId: b.tenantId } });
        expect(recordB).toMatchObject({ trigger: 'DSAR_ERASURE', status: 'DONE', deletedSessionIds: [b.kept] });
        expect(done.out).toContain('workspaces handed to the Managed Agents clean-up: 2');

        // Ids and counts only: never the person's address or name.
        const printed = [blocked.out, plan.out, done.out].join('\n');
        expect(printed).not.toContain(email);
        expect(printed).not.toContain(name);
    });
});
