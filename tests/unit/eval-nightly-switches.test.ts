/**
 * THE EVALUATION NIGHTLIES' SWITCHES (owner decision 2026-11-27).
 *
 *   1. Who may switch: an ORG_OWNER (`canSwitchEvalNightlies`) of an operator
 *      organization named in EVALS_SWITCH_ORG_SLUGS. Unset or empty names
 *      none, so nobody can.
 *   2. The CI token: constant-time, 503 while unset or short, 401 for a
 *      missing, malformed, wrong or differently-sized token.
 *   3. The usecase: a non-owner and an owner of a non-operator organization
 *      write nothing (the second is audited as ORG_AUTHZ_DENIED here, since
 *      the middleware cannot see the list); a no-op writes nothing; a change
 *      writes the row and one audit entry with both values; an absent row
 *      reads as off.
 *   4. The CI route: 503 / 401 terse and uncached, before the switches are
 *      read; 200 with exactly the three booleans, uncached.
 */
const mockFindMany = jest.fn();
const mockUpsert = jest.fn();
jest.mock('@/lib/prisma', () => {
    const client = { evalNightlySwitch: { findMany: (a: unknown) => mockFindMany(a), upsert: (a: unknown) => mockUpsert(a) } };
    return { __esModule: true, default: client, prisma: client };
});
const mockAppendOrgAuditEntry = jest.fn(async (..._a: unknown[]) => ({ id: 'a', entryHash: 'h', previousHash: null }));
jest.mock('@/lib/audit/org-audit-writer', () => ({
    appendOrgAuditEntry: (...a: unknown[]) => mockAppendOrgAuditEntry(...a),
}));

import { NextRequest } from 'next/server';
import type { OrgRole } from '@prisma/client';

import { evalSwitchRefusal, parseEvalsSwitchOrgSlugs } from '@/lib/evals/eval-switch-access';
import { EVALS_SWITCH_TOKEN_MIN_LENGTH, verifyEvalsSwitchReadToken } from '@/lib/evals/eval-switch-token';
import { getOrgPermissions } from '@/lib/permissions';
import {
    getEvalNightlySwitches,
    readEvalNightlySwitchesForCi,
    setEvalNightlySwitch,
} from '@/app-layer/usecases/eval-nightly-switches';
import { GET as ciGET } from '@/app/api/evals/nightly-switches/route';
import type { OrgContext } from '@/app-layer/types';

const ENV_KEYS = ['EVALS_SWITCH_ORG_SLUGS', 'EVALS_SWITCH_READ_TOKEN'] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (ORIGINAL[k] === undefined) delete process.env[k];
        else process.env[k] = ORIGINAL[k];
    }
    jest.clearAllMocks();
});

function ctx(role: OrgRole, orgSlug = 'operator'): OrgContext {
    return {
        requestId: 'req-1',
        userId: 'user-1',
        organizationId: `org-${orgSlug}`,
        orgSlug,
        orgRole: role,
        permissions: getOrgPermissions(role),
    };
}

describe('1. who may switch', () => {
    it('only an ORG_OWNER holds the permission', () => {
        expect(getOrgPermissions('ORG_OWNER').canSwitchEvalNightlies).toBe(true);
        expect(getOrgPermissions('ORG_ADMIN').canSwitchEvalNightlies).toBe(false);
        expect(getOrgPermissions('ORG_READER').canSwitchEvalNightlies).toBe(false);
    });

    it('parses the operator list, ignoring blanks and whitespace', () => {
        expect([...parseEvalsSwitchOrgSlugs(' ops , ,platform,')]).toEqual(['ops', 'platform']);
        expect(parseEvalsSwitchOrgSlugs(undefined).size).toBe(0);
        expect(parseEvalsSwitchOrgSlugs(' , ').size).toBe(0);
    });

    it('admits an owner of an operator organization, and nobody else', () => {
        const owner = { canSwitchEvalNightlies: true };
        expect(evalSwitchRefusal({ ...owner, orgSlug: 'ops', operatorOrgs: 'other, ops' })).toBeNull();
        expect(evalSwitchRefusal({ ...owner, orgSlug: 'acme', operatorOrgs: 'ops' })).toBe('NOT_OPERATOR_ORG');
        // A sibling slug is not the operator: exact match only.
        expect(evalSwitchRefusal({ ...owner, orgSlug: 'ops-eu', operatorOrgs: 'ops' })).toBe('NOT_OPERATOR_ORG');
        expect(evalSwitchRefusal({ canSwitchEvalNightlies: false, orgSlug: 'ops', operatorOrgs: 'ops' })).toBe('NOT_ORG_OWNER');
    });

    it('names nobody while the list is unset or empty', () => {
        for (const operatorOrgs of [undefined, null, '', '  ,  ']) {
            expect(evalSwitchRefusal({ canSwitchEvalNightlies: true, orgSlug: 'ops', operatorOrgs })).toBe('NOT_OPERATOR_ORG');
        }
    });
});

