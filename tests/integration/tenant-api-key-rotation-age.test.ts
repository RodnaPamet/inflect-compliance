/**
 * A per-tenant API-key rotation age for credential hygiene (#3708), proved on
 * real rows.
 *
 *   - The SETTER: `PUT admin/security-settings` is the only product path to the
 *     column. OWNER and ADMIN set it; EDITOR, READER, AUDITOR and AI_ADMIN are
 *     refused at the route with EXACTLY ONE `AUTHZ_DENIED` row each, and every
 *     change writes an audit row naming the old and the new value.
 *   - The CHECK: the database refuses an out-of-range value from a writer that
 *     bypasses the schema and the usecase.
 *   - The PASS: a NULL setting judges keys by the 90-day default and says so on
 *     the row and in the finding; a tenant value changes which keys fire, in
 *     both directions, on the next pass — through 2b's ordinary reconcile — and
 *     the text of a finding that keeps firing names the age now applied.
 *   - TWO TENANTS: one tenant's value never reaches another tenant's pass.
 *
 * The route is driven through its REAL handler. Only `getTenantCtx` is mocked —
 * the one thing in the path that needs a browser session; `requirePermission`,
 * the audit writer, the usecases and RLS are all real.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { PrismaClient, type Role } from '@prisma/client';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { GET, PUT } from '@/app/api/t/[tenantSlug]/admin/security-settings/route';
import { updateTenantSecurityConfig } from '@/app-layer/usecases/tenant-security-settings';
import { runAgentCredentialHygiene } from '@/app-layer/usecases/agent-credential-hygiene';
import { getFinding } from '@/app-layer/usecases/finding';
import { HYGIENE_FINDING_SOURCE_KIND, hygieneSourceRef } from '@/lib/agentic/credential-hygiene';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

// Unique per run: `resetDatabase` does not truncate Tenant or User.
const SUITE = randomUUID().slice(0, 8);
const A = `rotation-a-${SUITE}`;
const B = `rotation-b-${SUITE}`;
const TENANTS = [A, B];

const PEOPLE = ['owner', 'admin', 'editor', 'reader', 'auditor', 'aiAdmin'] as const;
type Person = (typeof PEOPLE)[number];
const ROLE_OF: Record<Person, Role> = {
    owner: 'OWNER',
    admin: 'ADMIN',
    editor: 'EDITOR',
    reader: 'READER',
    auditor: 'AUDITOR',
    aiAdmin: 'AI_ADMIN' as Role,
};
const users = {} as Record<Person, string>;
let bOwner = '';
const userIds: string[] = [];

const DAY = 86_400_000;
const ago = (n: number) => new Date(Date.now() - n * DAY);
const ahead = (n: number) => new Date(Date.now() + n * DAY);
const ids: Record<string, string> = {};
let seq = 0;

function ctxAs(who: Person, tenantId = A): RequestContext {
    return makeRequestContext(ROLE_OF[who], { tenantId, tenantSlug: tenantId, userId: users[who] });
}
const bOwnerCtx = () => makeRequestContext('OWNER', { tenantId: B, tenantSlug: B, userId: bOwner });

const url = () => `http://localhost/api/t/${A}/admin/security-settings`;
function put(body: unknown): NextRequest {
    return new NextRequest(url(), {
        method: 'PUT',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });
}
const routeArgs = () => ({ params: Promise.resolve({ tenantSlug: A }) });

const storedAge = async (tenantId = A) =>
    (await prisma.tenantSecuritySettings.findUnique({ where: { tenantId }, select: { apiKeyRotationDays: true } }))
        ?.apiKeyRotationDays ?? null;
const countDenials = () => prisma.auditLog.count({ where: { tenantId: A, action: 'AUTHZ_DENIED' } });
const rotationEvents = () =>
    prisma.auditLog.findMany({
        where: { tenantId: A, action: 'API_KEY_ROTATION_AGE_CHANGED' },
        orderBy: { createdAt: 'asc' },
    });

/** Set the column directly — the hygiene half's fixture, not the thing under test. */
async function setAge(tenantId: string, days: number | null) {
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId },
        create: { tenantId, apiKeyRotationDays: days },
        update: { apiKeyRotationDays: days },
    });
}

