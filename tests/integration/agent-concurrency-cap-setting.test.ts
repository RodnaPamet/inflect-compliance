/**
 * The concurrent-run cap's writer (#3484, #4471), proved on real rows (#5376).
 *
 *   - WHO: `PATCH admin/agents/concurrency` takes `admin.agent_registry` at the
 *     route. ADMIN and AI_ADMIN hold it and set the cap; EDITOR and READER do
 *     not and are refused with a 403 and exactly one `AUTHZ_DENIED` row each,
 *     and so is an ADMIN whose custom role withholds the key — the KEY decides,
 *     not the role's name. Nothing is written for a refusal.
 *   - THE CONTRACT FOR A BAD VALUE: out of range is REFUSED, never normalised.
 *     `normaliseCap` would floor 2.5 and clamp -1 to 0; the setter refuses both
 *     before it is reached, with the rule as the message, and writes nothing.
 *     A missing `cap` is a 400 too, never read as "clear".
 *   - NULL RESETS: `cap: null` clears the cap (no cap), which is not 0 (no run
 *     may start).
 *   - THE AUDIT ROW carries the value replaced and the value set.
 *   - THE READERS SEE IT: a cap of 0 refuses a run at the door; the GET reports
 *     the cap; one tenant's cap never reaches another.
 *
 * Only `getTenantCtx` is mocked, the one thing in the path that needs a
 * browser session; `requirePermission`, the setter and the audit writer are real.
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
import { getPermissionsForRole } from '@/lib/permissions';
import { GET, PATCH } from '@/app/api/t/[tenantSlug]/admin/agents/concurrency/route';
import { assertWithinConcurrencyCap, setConcurrencyCap } from '@/lib/agentic/run-concurrency-policy';
import { CONCURRENCY_CAP_SETTING_MESSAGE, MAX_CONCURRENCY_CAP } from '@/lib/agentic/run-concurrency';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const A = `conc-a-${SUITE}`;
const B = `conc-b-${SUITE}`;
const TENANTS = [A, B];

const PEOPLE = ['owner', 'admin', 'aiAdmin', 'editor', 'reader', 'narrowedAdmin'] as const;
type Person = (typeof PEOPLE)[number];
const ROLE_OF: Record<Person, Role> = {
    owner: 'OWNER',
    admin: 'ADMIN',
    aiAdmin: 'AI_ADMIN' as Role,
    editor: 'EDITOR',
    reader: 'READER',
    narrowedAdmin: 'ADMIN',
};
const users = {} as Record<Person, string>;
let bOwner = '';
const userIds: string[] = [];

/** An ADMIN's permissions with the route's key taken away, as a custom role would. */
function withoutRegistryKey() {
    const p = structuredClone(getPermissionsForRole('ADMIN'));
    p.admin.agent_registry = false;
    return p;
}

function ctxAs(who: Person, tenantId = A): RequestContext {
    return makeRequestContext(ROLE_OF[who], {
        tenantId,
        tenantSlug: tenantId,
        userId: users[who],
        ...(who === 'narrowedAdmin' ? { appPermissions: withoutRegistryKey() } : {}),
    });
}

function patch(body: unknown, tenantSlug = A): NextRequest {
    return new NextRequest(`http://localhost/api/t/${tenantSlug}/admin/agents/concurrency`, {
        method: 'PATCH',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });
}
const get = (tenantSlug = A) => new NextRequest(`http://localhost/api/t/${tenantSlug}/admin/agents/concurrency`);
const routeArgs = (tenantSlug = A) => ({ params: Promise.resolve({ tenantSlug }) });

const stored = async (tenantId = A) =>
    (await prisma.tenantSecuritySettings.findUnique({ where: { tenantId }, select: { agentMaxConcurrentRuns: true } }))
        ?.agentMaxConcurrentRuns ?? null;
const countDenials = () => prisma.auditLog.count({ where: { tenantId: A, action: 'AUTHZ_DENIED' } });
const capEvents = () =>
    prisma.auditLog.findMany({
        where: { tenantId: A, action: 'AGENT_CONCURRENCY_CAP_SET' },
        orderBy: { createdAt: 'asc' },
        take: 50,
    });

async function patchAs(who: Person, body: unknown) {
    getTenantCtxMock.mockResolvedValue(ctxAs(who));
    return PATCH(patch(body), routeArgs());
}

