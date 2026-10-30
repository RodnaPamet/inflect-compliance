/**
 * Agent profiles, the parts with no database (Step 1a, #4143).
 *
 *   1. WITH `AGENT_PROFILES` UNSET, EVERY PROFILE ROUTE ANSWERS 404, before its
 *      permission check and for every method it exports. The routes are found
 *      on disk, so a route added later is held to the same rule.
 *   2. NO ENGINE RUNS A PROFILE IN THIS BUILD (owner decision, 2026-10-26),
 *      pinned for every driver there is.
 *   3. THE RUN KEY parses only in its one form, and the flag reads like
 *      `AGENT_DRIVER_FLUE`.
 *   4. `AGENT_PROFILES_TENANTS` OPENS THE ROUTES TO THE TENANTS IT NAMES and to
 *      no other (Step 1H, #4145): a named tenant's route reaches its
 *      permission check, and every other tenant's still answers 404 first.
 *   5. WITH `AGENT_PROFILES` UNSET, THE WORKSPACE'S ORGANIZATION DECIDES
 *      (#4557): its routes answer 404 until the organization turns profiles on.
 */
// The deployment switch stays unset throughout; the per-tenant allowlist
// (Step 1H) is set per test.
const mockAllowlist: { value: string | undefined } = { value: undefined };
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) => {
                if (key === 'AGENT_PROFILES') return undefined;
                if (key === 'AGENT_PROFILES_TENANTS') return mockAllowlist.value;
                return Reflect.get(target, key);
            },
        }),
    };
});
// The workspace's organization row, as the gate reads it by slug (#4557).
// `null` is a workspace with no organization.
const mockOrgChoice: { agentProfilesEnabled: boolean | null } = { agentProfilesEnabled: null };
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: {
            findUnique: jest.fn(async () =>
                mockOrgChoice.agentProfilesEnabled === null
                    ? { organization: null }
                    : { organization: { agentProfilesEnabled: mockOrgChoice.agentProfilesEnabled, agentToolRunnerEnabled: false } },
            ),
        },
    },
}));
const mockRequirePermission = jest.fn();
jest.mock('@/lib/security/permission-middleware', () => ({
    // A permission check that is reached at all fails the test: the flag must
    // answer first.
    requirePermission: () => async () => {
        mockRequirePermission();
        throw new Error('the permission check was reached with the flag off');
    },
}));

import path from 'node:path';
import { NextRequest } from 'next/server';

import { repoFiles, repoRelative } from '../../helpers/repo-files';
import { AGENT_DRIVERS } from '@/lib/agentic/agent-driver';
import { readDeploymentSwitch, resolveAgentSwitch, slugIsAllowlisted } from '@/lib/agentic/agent-switches';
import {
    isProfileRunKey,
    parseProfileRunKey,
    profileRunKey,
    runsProfiles,
} from '@/lib/agentic/agent-profile';

const PROFILE_ROUTES = repoFiles({ under: 'src/app/api/t/[tenantSlug]/admin/agents/[agentId]/profile', extensions: ['.ts'] })
    .filter((f) => path.basename(f) === 'route.ts')
    .map(repoRelative)
    .sort();

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Call every method a profile route exports, for `tenantSlug`, and return each status. */
async function callRoute(rel: string, tenantSlug: string): Promise<Array<{ method: string; status: number }>> {
    const mod = (await import(path.join(process.cwd(), rel))) as Record<string, unknown>;
    const handlers = METHODS.filter((m) => typeof mod[m] === 'function');
    expect(handlers.length).toBeGreaterThan(0);
    const out: Array<{ method: string; status: number }> = [];
    for (const method of handlers) {
        const req = new NextRequest(`http://localhost/api/t/${tenantSlug}/admin/agents/a1/profile`, {
            method,
            headers: { 'content-type': 'application/json' },
            ...(method === 'GET' ? {} : { body: '{}' }),
        });
        const handler = mod[method] as (r: NextRequest, c: unknown) => Promise<Response>;
        const res = await handler(req, { params: Promise.resolve({ tenantSlug, agentId: 'a1', version: '1' }) });
        out.push({ method, status: res.status });
    }
    return out;
}

beforeEach(() => {
    mockAllowlist.value = undefined;
    mockOrgChoice.agentProfilesEnabled = null;
    mockRequirePermission.mockClear();
});

describe('1. with AGENT_PROFILES unset every profile route answers 404', () => {
    it('finds the profile routes (denominator, not findings)', () => {
        expect(PROFILE_ROUTES.length).toBeGreaterThanOrEqual(6);
    });

    it.each(PROFILE_ROUTES)('%s', async (rel) => {
        for (const r of await callRoute(rel, 'acme')) expect(r).toEqual({ method: r.method, status: 404 });
        expect(mockRequirePermission).not.toHaveBeenCalled();
    });
});

