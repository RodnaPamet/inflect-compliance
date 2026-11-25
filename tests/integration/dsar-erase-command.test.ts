/**
 * The DSAR erasure's operator entry point, `scripts/dsar-erase.ts` (#5802,
 * #5940; owner decisions 2026-11-25), over a real database and a faux
 * Anthropic workspace (`tests/helpers/managed-agents-faux.ts`).
 *
 * The command takes a DSAR register REQUEST and reads the subject from it.
 * One person, three workspaces, each reached a different way:
 *
 *   A — they accepted an invite: a row with them as actor (#5802's OWN_ACTION).
 *   B — the identity provider pushed them through SCIM, the real writer: a
 *       SCIM_USER_CREATED row naming them, no action of theirs (#5802).
 *   C — they joined through a writer that records NO row naming them (as
 *       credentials signup, SSO JIT and createTenantUnderOrg do), never acted,
 *       and were then removed on the members page by the REAL
 *       `removeTenantMember`. Before #5940 that removal named only the
 *       membership id, so C was invisible to the plan and its kept session
 *       survived the erasure. Its MEMBER_REMOVED row now carries
 *       `detailsJson.targetUserId`.
 *
 * And the register: the erasure request survives the erasure, COMPLETED, with
 * no column left that names the person (#5940).
 *
 * And the binding (third round): the erase runs only on a request a preflight
 * stamped within 24 hours, so when the request the owner read is cancelled and
 * another becomes due, the approved erase refuses the other one.
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
import { removeTenantMember } from '@/app-layer/usecases/tenant-admin';
import { readDueErasureRequests } from '@/app-layer/jobs/dsar-erasure-request';
import { eraseUser } from '@/app-layer/jobs/dsar-erasure';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import { prisma as appPrisma } from '@/lib/prisma';
import { EXIT_OK, EXIT_REFUSED, productionDeps, runDsarErase } from '../../scripts/dsar-erase';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `dsarcmd-${randomUUID().slice(0, 8)}`;
const KEY = 'sk-ant-faux-workspace-key-for-dsar-command'; // pragma: allowlist secret -- a placeholder for the faux
const HOUR = 3_600_000;
const ctxOf = (tenantId: string) => makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: `${tenantId}-owner` });

const tenants: string[] = [];
const users: string[] = [];
const requests: string[] = [];
let faux: ManagedAgentsFaux;

/** A workspace with an `anthropic-workspace` connection that keeps sessions, and one KEPT session on its ledger. */
async function seedWorkspace(label: string): Promise<{ tenantId: string; kept: string }> {
    const tenantId = `t-${SUITE}-${label}`;
    tenants.push(tenantId);
    await createTenantWithDek({ id: tenantId, name: tenantId, slug: tenantId });
    const owner = `${tenantId}-owner`;
    users.push(owner);
    await prisma.user.create({ data: { id: owner, email: `${owner}@example.test`, emailHash: hashForLookup(`${owner}@example.test`) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: owner, role: 'OWNER', status: 'ACTIVE' } });
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

async function seedSubject(label: string): Promise<{ id: string; email: string; name: string }> {
    const id = `u-${SUITE}-${label}`;
    const email = `${id}@example.test`;
    const name = `Subject Person ${SUITE} ${label}`;
    users.push(id);
    await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email), name } });
    return { id, email, name };
}

/** A register row, as the register's admin writer leaves it. */
async function seedRequest(
    userId: string,
    fields: { type?: 'ERASURE' | 'EXPORT'; status?: 'RECEIVED' | 'VERIFIED' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'CANCELED'; verifiedHoursAgo?: number | null; notes?: string; handledById?: string },
): Promise<string> {
    const verifiedHoursAgo = fields.verifiedHoursAgo === undefined ? 25 : fields.verifiedHoursAgo;
    const { id } = await prisma.dataSubjectRequest.create({
        data: {
            userId,
            type: fields.type ?? 'ERASURE',
            status: fields.status ?? 'IN_PROGRESS',
            verifiedAt: verifiedHoursAgo === null ? null : new Date(Date.now() - verifiedHoursAgo * HOUR),
            fulfilmentNotes: fields.notes ?? null,
            handledById: fields.handledById ?? null,
        },
        select: { id: true },
    });
    requests.push(id);
    return id;
}

