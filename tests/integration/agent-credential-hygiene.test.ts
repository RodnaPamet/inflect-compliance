/**
 * AGENT CREDENTIAL HYGIENE (#3670), proved on real rows.
 *
 * Each rule fires on its fixture and not on the clean key; findings are opened
 * once, kept on re-runs, closed only on positive evidence and reopened when the
 * weakness returns; a connection whose secret will not decrypt is held, never
 * resolved; NOTHING is written to a credential; an empty population is
 * NOT_APPLICABLE; and one tenant's pass never touches another's findings.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup, encryptField } from '@/lib/security/encryption';
import { runAgentCredentialHygiene } from '@/app-layer/usecases/agent-credential-hygiene';
import { runAgentCredentialHygieneSweep } from '@/app-layer/jobs/agent-credential-hygiene';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { JOB_DEFAULTS } from '@/app-layer/jobs/types';
import { HYGIENE_FINDING_SOURCE_KIND, hygieneSourceRef } from '@/lib/agentic/credential-hygiene';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

// Unique per run: `resetDatabase` does not truncate Tenant or User.
const SUITE = randomUUID().slice(0, 8);
const T1 = `hygiene-one-${SUITE}`;
const T2 = `hygiene-two-${SUITE}`;
const T3 = `hygiene-empty-${SUITE}`;
const TENANTS = [T1, T2, T3];
const userIds: string[] = [];
const DAY = 86_400_000;
const ago = (n: number) => new Date(Date.now() - n * DAY);
const ahead = (n: number) => new Date(Date.now() + n * DAY);

const ids: Record<string, string> = {};
let seq = 0;

async function person(tenantId: string, who: string, status: 'ACTIVE' | 'DEACTIVATED' = 'ACTIVE') {
    const email = `${who}@${tenantId}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userIds.push(user.id);
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role: who === 'owner' ? 'OWNER' : 'EDITOR', status },
    });
    return user.id;
}

async function key(
    tenantId: string,
    label: string,
    over: {
        createdAt?: Date;
        lastUsedAt?: Date | null;
        expiresAt?: Date | null;
        revokedAt?: Date | null;
        agentId?: string | null;
        scopes?: string[];
        createdById: string;
    },
) {
    seq += 1;
    const row = await prisma.tenantApiKey.create({
        data: {
            tenantId,
            name: label,
            keyPrefix: `iflk_${String(seq).padStart(3, '0')}`,
            keyHash: `hygiene-${tenantId}-${seq}`,
            scopes: over.scopes ?? ['mcp:read'],
            createdById: over.createdById,
            agentId: over.agentId === undefined ? null : over.agentId,
            createdAt: over.createdAt ?? ago(10),
            lastUsedAt: over.lastUsedAt === undefined ? ago(1) : over.lastUsedAt,
            expiresAt: over.expiresAt === undefined ? ahead(60) : over.expiresAt,
            revokedAt: over.revokedAt ?? null,
        },
    });
    ids[label] = row.id;
    return row.id;
}

async function connection(tenantId: string, label: string, config: Record<string, string>, secretEncrypted: string | null) {
    const row = await prisma.integrationConnection.create({
        data: { tenantId, provider: 'mcp-server', name: label, configJson: config, secretEncrypted },
    });
    ids[label] = row.id;
}

const findings = (tenantId: string) =>
    prisma.finding.findMany({
        where: { tenantId, sourceKind: HYGIENE_FINDING_SOURCE_KIND },
        orderBy: { sourceRef: 'asc' },
    });

async function credentialSnapshot(tenantId: string) {
    const [keys, conns] = await Promise.all([
        prisma.tenantApiKey.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
        prisma.integrationConnection.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    ]);
    return { keys, conns };
}

beforeAll(async () => {
    await resetDatabase(prisma);
    for (const t of [T1, T2, T3]) await prisma.tenant.create({ data: { id: t, name: t, slug: t } });

    ids.owner = await person(T1, 'owner');
    ids.creator = await person(T1, 'creator');
    ids.departed = await person(T1, 'departed', 'DEACTIVATED');
    const sys = await prisma.aiSystem.create({ data: { tenantId: T1, name: 'hygiene host', ownerUserId: ids.owner } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: T1, aiSystemId: sys.id, name: 'hygiene agent', autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA', reversibility: 'REVERSIBLE', provenance: 'FIRST_PARTY',
            ownerUserId: ids.owner, status: 'ACTIVE', riskTier: 'LOW', riskTierScoredAt: new Date(),
        },
    });
    ids.agent = agent.id;

    const bound = { agentId: agent.id, createdById: ids.creator };
    await key(T1, 'clean', bound);
    await key(T1, 'unused', { ...bound, createdAt: ago(40), lastUsedAt: ago(31) });
    await key(T1, 'noExpiry', { ...bound, expiresAt: null });
    await key(T1, 'old', { ...bound, createdAt: ago(100) });
    await key(T1, 'unbound', { agentId: null, createdById: ids.creator });
    // Unbound and minted by somebody who has left: nobody to assign it to.
    await key(T1, 'orphanedMint', { agentId: null, createdById: ids.departed });
    // Weak in every way — but not LIVE, so not hygiene's subject.
    const weakest = { agentId: null, createdById: ids.creator, createdAt: ago(400), lastUsedAt: null, expiresAt: null };
    await key(T1, 'revoked', { ...weakest, revokedAt: ago(1) });
    await key(T1, 'expired', { ...weakest, expiresAt: ago(1) });
    // Weak in every way and LIVE — but an integration key: unbound, and no scope
    // the /api/mcp gate admits. Not an agent credential, so not hygiene's subject.
    await key(T1, 'integration', { ...weakest, scopes: ['controls:read', 'evidence:write'] });

    const cfg = { url: 'https://mcp.example.test', tenantId: 'entra-tenant', clientId: 'client-1' };
    await connection(T1, 'appOnly', { ...cfg, scope: 'api://mcp/.default' }, encryptField(JSON.stringify({ clientSecret: 's3cret' })));
    await connection(T1, 'delegated', cfg, encryptField(JSON.stringify({ clientSecret: 's3cret', refreshToken: 'rt' })));
    await connection(T1, 'unreadable', cfg, 'v1:not-a-real-ciphertext');

    ids.t2owner = await person(T2, 'owner');
    await key(T2, 't2NoExpiry', { agentId: null, createdById: ids.t2owner, expiresAt: null });

    ids.t3owner = await person(T3, 'owner');
    // T3's only key is an integration key: a tenant with no agent credential.
    await key(T3, 't3Integration', { ...weakest, createdById: ids.t3owner, scopes: ['controls:read'] });
});

afterAll(async () => {
    const t = { tenantId: { in: TENANTS } };
    await prisma.integrationExecution.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await prisma.tenantApiKey.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    await prisma.$disconnect();
});

describe('it is wired', () => {
    it('is scheduled at 06:00 UTC with one attempt, after the orphan pass', () => {
        expect(SCHEDULED_JOBS.find((j) => j.name === 'agent-credential-hygiene')?.pattern).toBe('0 6 * * *');
        expect(JOB_DEFAULTS['agent-credential-hygiene'].attempts).toBe(1);
    });
});

describe('each rule fires on its fixture and on nothing else', () => {
    it('opens exactly one finding per (rule, weak credential), and none for the clean ones', async () => {
        const before = await credentialSnapshot(T1);
        const result = await runAgentCredentialHygiene({ tenantId: T1 });

        expect(result.status).toBe('PARTIAL');
        const rows = await findings(T1);
        const refs = rows.map((f) => f.sourceRef);
        expect(refs).toEqual(
            [
                hygieneSourceRef('KEY_UNUSED_30_DAYS', 'api_key', ids.unused),
                hygieneSourceRef('KEY_NO_EXPIRY', 'api_key', ids.noExpiry),
                hygieneSourceRef('KEY_OLDER_THAN_ROTATION_AGE', 'api_key', ids.old),
                hygieneSourceRef('KEY_NOT_BOUND_TO_AGENT', 'api_key', ids.unbound),
                hygieneSourceRef('KEY_NOT_BOUND_TO_AGENT', 'api_key', ids.orphanedMint),
                hygieneSourceRef('CONNECTION_APP_ONLY_NO_OWNER', 'connection', ids.appOnly),
            ].sort(),
        );
        // The clean key, the revoked and expired ones, the integration key and
        // the delegated connection appear nowhere.
        for (const clean of ['clean', 'revoked', 'expired', 'integration', 'delegated', 'unreadable']) {
            expect(refs.some((r) => (r as string).endsWith(`:${ids[clean]}`))).toBe(false);
        }
        expect(result.opened).toBe(6);

        const bySource = new Map(rows.map((f) => [f.sourceRef, f]));
        const appOnly = bySource.get(hygieneSourceRef('CONNECTION_APP_ONLY_NO_OWNER', 'connection', ids.appOnly));
        expect(appOnly?.severity).toBe('HIGH');
        expect(appOnly?.assigneeUserId).toBeNull();
        // A bound key's finding goes to the agent's owner; an unbound one to its
        // creator; one minted by a departed member to nobody.
        expect(bySource.get(hygieneSourceRef('KEY_NO_EXPIRY', 'api_key', ids.noExpiry))?.assigneeUserId).toBe(ids.owner);
        expect(bySource.get(hygieneSourceRef('KEY_NOT_BOUND_TO_AGENT', 'api_key', ids.unbound))?.assigneeUserId).toBe(ids.creator);
        expect(bySource.get(hygieneSourceRef('KEY_NOT_BOUND_TO_AGENT', 'api_key', ids.orphanedMint))?.assigneeUserId).toBeNull();
        expect(rows.every((f) => f.type === 'OBSERVATION' && f.status === 'OPEN')).toBe(true);
        // The title is plaintext (the description is encrypted at rest, and the
        // test client does not decrypt): it names the age it was judged by.
        expect(bySource.get(hygieneSourceRef('KEY_OLDER_THAN_ROTATION_AGE', 'api_key', ids.old))?.title).toMatch(
            /older than the 90-day rotation age/,
        );

        // FINDINGS ONLY: not one byte of any credential row moved.
        expect(await credentialSnapshot(T1)).toEqual(before);

        // The row names what it could not judge, and the rotation age's source.
        const exec = await prisma.integrationExecution.findFirstOrThrow({
            where: { tenantId: T1, automationKey: 'agentic.credential_hygiene' },
        });
        expect(exec.status).toBe('PARTIAL');
        expect(exec.resultJson).toMatchObject({
            skipped: [{ connectionId: ids.unreadable, reason: 'GRANT_KIND_UNRESOLVED' }],
            rotationAge: { days: 90, source: 'DEFAULT_NO_TENANT_SETTING' },
            population: { agentKeys: 6, otherLiveKeys: 1, mcpServerConnections: 3 },
        });
        // The pass's own audit row is a JOB's; the write extension's beside it
        // is SYSTEM. Neither names a person.
        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, entity: 'Finding', action: 'CREATE', details: { contains: 'Credential hygiene raised' } },
        });
        expect(audit.actorType).toBe('JOB');
        const findingAudit = await prisma.auditLog.findMany({ where: { tenantId: T1, entity: 'Finding' } });
        expect(findingAudit.every((r) => r.userId === null)).toBe(true);
    });

    it('a second pass opens nothing new', async () => {
        const result = await runAgentCredentialHygiene({ tenantId: T1 });
        expect(result).toMatchObject({ opened: 0, reopened: 0, resolved: 0 });
        expect((await findings(T1)).length).toBe(6);
    });
});

describe('resolution is on positive evidence only', () => {
    it('closes a finding when its key is revoked, reopens it when the weakness returns', async () => {
        const ref = hygieneSourceRef('KEY_NO_EXPIRY', 'api_key', ids.noExpiry);
        await prisma.tenantApiKey.update({ where: { id: ids.noExpiry }, data: { revokedAt: new Date() } });
        const closed = await runAgentCredentialHygiene({ tenantId: T1 });
        expect(closed.resolved).toBe(1);
        expect((await prisma.finding.findFirstOrThrow({ where: { tenantId: T1, sourceRef: ref } })).status).toBe('CLOSED');

        await prisma.tenantApiKey.update({ where: { id: ids.noExpiry }, data: { revokedAt: null } });
        const reopened = await runAgentCredentialHygiene({ tenantId: T1 });
        expect(reopened.reopened).toBe(1);
        expect((await prisma.finding.findFirstOrThrow({ where: { tenantId: T1, sourceRef: ref } })).status).toBe('OPEN');
    });

    it('closes a finding whose key now passes its rule', async () => {
        const ref = hygieneSourceRef('KEY_UNUSED_30_DAYS', 'api_key', ids.unused);
        await prisma.tenantApiKey.update({ where: { id: ids.unused }, data: { lastUsedAt: new Date() } });
        await runAgentCredentialHygiene({ tenantId: T1 });
        expect((await prisma.finding.findFirstOrThrow({ where: { tenantId: T1, sourceRef: ref } })).status).toBe('CLOSED');
    });

    it('HOLDS a finding on a connection whose secret will not decrypt — neither raised nor resolved', async () => {
        const ref = hygieneSourceRef('CONNECTION_APP_ONLY_NO_OWNER', 'connection', ids.unreadable);
        await prisma.finding.create({
            data: {
                tenantId: T1, severity: 'HIGH', type: 'OBSERVATION', title: 'held', description: 'held',
                status: 'OPEN', sourceKind: HYGIENE_FINDING_SOURCE_KIND, sourceRef: ref,
            },
        });
        const result = await runAgentCredentialHygiene({ tenantId: T1 });
        expect(result.held).toBe(1);
        expect((await prisma.finding.findFirstOrThrow({ where: { tenantId: T1, sourceRef: ref } })).status).toBe('OPEN');
    });
});

describe('two tenants, and the empty one', () => {
    it("one tenant's pass never touches another's findings", async () => {
        await runAgentCredentialHygiene({ tenantId: T2 });
        const t2 = await findings(T2);
        expect(t2.map((f) => f.sourceRef)).toEqual(
            [
                hygieneSourceRef('KEY_NO_EXPIRY', 'api_key', ids.t2NoExpiry),
                hygieneSourceRef('KEY_NOT_BOUND_TO_AGENT', 'api_key', ids.t2NoExpiry),
            ].sort(),
        );
        const t1Before = (await findings(T1)).map((f) => [f.id, f.status]);
        await runAgentCredentialHygiene({ tenantId: T2 });
        expect((await findings(T1)).map((f) => [f.id, f.status])).toEqual(t1Before);
        expect((await findings(T1)).some((f) => (f.sourceRef as string).endsWith(ids.t2NoExpiry))).toBe(false);
    });

    it('a tenant with no agent credential — only an integration key — records NOT_APPLICABLE, never a clean pass', async () => {
        const result = await runAgentCredentialHygiene({ tenantId: T3 });
        expect(result).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'NO_AGENT_CREDENTIALS', agentKeys: 0, opened: 0 });
        expect(await findings(T3)).toEqual([]);
    });

    it('the sweep visits a tenant whose last weak key was revoked, so its finding can close', async () => {
        // T2 revokes its only key: no live credential, one open finding.
        await prisma.tenantApiKey.update({ where: { id: ids.t2NoExpiry }, data: { revokedAt: new Date() } });
        const r = await runAgentCredentialHygieneSweep({}, `hygiene-sweep-${SUITE}`);
        const swept = r.results.map((x) => x.tenantId);
        expect(swept).toEqual(expect.arrayContaining([T1, T2]));
        // T3 holds only an integration key and no open finding: nothing to visit.
        expect(swept).not.toContain(T3);
        expect((await findings(T2)).every((f) => f.status === 'CLOSED')).toBe(true);
    });
});