describe('4. AGENT_PROFILES_TENANTS opens the routes to the tenants it names, and to no other', () => {
    it.each(PROFILE_ROUTES)('%s', async (rel) => {
        mockAllowlist.value = ' Proving-Tenant , ';
        // Another tenant: still 404, before its permission check.
        for (const r of await callRoute(rel, 'acme')) expect(r).toEqual({ method: r.method, status: 404 });
        expect(mockRequirePermission).not.toHaveBeenCalled();
        // The named tenant: past the gate, to the permission check.
        const named = await callRoute(rel, 'proving-tenant');
        expect(mockRequirePermission).toHaveBeenCalledTimes(named.length);
        for (const r of named) expect(r.status).not.toBe(404);
    });

    it('reads the list like the switch: trimmed, case-insensitive, and closed without a slug', () => {
        expect(slugIsAllowlisted('a, b ,c', 'B')).toBe(true);
        expect(slugIsAllowlisted('a,b', 'ab')).toBe(false);
        expect(slugIsAllowlisted('a,b', undefined)).toBe(false);
        expect(slugIsAllowlisted('a,b', '')).toBe(false);
        expect(slugIsAllowlisted(',', '')).toBe(false);
        expect(slugIsAllowlisted(undefined, 'a')).toBe(false);
        // The deployment switch opens every tenant, named or not.
        expect(resolveAgentSwitch({ deployment: readDeploymentSwitch('1'), organization: null }).on).toBe(true);
        // The list opens a named tenant even past the veto: the operator's own,
        // narrower instruction.
        expect(resolveAgentSwitch({ deployment: readDeploymentSwitch('0'), allowlisted: true, organization: false }).on).toBe(true);
    });
});

describe('5. with AGENT_PROFILES unset, the workspace\'s organization decides (#4557)', () => {
    it.each(PROFILE_ROUTES)('%s', async (rel) => {
        // An organization that has not turned profiles on: 404, before the key.
        mockOrgChoice.agentProfilesEnabled = false;
        for (const r of await callRoute(rel, 'acme')) expect(r).toEqual({ method: r.method, status: 404 });
        expect(mockRequirePermission).not.toHaveBeenCalled();
        // The same workspace once its organization turns them on: past the gate.
        mockOrgChoice.agentProfilesEnabled = true;
        const opened = await callRoute(rel, 'acme');
        expect(mockRequirePermission).toHaveBeenCalledTimes(opened.length);
        for (const r of opened) expect(r.status).not.toBe(404);
    });
});

describe('2. only the Tool Runner engine runs a profile (Step 2c)', () => {
    it('answers for each driver there is', () => {
        expect(Object.fromEntries(AGENT_DRIVERS.map((d) => [d, runsProfiles(d)]))).toEqual({ static: false, flue: false, 'tool-runner': true });
    });
});

describe('3. the run key and the flag', () => {
    it('round-trips a key and refuses every other form', () => {
        const key = profileRunKey('cmabc123', 7);
        expect(key).toBe('agent-profile:cmabc123@v7');
        expect(parseProfileRunKey(key)).toEqual({ profileId: 'cmabc123', version: 7, testRun: false });
        // A Test run carries its suffix, and only this one (Step 2c).
        const testKey = profileRunKey('cmabc123', 7, { testRun: true });
        expect(testKey).toBe('agent-profile:cmabc123@v7:test-run');
        expect(parseProfileRunKey(testKey)).toEqual({ profileId: 'cmabc123', version: 7, testRun: true });
        for (const bad of [
            'agent-profile:cmabc123@v7:test',
            'agent-profile:cmabc123@v7:test-run:test-run',
            'agent-profile:cmabc123@v7:TEST-RUN',
            'agent-profile:cmabc123',
            'agent-profile:cmabc123@v0',
            'agent-profile:cmabc123@v01',
            'agent-profile:CMABC@v1',
            'agent-profile:a/b@v1',
            'agent-profile:@v1',
            'agent-profile:cmabc123@v1 ',
        ]) {
            expect({ bad, parsed: parseProfileRunKey(bad) }).toEqual({ bad, parsed: null });
            expect(isProfileRunKey(bad)).toBe(true);
        }
        expect(isProfileRunKey('posture-review')).toBe(false);
    });

    it('reads the flag as on only for 1 and true, as unset only when absent or blank, and any other value as the veto', () => {
        expect(['1', 'true', ' TRUE '].map(readDeploymentSwitch)).toEqual(['ON', 'ON', 'ON']);
        expect(['', '  ', undefined, null].map(readDeploymentSwitch)).toEqual(['UNSET', 'UNSET', 'UNSET', 'UNSET']);
        expect(['0', 'false', 'yes', 'on'].map(readDeploymentSwitch)).toEqual(['OFF', 'OFF', 'OFF', 'OFF']);
    });
});