/**
 * The command with its production wiring; only the printer is replaced, and
 * `--due` reads the REAL due query narrowed to this file's own requests, since
 * other suites share the database and may leave a due request of their own.
 */
async function run(args: string[]): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const deps = {
        ...(await productionDeps()),
        readDue: async (now: Date) =>
            (await readDueErasureRequests(appPrisma as never, now, 10_000)).filter((r) => requests.includes(r.id)).slice(0, 2),
        log: (line: string) => lines.push(line),
    };
    const code = await runDsarErase(args, deps);
    return { code, out: lines.join('\n') };
}

const stampOf = async (id: string) =>
    (await prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id }, select: { erasurePreflightAt: true } })).erasurePreflightAt;

beforeEach(() => {
    faux = new ManagedAgentsFaux();
    faux.install();
});

afterEach(() => {
    faux.uninstall();
});

afterAll(async () => {
    await prisma.dataSubjectRequest.deleteMany({ where: { id: { in: requests } } });
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

describeFn('scripts/dsar-erase — the erasure\'s operator entry point (#5802, #5940)', () => {
    it('plans and cleans up every workspace — one joined through a writer that names nobody, then removed — and leaves the request as unlinked evidence', async () => {
        const a = await seedWorkspace('acted');
        const b = await seedWorkspace('scim');
        const c = await seedWorkspace('signup');
        const subject = await seedSubject('subject');
        const admin = `${a.tenantId}-owner`;

        // A: the person accepted an invite (an audit row with them as actor).
        await appendAuditEntry({
            tenantId: a.tenantId,
            userId: subject.id,
            actorType: 'USER',
            entity: 'TenantMembership',
            entityId: `m-${subject.id}`,
            action: 'MEMBER_INVITE_ACCEPTED',
            detailsJson: { category: 'entity_lifecycle', entityName: 'TenantMembership', operation: 'created' },
        });
        // B: the real SCIM writer. They never act in B.
        await scimCreateUser(
            { tenantId: b.tenantId, tokenId: `tok-${SUITE}`, tokenLabel: 'idp' },
            { userName: subject.email, displayName: subject.name },
            'https://inflect.example/api/scim/v2',
        );
        // C: a membership written with NO audit row, as credentials signup,
        // SSO JIT and createTenantUnderOrg write theirs. They never act in C.
        const inC = await prisma.tenantMembership.create({
            data: { tenantId: c.tenantId, userId: subject.id, role: 'EDITOR', status: 'ACTIVE' },
            select: { id: true },
        });
        expect(await prisma.auditLog.count({ where: { tenantId: c.tenantId, OR: [{ userId: subject.id }, { entityId: subject.id }] } })).toBe(0);

        // The register: the erasure request, started by an admin while the
        // person was still a member, with staff notes that name them; and an
        // earlier export request with its own notes.
        const erasureRequest = await seedRequest(subject.id, {
            notes: `Called ${subject.name} on ${subject.email} to confirm.`,
            handledById: admin,
        });
        const exportRequest = await seedRequest(subject.id, {
            type: 'EXPORT',
            status: 'COMPLETED',
            notes: `Sent the bundle to ${subject.email}.`,
            handledById: admin,
        });
        await prisma.dataSubjectRequest.update({ where: { id: exportRequest }, data: { completedAt: new Date(Date.now() - 48 * HOUR) } });

        // While any membership exists the erasure is refused, as `eraseUser`
        // refuses it: a membership is a RESTRICT reference. A preflight that
        // fails stamps nothing, and --confirm without a stamp is refused first.
        const blocked = await run(['--request', erasureRequest]);
        expect(blocked.code).toBe(EXIT_REFUSED);
        expect(blocked.out).toContain('TenantMembership.userId rows=2 RESTRICT_REFERENCE');
        expect(await stampOf(erasureRequest)).toBeNull();
        const unpreviewed = await run(['--request', erasureRequest, '--confirm']);
        expect(unpreviewed.code).toBe(EXIT_REFUSED);
        expect(unpreviewed.out).toContain('refused: NOT_PREFLIGHTED.');
        expect(await prisma.user.count({ where: { id: subject.id } })).toBe(1);

        // The operator removes the memberships: B's directly (as before), C's
        // through the REAL members-page removal.
        await prisma.tenantMembership.deleteMany({ where: { userId: subject.id, tenantId: b.tenantId } });
        await removeTenantMember(ctxOf(c.tenantId), { membershipId: inC.id });
        expect(await prisma.tenantMembership.count({ where: { userId: subject.id } })).toBe(0);

        // The plan names C, by its removal row; nothing is written but the
        // stamp on the request it showed.
        const beforePlan = Date.now();
        const plan = await run(['--request', erasureRequest]);
        expect(plan.code).toBe(EXIT_OK);
        expect(plan.out).toContain(`request ${erasureRequest} type=ERASURE status=IN_PROGRESS`);
        expect(plan.out).toContain('workspaces where the subject held a membership: 3');
        expect(plan.out).toContain(`${a.tenantId} evidence=OWN_ACTION rows=1`);
        expect(plan.out).toContain(`${b.tenantId} evidence=MEMBERSHIP_RECORD rows=1`);
        expect(plan.out).toContain(`${c.tenantId} evidence=TARGET_RECORD rows=1`);
        expect(plan.out).toContain('legal hold: the product holds no hold for a person');
        expect(plan.out).toContain('plan only: nothing written but the preflight stamp');
        const stamped = await stampOf(erasureRequest);
        expect(stamped!.getTime()).toBeGreaterThanOrEqual(beforePlan - 1000);
        expect(await stampOf(exportRequest)).toBeNull();
        // The register row is no longer a blocker: it survives, unlinked.
        expect(plan.out).toContain('references refusing the delete: 0');
        expect(await prisma.user.count({ where: { id: subject.id } })).toBe(1);
        expect(faux.holdsSession(c.kept)).toBe(true);

        // Confirmed: erased, and every workspace's kept session is gone.
        const done = await run(['--request', erasureRequest, '--confirm']);
        expect(done.code).toBe(EXIT_OK);
        expect(await prisma.user.count({ where: { id: subject.id } })).toBe(0);
        expect(faux.holdsSession(a.kept)).toBe(false);
        expect(faux.holdsSession(b.kept)).toBe(false);
        expect(faux.holdsSession(c.kept)).toBe(false);
        const [recordC] = await prisma.managedAgentsCleanup.findMany({ where: { tenantId: c.tenantId } });
        expect(recordC).toMatchObject({ trigger: 'DSAR_ERASURE', status: 'DONE', deletedSessionIds: [c.kept] });
        expect(done.out).toContain('workspaces handed to the Managed Agents clean-up: 3');
        expect(done.out).toContain(`register: request completed=${erasureRequest} requests cleared=2`);

        // The register: both requests survive, COMPLETED, with nothing left
        // that names the person — no user id, no notes, no export URL — and
        // the admin who handled them still accountable.
        const after = await prisma.dataSubjectRequest.findMany({ where: { id: { in: [erasureRequest, exportRequest] } }, orderBy: { type: 'asc' } });
        expect(after).toHaveLength(2);
        for (const row of after) {
            expect(row).toMatchObject({ userId: null, fulfilmentNotes: null, exportUrl: null, status: 'COMPLETED', handledById: admin });
            expect(row.completedAt).toBeInstanceOf(Date);
            const text = JSON.stringify(row);
            expect(text).not.toContain(subject.id);
            expect(text).not.toContain(subject.email);
            expect(text).not.toContain(subject.name);
        }
        expect(after.find((r) => r.id === erasureRequest)!.completedAt!.getTime()).toBeGreaterThan(Date.now() - HOUR);
        // The stamp survives with the row: it records which preview the
        // erasure was approved on.
        expect(after.find((r) => r.id === erasureRequest)!.erasurePreflightAt).toEqual(stamped);

        // Ids and counts only: never the person's address or name.
        const printed = [blocked.out, unpreviewed.out, plan.out, done.out].join('\n');
        expect(printed).not.toContain(subject.email);
        expect(printed).not.toContain(subject.name);
    });

    it('refuses by name — before verification, during the cooling-off, before it is started, and once completed — and writes nothing', async () => {
        const subject = await seedSubject('refused');
        const received = await seedRequest(subject.id, { status: 'RECEIVED', verifiedHoursAgo: null });
        const cooling = await seedRequest(subject.id, { verifiedHoursAgo: 2 });
        const notStarted = await seedRequest(subject.id, { status: 'VERIFIED' });
        const completed = await seedRequest(subject.id, { status: 'COMPLETED' });
        await prisma.dataSubjectRequest.update({ where: { id: completed }, data: { completedAt: new Date() } });
        const exportRequest = await seedRequest(subject.id, { type: 'EXPORT' });

        for (const [id, reason] of [
            [received, 'NOT_VERIFIED'],
            [cooling, 'COOLING_OFF'],
            [notStarted, 'NOT_IN_PROGRESS'],
            [completed, 'ALREADY_COMPLETED'],
            [exportRequest, 'NOT_AN_ERASURE'],
            [`ck${SUITE.replace(/-/g, '')}missing`, 'REQUEST_NOT_FOUND'],
        ] as const) {
            const r = await run(['--request', id, '--confirm']);
            expect({ id, code: r.code, refused: r.out.includes(`refused: ${reason}`) }).toEqual({ id, code: EXIT_REFUSED, refused: true });
        }
        expect(await prisma.user.count({ where: { id: subject.id } })).toBe(1);
        expect(await prisma.dataSubjectRequest.count({ where: { userId: subject.id } })).toBe(5);

        // The due read the production action runs: a cooled-off IN_PROGRESS
        // request is due; one still cooling off, an unverified one and a
        // completed one are not.
        const due = await appPrisma.$transaction((tx) => readDueErasureRequests(tx as never, new Date(), 10_000));
        const ids = due.map((r) => r.id);
        expect(ids).toContain(notStarted);
        expect(ids).not.toContain(cooling);
        expect(ids).not.toContain(received);
        expect(ids).not.toContain(completed);
        expect(ids).not.toContain(exportRequest);
        // Leave nothing due for the tests that run `--due`.
        await prisma.dataSubjectRequest.updateMany({ where: { id: { in: [received, cooling, notStarted] } }, data: { status: 'CANCELED' } });
    });
    it('the production actions\' order: the preflight stamps the one due request, the check writes nothing, the erase erases it', async () => {
        const subject = await seedSubject('due');
        const request = await seedRequest(subject.id, {});

        const preflight = await run(['--due']);
        expect(preflight.code).toBe(EXIT_OK);
        expect(preflight.out).toContain(`request ${request} type=ERASURE status=IN_PROGRESS`);
        expect(preflight.out).toContain(`preflight=-`);
        const stamped = await stampOf(request);
        expect(stamped).toBeInstanceOf(Date);

        const check = await run(['--due', '--check']);
        expect(check.code).toBe(EXIT_OK);
        expect(check.out).toContain(`check: the erasure of request ${request} would be admitted`);
        // The check vouches for nothing: the stamp is the preflight's.
        expect(await stampOf(request)).toEqual(stamped);

        const erase = await run(['--due', '--confirm']);
        expect(erase.code).toBe(EXIT_OK);
        expect(erase.out).toContain(`register: request completed=${request}`);
        expect(await prisma.user.count({ where: { id: subject.id } })).toBe(0);
        expect(await prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id: request } })).toMatchObject({
            status: 'COMPLETED',
            userId: null,
            erasurePreflightAt: stamped,
        });
    });

    it('the request the owner read is cancelled and another becomes due: the approved erase refuses it NOT_PREFLIGHTED', async () => {
        const read = await seedSubject('read');
        const other = await seedSubject('other');
        const readRequest = await seedRequest(read.id, {});
        // Not due yet when the preflight runs: received, never verified.
        const otherRequest = await seedRequest(other.id, { status: 'RECEIVED', verifiedHoursAgo: null });

        const preflight = await run(['--due']);
        expect(preflight.code).toBe(EXIT_OK);
        expect(preflight.out).toContain(`request ${readRequest}`);
        expect(await stampOf(readRequest)).toBeInstanceOf(Date);

        // Between the two runs: the person withdraws, and the other request
        // is verified, cooled off and started.
        await prisma.dataSubjectRequest.update({ where: { id: readRequest }, data: { status: 'CANCELED' } });
        await prisma.dataSubjectRequest.update({
            where: { id: otherRequest },
            data: { status: 'IN_PROGRESS', verifiedAt: new Date(Date.now() - 25 * HOUR) },
        });

        // The `dsar-erase` action: its check, then its write. Each picks the
        // one due request afresh — the other one — and refuses it.
        for (const args of [['--due', '--check'], ['--due', '--confirm']]) {
            const r = await run(args);
            expect({ args, code: r.code }).toEqual({ args, code: EXIT_REFUSED });
            expect(r.out).toContain(`request ${otherRequest}`);
            expect(r.out).toContain('refused: NOT_PREFLIGHTED.');
        }
        // And inside eraseUser's transaction, for a caller that skips the command.
        const err = await eraseUser(other.id, { request: { id: otherRequest, now: new Date() } }).catch((e: unknown) => e);
        expect((err as { refusal?: { reason: string } }).refusal?.reason).toBe('NOT_PREFLIGHTED');

        expect(await prisma.user.count({ where: { id: { in: [read.id, other.id] } } })).toBe(2);
        expect(await prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id: otherRequest } })).toMatchObject({
            status: 'IN_PROGRESS',
            userId: other.id,
            erasurePreflightAt: null,
        });
        // Leave nothing due for the next test.
        await prisma.dataSubjectRequest.update({ where: { id: otherRequest }, data: { status: 'CANCELED' } });
    });

    it('a stamp older than 24 hours is refused PREFLIGHT_EXPIRED, by the command and inside the transaction', async () => {
        const subject = await seedSubject('expired');
        const request = await seedRequest(subject.id, {});
        expect((await run(['--request', request])).code).toBe(EXIT_OK);
        await prisma.dataSubjectRequest.update({ where: { id: request }, data: { erasurePreflightAt: new Date(Date.now() - 25 * HOUR) } });

        const r = await run(['--request', request, '--confirm']);
        expect(r.code).toBe(EXIT_REFUSED);
        expect(r.out).toContain('refused: PREFLIGHT_EXPIRED.');
        const err = await eraseUser(subject.id, { request: { id: request, now: new Date() } }).catch((e: unknown) => e);
        expect((err as { refusal?: { reason: string } }).refusal?.reason).toBe('PREFLIGHT_EXPIRED');
        expect(await prisma.user.count({ where: { id: subject.id } })).toBe(1);
        expect(await prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id: request } })).toMatchObject({ status: 'IN_PROGRESS' });
        await prisma.dataSubjectRequest.update({ where: { id: request }, data: { status: 'CANCELED' } });
    });
});