async function person(tenantId: string, label: string, role: Role) {
    const email = `${label}@${tenantId}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userIds.push(user.id);
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status: 'ACTIVE' } });
    return user.id;
}

/** An agent key that is clean in every way but its age: bound, used yesterday, expiring. */
async function agedKey(tenantId: string, label: string, agentId: string, createdById: string, ageDays: number) {
    seq += 1;
    const row = await prisma.tenantApiKey.create({
        data: {
            tenantId,
            name: label,
            keyPrefix: `iflk_r${String(seq).padStart(2, '0')}`,
            keyHash: `rotation-${tenantId}-${seq}`,
            scopes: ['mcp:read'],
            createdById,
            agentId,
            createdAt: ago(ageDays),
            lastUsedAt: ago(1),
            expiresAt: ahead(60),
        },
    });
    ids[label] = row.id;
}

async function agent(tenantId: string, ownerUserId: string) {
    const sys = await prisma.aiSystem.create({ data: { tenantId, name: `rotation host ${tenantId}`, ownerUserId } });
    const row = await prisma.registeredAgent.create({
        data: {
            tenantId, aiSystemId: sys.id, name: `rotation agent ${tenantId}`, autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA', reversibility: 'REVERSIBLE', provenance: 'FIRST_PARTY',
            ownerUserId, status: 'ACTIVE', riskTier: 'LOW', riskTierScoredAt: new Date(),
        },
    });
    return row.id;
}

const rotationRef = (label: string) => hygieneSourceRef('KEY_OLDER_THAN_ROTATION_AGE', 'api_key', ids[label]);
const rotationFindings = (tenantId: string) =>
    prisma.finding.findMany({
        where: { tenantId, sourceKind: HYGIENE_FINDING_SOURCE_KIND, sourceRef: { startsWith: 'KEY_OLDER_THAN_ROTATION_AGE:' } },
        orderBy: { sourceRef: 'asc' },
    });
const findingFor = (tenantId: string, label: string) =>
    prisma.finding.findFirst({ where: { tenantId, sourceRef: rotationRef(label) } });
/** Finding.description is encrypted at rest; read it through the usecase. */
async function descriptionOf(tenantId: string, id: string): Promise<string> {
    const ctx = tenantId === A ? ctxAs('owner') : bOwnerCtx();
    return ((await getFinding(ctx, id)) as { description: string }).description;
}
const lastRow = (tenantId: string) =>
    prisma.integrationExecution.findFirstOrThrow({
        where: { tenantId, automationKey: 'agentic.credential_hygiene' },
        orderBy: { createdAt: 'desc' },
    });

beforeAll(async () => {
    for (const t of TENANTS) await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
    for (const who of PEOPLE) users[who] = await person(A, who, ROLE_OF[who]);
    bOwner = await person(B, 'owner', 'OWNER');

    const aAgent = await agent(A, users.owner);
    const bAgent = await agent(B, bOwner);
    // A: one key inside the default but past a 30-day age, one past the default.
    await agedKey(A, 'a40', aAgent, users.owner, 40);
    await agedKey(A, 'a100', aAgent, users.owner, 100);
    // B: the same 40-day key as A's — the two-tenant control.
    await agedKey(B, 'b40', bAgent, bOwner, 40);
});

afterAll(async () => {
    const t = { tenantId: { in: TENANTS } };
    await prisma.integrationExecution.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.tenantApiKey.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    await prisma.$disconnect();
});

describe('the setter: admin.manage, at the route, audited', () => {
    it.each(['editor', 'reader', 'auditor', 'aiAdmin'] as const)(
        '%s is refused with exactly one AUTHZ_DENIED row, and nothing is written',
        async (who) => {
            expect(ctxAs(who).appPermissions.admin.manage).toBe(false);
            getTenantCtxMock.mockResolvedValue(ctxAs(who));
            const before = await countDenials();

            const res = await PUT(put({ apiKeyRotationDays: 30 }), routeArgs());

            expect(res.status).toBe(403);
            expect(JSON.stringify(await res.json())).not.toContain('admin.manage');
            // EXACTLY one, not "at least one": a second gate a layer down would write two.
            expect(await countDenials()).toBe(before + 1);
            const row = await prisma.auditLog.findFirstOrThrow({
                where: { tenantId: A, action: 'AUTHZ_DENIED' },
                orderBy: { createdAt: 'desc' },
            });
            expect(row.entityId).toBe('admin.manage');
            expect(row.userId).toBe(users[who]);
            expect(await storedAge()).toBeNull();
            expect(await rotationEvents()).toEqual([]);
        },
    );

    it('a value outside 7..730 is a 400 from the schema, and nothing is written', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('owner'));
        for (const bad of [6, 731, 30.5, '30']) {
            const res = await PUT(put({ apiKeyRotationDays: bad }), routeArgs());
            expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
        }
        expect(await storedAge()).toBeNull();
        expect(await rotationEvents()).toEqual([]);
    });

    it('an OWNER sets it, an ADMIN clears it, and each change is audited with its old and new value', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('owner'));
        const set = await PUT(put({ apiKeyRotationDays: 30 }), routeArgs());
        expect(set.status).toBe(200);
        expect(((await set.json()) as { apiKeyRotationDays: number | null }).apiKeyRotationDays).toBe(30);
        expect(await storedAge()).toBe(30);

        const read = await GET(new NextRequest(url()), routeArgs());
        expect(((await read.json()) as { apiKeyRotationDays: number | null }).apiKeyRotationDays).toBe(30);

        getTenantCtxMock.mockResolvedValue(ctxAs('admin'));
        const cleared = await PUT(put({ apiKeyRotationDays: null }), routeArgs());
        expect(cleared.status).toBe(200);
        expect(await storedAge()).toBeNull();

        const events = await rotationEvents();
        expect(events.map((e) => [e.userId, e.detailsJson])).toEqual([
            [
                users.owner,
                expect.objectContaining({
                    before: { apiKeyRotationDays: null, effectiveDays: 90, source: 'DEFAULT_NO_TENANT_SETTING' },
                    after: { apiKeyRotationDays: 30, effectiveDays: 30, source: 'TENANT_SETTING' },
                }),
            ],
            [
                users.admin,
                expect.objectContaining({
                    before: { apiKeyRotationDays: 30, effectiveDays: 30, source: 'TENANT_SETTING' },
                    after: { apiKeyRotationDays: null, effectiveDays: 90, source: 'DEFAULT_NO_TENANT_SETTING' },
                }),
            ],
        ]);
        expect(events.every((e) => e.entity === 'TenantSecuritySettings' && e.entityId === A)).toBe(true);
    });
});

describe('the CHECK: 7..730 or NULL, enforced by the database', () => {
    it.each([6, 731, 0, -7])('refuses %s written past the schema and the usecase', async (bad) => {
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "TenantSecuritySettings" SET "apiKeyRotationDays" = $1 WHERE "tenantId" = $2`,
                bad,
                A,
            ),
        ).rejects.toThrow(/TenantSecuritySettings_apiKeyRotationDays_range/);
        await expect(setAge(A, bad)).rejects.toThrow();
        expect(await storedAge()).toBeNull();
    });

    it('accepts both ends of the range, and NULL', async () => {
        for (const ok of [7, 730, null]) {
            await setAge(A, ok);
            expect(await storedAge()).toBe(ok);
        }
    });
});

