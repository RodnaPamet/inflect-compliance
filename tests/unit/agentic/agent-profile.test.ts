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
 */
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) => (key === 'AGENT_PROFILES' ? undefined : Reflect.get(target, key)),
        }),
    };
});
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
import {
    agentProfilesEnabled,
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

describe('1. with AGENT_PROFILES unset every profile route answers 404', () => {
    it('finds the profile routes (denominator, not findings)', () => {
        expect(PROFILE_ROUTES.length).toBeGreaterThanOrEqual(6);
    });

    it.each(PROFILE_ROUTES)('%s', async (rel) => {
        const mod = (await import(path.join(process.cwd(), rel))) as Record<string, unknown>;
        const handlers = METHODS.filter((m) => typeof mod[m] === 'function');
        expect(handlers.length).toBeGreaterThan(0);
        for (const method of handlers) {
            const req = new NextRequest('http://localhost/api/t/acme/admin/agents/a1/profile', {
                method,
                headers: { 'content-type': 'application/json' },
                ...(method === 'GET' ? {} : { body: '{}' }),
            });
            const handler = mod[method] as (r: NextRequest, c: unknown) => Promise<Response>;
            const res = await handler(req, {
                params: Promise.resolve({ tenantSlug: 'acme', agentId: 'a1', version: '1' }),
            });
            expect({ method, status: res.status }).toEqual({ method, status: 404 });
        }
        expect(mockRequirePermission).not.toHaveBeenCalled();
    });
});

describe('2. no engine runs a profile in this build', () => {
    it('answers for each driver there is', () => {
        expect(Object.fromEntries(AGENT_DRIVERS.map((d) => [d, runsProfiles(d)]))).toEqual({ static: false, flue: false });
    });
});

describe('3. the run key and the flag', () => {
    it('round-trips a key and refuses every other form', () => {
        const key = profileRunKey('cmabc123', 7);
        expect(key).toBe('agent-profile:cmabc123@v7');
        expect(parseProfileRunKey(key)).toEqual({ profileId: 'cmabc123', version: 7 });
        for (const bad of [
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

    it('reads the flag as on only for 1 and true', () => {
        expect(['1', 'true', ' TRUE '].map(agentProfilesEnabled)).toEqual([true, true, true]);
        expect(['', '0', 'yes', 'on', undefined, null].map(agentProfilesEnabled)).toEqual([false, false, false, false, false, false]);
    });
});