describe('2. the CI token', () => {
    const TOKEN = 'k'.repeat(EVALS_SWITCH_TOKEN_MIN_LENGTH + 8);

    it('accepts the configured token, any case of the scheme', () => {
        expect(verifyEvalsSwitchReadToken(`Bearer ${TOKEN}`, TOKEN)).toBe('OK');
        expect(verifyEvalsSwitchReadToken(`bearer ${TOKEN}`, TOKEN)).toBe('OK');
    });

    it('is not configured while unset, blank or short', () => {
        for (const configured of [undefined, null, '', '   ', 'k'.repeat(EVALS_SWITCH_TOKEN_MIN_LENGTH - 1)]) {
            expect(verifyEvalsSwitchReadToken(`Bearer ${configured ?? ''}`, configured)).toBe('NOT_CONFIGURED');
        }
    });

    it('refuses a missing, malformed, wrong or differently-sized token', () => {
        for (const header of [
            null,
            '',
            TOKEN,
            `Basic ${TOKEN}`,
            `Bearer`,
            `Bearer ${TOKEN} extra`,
            `Bearer ${TOKEN.slice(0, -1)}x`,
            `Bearer ${TOKEN}x`,
            `Bearer ${TOKEN.slice(1)}`,
        ]) {
            expect(verifyEvalsSwitchReadToken(header, TOKEN)).toBe('UNAUTHORIZED');
        }
    });
});

describe('3. the usecase', () => {
    it('an absent row reads as off', async () => {
        mockFindMany.mockResolvedValue([{ nightly: 'garak', enabled: true, changedAt: new Date('2026-11-27T09:00:00Z') }]);
        expect(await readEvalNightlySwitchesForCi()).toEqual({ ragas: false, garak: true, inspect: false });
        process.env.EVALS_SWITCH_ORG_SLUGS = 'operator';
        const read = await getEvalNightlySwitches(ctx('ORG_ADMIN'));
        expect(read.nightlies.ragas).toEqual({ enabled: false, changedAt: null });
        expect(read.nightlies.garak).toEqual({ enabled: true, changedAt: '2026-11-27T09:00:00.000Z' });
    });

    it('tells the card who may switch', async () => {
        mockFindMany.mockResolvedValue([]);
        process.env.EVALS_SWITCH_ORG_SLUGS = 'operator';
        expect((await getEvalNightlySwitches(ctx('ORG_OWNER'))).canSwitch).toBe(true);
        expect((await getEvalNightlySwitches(ctx('ORG_ADMIN'))).canSwitch).toBe(false);
        expect((await getEvalNightlySwitches(ctx('ORG_OWNER', 'acme'))).canSwitch).toBe(false);
        delete process.env.EVALS_SWITCH_ORG_SLUGS;
        expect((await getEvalNightlySwitches(ctx('ORG_OWNER'))).canSwitch).toBe(false);
    });

    it('refuses a reader the read', async () => {
        await expect(getEvalNightlySwitches(ctx('ORG_READER'))).rejects.toMatchObject({ status: 403 });
        expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('refuses a non-owner, writing nothing', async () => {
        process.env.EVALS_SWITCH_ORG_SLUGS = 'operator';
        await expect(setEvalNightlySwitch(ctx('ORG_ADMIN'), { nightly: 'garak', enabled: true })).rejects.toMatchObject({ status: 403 });
        expect(mockUpsert).not.toHaveBeenCalled();
        expect(mockAppendOrgAuditEntry).not.toHaveBeenCalled();
    });

    it('refuses an owner of a non-operator organization, writing nothing but the refusal', async () => {
        process.env.EVALS_SWITCH_ORG_SLUGS = 'operator';
        await expect(setEvalNightlySwitch(ctx('ORG_OWNER', 'acme'), { nightly: 'garak', enabled: true })).rejects.toMatchObject({ status: 403 });
        expect(mockUpsert).not.toHaveBeenCalled();
        expect(mockAppendOrgAuditEntry).toHaveBeenCalledTimes(1);
        expect(mockAppendOrgAuditEntry.mock.calls[0][0]).toMatchObject({
            organizationId: 'org-acme',
            action: 'ORG_AUTHZ_DENIED',
            detailsJson: { reason: 'EVALS_SWITCH_NOT_OPERATOR_ORG', orgRole: 'ORG_OWNER', nightly: 'garak' },
        });
    });

    it('refuses every owner while no operator is named', async () => {
        delete process.env.EVALS_SWITCH_ORG_SLUGS;
        await expect(setEvalNightlySwitch(ctx('ORG_OWNER'), { nightly: 'inspect', enabled: true })).rejects.toMatchObject({ status: 403 });
        expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('a change that moves nothing writes nothing', async () => {
        process.env.EVALS_SWITCH_ORG_SLUGS = 'operator';
        mockFindMany.mockResolvedValue([]);
        const out = await setEvalNightlySwitch(ctx('ORG_OWNER'), { nightly: 'ragas', enabled: false });
        expect(out.nightlies.ragas.enabled).toBe(false);
        expect(mockUpsert).not.toHaveBeenCalled();
        expect(mockAppendOrgAuditEntry).not.toHaveBeenCalled();
    });

    it('a change writes the row, then one audit entry with both values', async () => {
        process.env.EVALS_SWITCH_ORG_SLUGS = 'operator';
        mockFindMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ nightly: 'ragas', enabled: true, changedAt: new Date('2026-11-27T10:00:00Z') }]);
        const out = await setEvalNightlySwitch(ctx('ORG_OWNER'), { nightly: 'ragas', enabled: true });
        expect(out.nightlies.ragas).toEqual({ enabled: true, changedAt: '2026-11-27T10:00:00.000Z' });
        expect(mockUpsert).toHaveBeenCalledTimes(1);
        const upsert = mockUpsert.mock.calls[0][0] as { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> };
        expect(upsert.where).toEqual({ nightly: 'ragas' });
        expect(upsert.create).toMatchObject({ nightly: 'ragas', enabled: true, changedByUserId: 'user-1', changedInOrganizationId: 'org-operator' });
        expect(upsert.update).toMatchObject({ enabled: true, changedByUserId: 'user-1', changedInOrganizationId: 'org-operator' });
        expect(mockAppendOrgAuditEntry).toHaveBeenCalledTimes(1);
        expect(mockAppendOrgAuditEntry.mock.calls[0][0]).toMatchObject({
            organizationId: 'org-operator',
            actorUserId: 'user-1',
            action: 'ORG_EVAL_NIGHTLY_SWITCHED',
            detailsJson: { nightly: 'ragas', before: false, after: true },
        });
        // Write, then audit.
        expect(mockUpsert.mock.invocationCallOrder[0]).toBeLessThan(mockAppendOrgAuditEntry.mock.invocationCallOrder[0]);
    });

    it('a failed audit append does not undo the switch', async () => {
        process.env.EVALS_SWITCH_ORG_SLUGS = 'operator';
        mockFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ nightly: 'garak', enabled: true, changedAt: new Date() }]);
        mockAppendOrgAuditEntry.mockRejectedValueOnce(new Error('lock timeout'));
        const out = await setEvalNightlySwitch(ctx('ORG_OWNER'), { nightly: 'garak', enabled: true });
        expect(out.nightlies.garak.enabled).toBe(true);
        expect(mockUpsert).toHaveBeenCalledTimes(1);
    });
});