describe('the pass applies the age the tenant set, else the default — and says which', () => {
    it('a NULL setting uses the 90-day default and says so on the row and in the finding', async () => {
        await setAge(A, null);
        await runAgentCredentialHygiene({ tenantId: A });

        expect((await lastRow(A)).resultJson).toMatchObject({
            rotationAge: { days: 90, source: 'DEFAULT_NO_TENANT_SETTING' },
        });
        // Only the 100-day key is past 90 days.
        expect((await rotationFindings(A)).map((f) => f.sourceRef)).toEqual([rotationRef('a100')]);
        const f = await findingFor(A, 'a100');
        expect(f?.title).toMatch(/is older than the 90-day rotation age$/);
        expect(await descriptionOf(A, f!.id)).toMatch(
            /The rotation age is the product default \(90 days\) because this workspace has no rotation-age setting/,
        );
    });

    it('a SHORTER tenant age opens a finding on the next pass, and restates the one that keeps firing', async () => {
        await updateTenantSecurityConfig(ctxAs('owner'), { apiKeyRotationDays: 30 });
        const r = await runAgentCredentialHygiene({ tenantId: A });

        expect(r).toMatchObject({ opened: 1, restated: 1, resolved: 0 });
        expect((await lastRow(A)).resultJson).toMatchObject({
            rotationAge: { days: 30, source: 'TENANT_SETTING' },
            findings: { opened: 1, restated: 1 },
        });
        expect((await rotationFindings(A)).map((f) => [f.sourceRef, f.status])).toEqual(
            [
                [rotationRef('a40'), 'OPEN'],
                [rotationRef('a100'), 'OPEN'],
            ].sort(),
        );
        for (const label of ['a40', 'a100']) {
            const f = await findingFor(A, label);
            expect(f?.title).toMatch(/is older than the 30-day rotation age set for this workspace$/);
            expect(await descriptionOf(A, f!.id)).toMatch(/this workspace's own setting \(30 days\)/);
        }
        // The restatement is audited as a JOB's update.
        const restated = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: A, entity: 'Finding', action: 'UPDATE', details: { contains: 'Credential hygiene restated' } },
        });
        expect(restated.actorType).toBe('JOB');

        // A second pass under the same age restates nothing.
        expect(await runAgentCredentialHygiene({ tenantId: A })).toMatchObject({ opened: 0, restated: 0, resolved: 0 });
    });

    it('a LONGER tenant age resolves on the next complete read what the shorter one raised', async () => {
        await updateTenantSecurityConfig(ctxAs('owner'), { apiKeyRotationDays: 365 });
        const r = await runAgentCredentialHygiene({ tenantId: A });

        expect(r).toMatchObject({ opened: 0, resolved: 2 });
        expect((await lastRow(A)).resultJson).toMatchObject({ rotationAge: { days: 365, source: 'TENANT_SETTING' } });
        expect((await rotationFindings(A)).every((f) => f.status === 'CLOSED')).toBe(true);
    });

    it('clearing the setting returns to the default: the 100-day key reopens, worded as the default', async () => {
        await updateTenantSecurityConfig(ctxAs('admin'), { apiKeyRotationDays: null });
        const r = await runAgentCredentialHygiene({ tenantId: A });

        // Reopened AND restated: it closed under the 365-day wording.
        expect(r).toMatchObject({ reopened: 1, restated: 1, opened: 0 });
        expect((await lastRow(A)).resultJson).toMatchObject({
            rotationAge: { days: 90, source: 'DEFAULT_NO_TENANT_SETTING' },
        });
        const a100 = await findingFor(A, 'a100');
        expect(a100?.status).toBe('OPEN');
        expect(a100?.title).toMatch(/is older than the 90-day rotation age$/);
        expect(await descriptionOf(A, a100!.id)).toMatch(/the product default \(90 days\)/);
        expect((await findingFor(A, 'a40'))?.status).toBe('CLOSED');
    });
});

