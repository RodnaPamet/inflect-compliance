/**
 * The LLM evaluation nightlies' switches (owner decision 2026-11-27), proved
 * on real rows.
 *
 *   - THE SETTER: `PUT /api/org/:slug/eval-nightlies` through its real
 *     handler. An ORG_ADMIN of the operator organization is refused by the
 *     permission middleware with one `ORG_AUTHZ_DENIED` row; an ORG_OWNER of a
 *     NON-operator organization is refused by the usecase with one
 *     `ORG_AUTHZ_DENIED` row naming the reason; neither writes a switch. The
 *     operator's owner turns a nightly on: the row, and one
 *     `ORG_EVAL_NIGHTLY_SWITCHED` row with the nightly and both values. A PUT
 *     that moves nothing writes no row.
 *   - THE READS: the card's read and the CI read follow the row; an absent row
 *     is off; the CI endpoint answers the three booleans behind its token.
 *   - THE DATABASE: the CHECK refuses a nightly the workflows do not ask about,
 *     and the references are SET NULL when their person or organization goes.
 *
 * Only `getOrgCtx` is mocked — it needs a browser session. The permission
 * middleware, the usecase, the org audit writer and the CI route are real.
 */
const mockGetOrgCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getOrgCtx: (...a: unknown[]) => mockGetOrgCtx(...a),
}));

const envOverride: Record<string, string | undefined> = {};
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) =>
                typeof key === 'string' && key in envOverride ? envOverride[key] : Reflect.get(target, key),
        }),
    };
});