describe('4. the CI route', () => {
    const TOKEN = 't'.repeat(48);
    const req = (authorization?: string) =>
        new NextRequest('http://localhost/api/evals/nightly-switches', {
            method: 'GET',
            headers: authorization === undefined ? {} : { authorization },
        });
    const call = (authorization?: string) => ciGET(req(authorization), { params: Promise.resolve({}) } as never);

    it('answers 503 while no token is configured, and reads nothing', async () => {
        delete process.env.EVALS_SWITCH_READ_TOKEN;
        const res = await call(`Bearer ${TOKEN}`);
        expect(res.status).toBe(503);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('answers 503 for a token too short to trust', async () => {
        process.env.EVALS_SWITCH_READ_TOKEN = 'short';
        expect((await call('Bearer short')).status).toBe(503);
    });

    it.each([
        ['missing', undefined],
        ['wrong', `Bearer ${'u'.repeat(48)}`],
        ['shorter', `Bearer ${TOKEN.slice(1)}`],
        ['longer', `Bearer ${TOKEN}t`],
        ['another scheme', `Basic ${TOKEN}`],
    ])('answers a terse 401 for a %s token, and reads nothing', async (_why, header) => {
        process.env.EVALS_SWITCH_READ_TOKEN = TOKEN;
        const res = await call(header);
        expect(res.status).toBe(401);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const text = await res.text();
        expect(text).not.toContain(TOKEN);
        expect(JSON.parse(text)).toEqual({ error: 'Unauthorized' });
        expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('answers 200 with exactly the three booleans, uncached', async () => {
        process.env.EVALS_SWITCH_READ_TOKEN = TOKEN;
        mockFindMany.mockResolvedValue([
            { nightly: 'inspect', enabled: true, changedAt: new Date() },
            { nightly: 'garak', enabled: false, changedAt: new Date() },
        ]);
        const res = await call(`Bearer ${TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toStrictEqual({ garak: false, ragas: false, inspect: true });
    });
});