async function person(tenantId: string, label: string, role: Role) {
    const email = `${label}@${tenantId}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userIds.push(user.id);
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status: 'ACTIVE' } });
    return user.id;
}

beforeAll(async () => {
    for (const t of TENANTS) await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
    for (const who of PEOPLE) users[who] = await person(A, who, ROLE_OF[who]);
    bOwner = await person(B, 'owner', 'OWNER');
});

afterAll(async () => {
    const t = { tenantId: { in: TENANTS } };
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

describe('who may set it: admin.agent_registry, at the route', () => {
    it.each(['editor', 'reader', 'narrowedAdmin'] as const)(
        '%s is refused with a 403 and exactly one AUTHZ_DENIED row, and nothing is written',
        async (who) => {
            expect(ctxAs(who).appPermissions.admin.agent_registry).toBe(false);
            const before = await countDenials();
            const res = await patchAs(who, { cap: 5 });
            expect(res.status).toBe(403);
            expect((await countDenials()) - before).toBe(1);
            expect(await stored()).toBeNull();
            expect(await capEvents()).toHaveLength(0);
        },
    );

    it('the AUTHZ_DENIED row names the refused person, and the response does not echo the key', async () => {
        const res = await patchAs('editor', { cap: 5 });
        expect(JSON.stringify(await res.json())).not.toContain('agent_registry');
        const row = await prisma.auditLog.findFirst({
            where: { tenantId: A, action: 'AUTHZ_DENIED', userId: users.editor },
            orderBy: { createdAt: 'desc' },
        });
        expect(row).not.toBeNull();
    });

    it('the usecase holds the same line when called without the route', async () => {
        await expect(setConcurrencyCap(ctxAs('editor'), 5)).rejects.toMatchObject({ status: 403 });
        expect(await stored()).toBeNull();
    });

    it.each(['admin', 'aiAdmin'] as const)('%s holds the key and sets it; the column holds it', async (who) => {
        const value = { admin: 4, aiAdmin: 7 }[who];
        expect(ctxAs(who).appPermissions.admin.agent_registry).toBe(true);
        const res = await patchAs(who, { cap: value });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ cap: value });
        expect(await stored()).toBe(value);
    });

    it('each change is audited with the value it replaced and the value it set, by its author', async () => {
        const events = await capEvents();
        expect(events.map((e) => e.detailsJson)).toEqual([
            { previousCap: null, cap: 4 },
            { previousCap: 4, cap: 7 },
        ]);
        expect(events.map((e) => e.userId)).toEqual([users.admin, users.aiAdmin]);
        expect(events.every((e) => e.entity === 'TenantSecuritySettings' && e.entityId === A)).toBe(true);
    });
});

describe('a bad value is refused, never normalised, and nothing is written', () => {
    it.each([
        ['a negative', -1],
        ['a fraction', 2.5],
        ['one past the rail', MAX_CONCURRENCY_CAP + 1],
    ])('%s is a 400 with the rule as its message', async (_label, cap) => {
        const eventsBefore = (await capEvents()).length;
        const res = await patchAs('admin', { cap });
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toContain(CONCURRENCY_CAP_SETTING_MESSAGE);
        // Still the last good value: -1 was not clamped to 0, 2.5 not floored to 2.
        expect(await stored()).toBe(7);
        expect((await capEvents()).length).toBe(eventsBefore);
    });

    it.each([
        ['a missing cap', {}],
        ['a string', { cap: '3' }],
    ])('%s is a 400 at the schema, not read as "clear"', async (_label, body) => {
        const res = await patchAs('admin', body);
        expect(res.status).toBe(400);
        expect(await stored()).toBe(7);
    });

    it('both ends of the range are stored as given', async () => {
        expect((await patchAs('admin', { cap: MAX_CONCURRENCY_CAP })).status).toBe(200);
        expect(await stored()).toBe(MAX_CONCURRENCY_CAP);
        expect((await patchAs('admin', { cap: 0 })).status).toBe(200);
        expect(await stored()).toBe(0);
    });
});

describe('null resets, and the readers see what was written', () => {
    it('a cap of 0 refuses a run at the door, and the GET reports it', async () => {
        await expect(assertWithinConcurrencyCap(ctxAs('admin'))).rejects.toMatchObject({ status: 403 });
        getTenantCtxMock.mockResolvedValue(ctxAs('admin'));
        await expect((await GET(get(), routeArgs())).json()).resolves.toEqual({ cap: 0, inFlight: 0 });
    });

    it('null clears it — "no cap", not zero — and is audited as such', async () => {
        const res = await patchAs('owner', { cap: null });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ cap: null });
        expect(await stored()).toBeNull();
        expect((await capEvents()).at(-1)?.detailsJson).toEqual({ previousCap: 0, cap: null });
        await expect(assertWithinConcurrencyCap(ctxAs('admin'))).resolves.toMatchObject({ allowed: true, cap: null });
    });
});

describe('two tenants', () => {
    it('one tenant\'s cap never reaches the other', async () => {
        expect((await patchAs('admin', { cap: 3 })).status).toBe(200);
        expect(await stored(B)).toBeNull();

        const bCtx = makeRequestContext('OWNER', { tenantId: B, tenantSlug: B, userId: bOwner });
        getTenantCtxMock.mockResolvedValue(bCtx);
        expect((await PATCH(patch({ cap: 0 }, B), routeArgs(B))).status).toBe(200);
        expect(await stored(B)).toBe(0);
        expect(await stored(A)).toBe(3);
        await expect(assertWithinConcurrencyCap(ctxAs('admin'))).resolves.toMatchObject({ allowed: true });
        await expect(assertWithinConcurrencyCap(bCtx)).rejects.toMatchObject({ status: 403 });
        // B's audit row is B's: A's trail shows only A's change.
        expect((await capEvents()).at(-1)?.detailsJson).toEqual({ previousCap: null, cap: 3 });
    });
});