import { PrismaClient, type OrgRole } from '@prisma/client';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForUsers, deleteOrgAuditRowsForOrganizations } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { getOrgPermissions } from '@/lib/permissions';
import { GET, PUT } from '@/app/api/org/[orgSlug]/eval-nightlies/route';
import { GET as ciGET } from '@/app/api/evals/nightly-switches/route';
import { getEvalNightlySwitches, readEvalNightlySwitchesForCi } from '@/app-layer/usecases/eval-nightly-switches';
import type { OrgContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const OPERATOR = `evals-operator-${SUITE}`;
const CUSTOMER = `evals-customer-${SUITE}`;
const TOKEN = `ci-token-${SUITE}-${'z'.repeat(32)}`;
type Who = 'owner' | 'admin' | 'customerOwner';
const users: Record<Who, string> = { owner: '', admin: '', customerOwner: '' };
const orgIds: Record<string, string> = {};

function ctxAs(who: Who): OrgContext {
    const role: OrgRole = who === 'admin' ? 'ORG_ADMIN' : 'ORG_OWNER';
    const slug = who === 'customerOwner' ? CUSTOMER : OPERATOR;
    return {
        requestId: `req-${who}`,
        userId: users[who],
        organizationId: orgIds[slug],
        orgSlug: slug,
        orgRole: role,
        permissions: getOrgPermissions(role),
    };
}

const put = (slug: string, body: unknown) =>
    new NextRequest(`http://localhost/api/org/${slug}/eval-nightlies`, {
        method: 'PUT',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });
const args = (slug: string) => ({ params: Promise.resolve({ orgSlug: slug }) });
const orgRows = (slug: string, action: string) =>
    prisma.orgAuditLog.findMany({ where: { organizationId: orgIds[slug], action: action as never }, orderBy: { occurredAt: 'asc' } });
const ciCall = (authorization?: string) =>
    ciGET(
        new NextRequest('http://localhost/api/evals/nightly-switches', {
            headers: authorization === undefined ? {} : { authorization },
        }),
        { params: Promise.resolve({}) } as never,
    );

beforeAll(async () => {
    // The table is platform-wide; this suite owns it while it runs.
    await prisma.evalNightlySwitch.deleteMany({});
    for (const slug of [OPERATOR, CUSTOMER]) {
        const org = await prisma.organization.create({ data: { name: slug, slug } });
        orgIds[slug] = org.id;
    }
    const membership: Record<Who, [string, OrgRole]> = {
        owner: [OPERATOR, 'ORG_OWNER'],
        admin: [OPERATOR, 'ORG_ADMIN'],
        customerOwner: [CUSTOMER, 'ORG_OWNER'],
    };
    for (const who of Object.keys(membership) as Who[]) {
        const email = `${who}@${SUITE}.evals.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        users[who] = user.id;
        const [slug, role] = membership[who];
        await prisma.orgMembership.create({ data: { organizationId: orgIds[slug], userId: user.id, role } });
    }
    envOverride.EVALS_SWITCH_ORG_SLUGS = ` ${OPERATOR} , other-operator`;
    envOverride.EVALS_SWITCH_READ_TOKEN = TOKEN;
});

afterAll(async () => {
    await prisma.evalNightlySwitch.deleteMany({});
    await deleteAuditRowsForUsers(prisma, Object.values(users));
    await deleteOrgAuditRowsForOrganizations(prisma, Object.values(orgIds));
    await prisma.organization.deleteMany({ where: { id: { in: Object.values(orgIds) } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
    await prisma.$disconnect();
});

describe('before any switch', () => {
    it('every nightly reads off, to the card and to CI', async () => {
        expect(await readEvalNightlySwitchesForCi()).toEqual({ ragas: false, garak: false, inspect: false });
        const read = await getEvalNightlySwitches(ctxAs('admin'));
        expect(read.nightlies.garak).toEqual({ enabled: false, changedAt: null });
        expect(read.canSwitch).toBe(false);
        expect((await getEvalNightlySwitches(ctxAs('owner'))).canSwitch).toBe(true);
        expect((await getEvalNightlySwitches(ctxAs('customerOwner'))).canSwitch).toBe(false);
    });
});

describe('the setter, through the real route', () => {
    it('an ORG_ADMIN of the operator is refused by the middleware, with one ORG_AUTHZ_DENIED row', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('admin'));
        const res = await PUT(put(OPERATOR, { nightly: 'garak', enabled: true }), args(OPERATOR));
        expect(res.status).toBe(403);
        const denied = await orgRows(OPERATOR, 'ORG_AUTHZ_DENIED');
        expect(denied).toHaveLength(1);
        expect(denied[0].detailsJson).toMatchObject({ permissionKeys: ['canSwitchEvalNightlies'] });
        expect(await prisma.evalNightlySwitch.count()).toBe(0);
    });

    it('an ORG_OWNER of a non-operator organization is refused by the usecase, with the reason', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('customerOwner'));
        const res = await PUT(put(CUSTOMER, { nightly: 'garak', enabled: true }), args(CUSTOMER));
        expect(res.status).toBe(403);
        const denied = await orgRows(CUSTOMER, 'ORG_AUTHZ_DENIED');
        expect(denied).toHaveLength(1);
        expect(denied[0].detailsJson).toMatchObject({ reason: 'EVALS_SWITCH_NOT_OPERATOR_ORG', nightly: 'garak' });
        expect(await prisma.evalNightlySwitch.count()).toBe(0);
        expect(await orgRows(CUSTOMER, 'ORG_EVAL_NIGHTLY_SWITCHED')).toHaveLength(0);
    });

    it('an unknown nightly or an extra key is a 400', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('owner'));
        expect((await PUT(put(OPERATOR, { nightly: 'pyrit', enabled: true }), args(OPERATOR))).status).toBe(400);
        expect((await PUT(put(OPERATOR, { nightly: 'garak', enabled: true, also: 'ragas' }), args(OPERATOR))).status).toBe(400);
        expect(await prisma.evalNightlySwitch.count()).toBe(0);
    });

    it('the operator\'s owner turns Ragas on: the row, and one audit row with both values', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('owner'));
        const res = await PUT(put(OPERATOR, { nightly: 'ragas', enabled: true }), args(OPERATOR));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.switches.canSwitch).toBe(true);
        expect(body.switches.nightlies.ragas.enabled).toBe(true);
        expect(typeof body.switches.nightlies.ragas.changedAt).toBe('string');

        const row = await prisma.evalNightlySwitch.findUniqueOrThrow({ where: { nightly: 'ragas' } });
        expect(row).toMatchObject({ enabled: true, changedByUserId: users.owner, changedInOrganizationId: orgIds[OPERATOR] });

        const audit = await orgRows(OPERATOR, 'ORG_EVAL_NIGHTLY_SWITCHED');
        expect(audit).toHaveLength(1);
        expect(audit[0].actorUserId).toBe(users.owner);
        expect(audit[0].detailsJson).toEqual({ nightly: 'ragas', before: false, after: true });
    });

    it('a PUT that moves nothing writes no row', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('owner'));
        expect((await PUT(put(OPERATOR, { nightly: 'ragas', enabled: true }), args(OPERATOR))).status).toBe(200);
        expect((await PUT(put(OPERATOR, { nightly: 'inspect', enabled: false }), args(OPERATOR))).status).toBe(200);
        expect(await orgRows(OPERATOR, 'ORG_EVAL_NIGHTLY_SWITCHED')).toHaveLength(1);
        // Off without a prior row stays absent: nothing was switched.
        expect(await prisma.evalNightlySwitch.findUnique({ where: { nightly: 'inspect' } })).toBeNull();
    });

    it('turning it off again is an update, audited with both values', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('owner'));
        expect((await PUT(put(OPERATOR, { nightly: 'ragas', enabled: false }), args(OPERATOR))).status).toBe(200);
        expect((await prisma.evalNightlySwitch.findUniqueOrThrow({ where: { nightly: 'ragas' } })).enabled).toBe(false);
        const audit = await orgRows(OPERATOR, 'ORG_EVAL_NIGHTLY_SWITCHED');
        expect(audit.map((r) => r.detailsJson)).toEqual([
            { nightly: 'ragas', before: false, after: true },
            { nightly: 'ragas', before: true, after: false },
        ]);
        expect((await PUT(put(OPERATOR, { nightly: 'garak', enabled: true }), args(OPERATOR))).status).toBe(200);
    });

    it('an org admin reads the state, and is told they may not switch it', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('admin'));
        const res = await GET(new NextRequest(`http://localhost/api/org/${OPERATOR}/eval-nightlies`), args(OPERATOR));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.switches).toMatchObject({ canSwitch: false, nightlies: { garak: { enabled: true }, ragas: { enabled: false } } });
    });
});