describe("two tenants: one tenant's age never reaches the other's pass", () => {
    it("A's 30 days fires on A's 40-day key and not on B's identical one; B's row says the default", async () => {
        await updateTenantSecurityConfig(ctxAs('owner'), { apiKeyRotationDays: 30 });
        expect(await storedAge(B)).toBeNull();

        await runAgentCredentialHygiene({ tenantId: A });
        await runAgentCredentialHygiene({ tenantId: B });

        expect((await findingFor(A, 'a40'))?.status).toBe('OPEN');
        expect(await rotationFindings(B)).toEqual([]);
        expect((await lastRow(A)).resultJson).toMatchObject({ rotationAge: { days: 30, source: 'TENANT_SETTING' } });
        expect((await lastRow(B)).resultJson).toMatchObject({
            rotationAge: { days: 90, source: 'DEFAULT_NO_TENANT_SETTING' },
        });
    });

    it("B's own value judges B's keys and leaves A's findings exactly as they were", async () => {
        const aBefore = (await rotationFindings(A)).map((f) => [f.id, f.status, f.title]);
        await updateTenantSecurityConfig(bOwnerCtx(), { apiKeyRotationDays: 14 });
        await runAgentCredentialHygiene({ tenantId: B });

        expect((await rotationFindings(B)).map((f) => f.sourceRef)).toEqual([rotationRef('b40')]);
        expect((await findingFor(B, 'b40'))?.title).toMatch(/14-day rotation age set for this workspace$/);
        expect((await rotationFindings(A)).map((f) => [f.id, f.status, f.title])).toEqual(aBefore);
        expect(await storedAge(A)).toBe(30);
    });
});