describe('the CI endpoint', () => {
    it('answers the three booleans behind the token, absent as false', async () => {
        const res = await ciCall(`Bearer ${TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toStrictEqual({ garak: true, ragas: false, inspect: false });
    });

    it('refuses without it, and answers 503 while none is configured', async () => {
        expect((await ciCall()).status).toBe(401);
        expect((await ciCall(`Bearer ${TOKEN}x`)).status).toBe(401);
        envOverride.EVALS_SWITCH_READ_TOKEN = undefined;
        try {
            expect((await ciCall(`Bearer ${TOKEN}`)).status).toBe(503);
        } finally {
            envOverride.EVALS_SWITCH_READ_TOKEN = TOKEN;
        }
    });
});

describe('the database', () => {
    it('refuses a nightly the workflows do not ask about', async () => {
        await expect(prisma.evalNightlySwitch.create({ data: { nightly: 'pyrit', enabled: true } })).rejects.toThrow();
        expect(await prisma.evalNightlySwitch.findUnique({ where: { nightly: 'pyrit' } })).toBeNull();
    });

    it('keeps the state when the person and the organization go, clearing the references', async () => {
        const email = `departing@${SUITE}.evals.test`;
        const departing = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        const org = await prisma.organization.create({ data: { name: `gone-${SUITE}`, slug: `gone-${SUITE}` } });
        await prisma.evalNightlySwitch.update({
            where: { nightly: 'garak' },
            data: { changedByUserId: departing.id, changedInOrganizationId: org.id },
        });
        await prisma.user.delete({ where: { id: departing.id } });
        await prisma.organization.delete({ where: { id: org.id } });
        const row = await prisma.evalNightlySwitch.findUniqueOrThrow({ where: { nightly: 'garak' } });
        expect(row).toMatchObject({ enabled: true, changedByUserId: null, changedInOrganizationId: null });
    });
});
