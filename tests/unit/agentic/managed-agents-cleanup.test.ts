/**
 * THE REMOTE CLEAN-UP'S CALLS (Step 5c of `docs/claude-managed-agents-design.md`,
 * #4166): `src/lib/agentic/managed-agents/cleanup.ts`, over the faux workspace
 * and the real client (`managedAgentsClientFor`, with its middleware).
 *
 *   OUTCOMES   a 404 is done (already gone); a 401/403 is AUTH_REFUSED and
 *              never done; no status is PROVIDER_UNREACHABLE.
 *   PENDING    which recorded lifecycles leave a session Inflect's to delete,
 *              and that a DSAR erasure takes KEPT sessions only.
 *   THE PASS   recorded ids only: the crash window is listed by a recorded
 *              agent and nothing else, and a listed session is taken only when
 *              its metadata names this tenant and a run the tenant holds; a
 *              deadline stops the pass with nothing reported done.
 */
jest.mock('@/env', () => ({ env: { NODE_ENV: 'test' } }));

import {
    isDoneOutcome,
    outcomeOfError,
    runCleanupPass,
} from '@/lib/agentic/managed-agents/cleanup';
import { sessionMetadataFor } from '@/lib/agentic/managed-agents/definition';
import { managedAgentsClientFor } from '@/lib/agentic/tool-runner/client';
import { sessionIsPending } from '@/app-layer/usecases/managed-agents-cleanup';
import { ManagedAgentsFaux } from '../../helpers/managed-agents-faux';

const KEY = 'sk-ant-faux-key'; // pragma: allowlist secret -- a placeholder for the faux

function client() {
    const choice = managedAgentsClientFor({ apiKey: KEY, workspaceId: 'wrkspc_unit' });
    if (!choice.ok) throw new Error(choice.reason);
    return choice.client;
}

describe('outcomeOfError', () => {
    it.each([
        [{ status: 404 }, 'ALREADY_GONE', true],
        [{ status: 401 }, 'AUTH_REFUSED', false],
        [{ status: 403 }, 'AUTH_REFUSED', false],
        [{ status: 429 }, 'RATE_LIMITED', false],
        [{ status: 500 }, 'PROVIDER_ERROR', false],
        [{ status: 529 }, 'PROVIDER_ERROR', false],
        [{ status: 409 }, 'PROVIDER_REFUSED', false],
        [new TypeError('fetch failed'), 'PROVIDER_UNREACHABLE', false],
    ])('%j is %s (done: %s)', (err, outcome, done) => {
        expect(outcomeOfError(err)).toBe(outcome);
        expect(isDoneOutcome(outcomeOfError(err))).toBe(done);
    });

    it('anything after the deadline is DEADLINE, whatever the error', () => {
        const c = new AbortController();
        c.abort();
        expect(outcomeOfError({ status: 404 }, c.signal)).toBe('DEADLINE');
    });
});

describe('sessionIsPending', () => {
    it.each([
        [['SESSION_CREATED'], false, true],
        [['SESSION_CREATED', 'SESSION_DELETED'], false, false],
        [['SESSION_CREATED', 'SESSION_KEPT'], false, true],
        [['SESSION_CREATED', 'SESSION_DELETE_FAILED'], false, true],
        // A DSAR erasure: kept only.
        [['SESSION_CREATED', 'SESSION_KEPT'], true, true],
        [['SESSION_CREATED'], true, false],
        [['SESSION_CREATED', 'SESSION_DELETE_FAILED'], true, false],
    ])('%j (kept only: %s) is pending: %s', (lifecycles, keptOnly, pending) => {
        expect(sessionIsPending(new Set(lifecycles), keptOnly)).toBe(pending);
    });
});

describe('runCleanupPass', () => {
    let faux: ManagedAgentsFaux;
    beforeEach(() => {
        faux = new ManagedAgentsFaux();
        faux.install();
    });
    afterEach(() => faux.uninstall());

    it('lists only by the recorded agent, and takes only this tenant\'s sessions on runs it holds', async () => {
        const agent = faux.seedAgent('inflect');
        const foreignAgent = faux.seedAgent('customer');
        const recorded = faux.seedSession({ agentId: agent, metadata: sessionMetadataFor('t1', 'run-1') });
        const crash = faux.seedSession({ agentId: agent, metadata: sessionMetadataFor('t1', 'run-2'), archived: true });
        const otherTenant = faux.seedSession({ agentId: agent, metadata: sessionMetadataFor('t2', 'run-2') });
        const unheld = faux.seedSession({ agentId: agent, metadata: sessionMetadataFor('t1', 'run-x') });
        const bare = faux.seedSession({ agentId: agent });
        const onForeign = faux.seedSession({ agentId: foreignAgent, metadata: sessionMetadataFor('t1', 'run-2') });
        const asked: string[][] = [];

        const result = await runCleanupPass(
            client(),
            { tenantId: 't1', sessionIds: [recorded], agentIds: [agent], listAgentIds: [agent] },
            { runsHeld: async (ids) => { asked.push([...ids]); return new Set(['run-1', 'run-2']); } },
        );

        expect(result.deletedSessionIds.sort()).toEqual([recorded, crash].sort());
        expect(result.crashWindowSessionIds).toEqual([crash]);
        expect(result.archivedAgentIds).toEqual([agent]);
        expect(result.reason).toBeNull();
        for (const id of [otherTenant, unheld, bare, onForeign]) expect(faux.holdsSession(id)).toBe(true);
        expect(faux.isArchived(foreignAgent)).toBe(false);
        // Only the tenant's own candidates' runs are asked about.
        expect(asked).toEqual([['run-2', 'run-x']]);
        // Every list named the recorded agent, archived sessions included.
        const lists = faux.requests.filter((r) => r.method === 'GET' && r.path === '/v1/sessions');
        expect(lists).toHaveLength(1);
    });

    it('a refused key stops the pass: nothing is done, every item says AUTH_REFUSED, and nothing more is sent', async () => {
        const agent = faux.seedAgent('inflect');
        const s1 = faux.seedSession({ agentId: agent });
        const s2 = faux.seedSession({ agentId: agent });
        faux.authStatus = 401;

        const result = await runCleanupPass(
            client(),
            { tenantId: 't1', sessionIds: [s1, s2], agentIds: [agent], listAgentIds: [agent] },
            { runsHeld: async () => new Set() },
        );

        expect(result.deletedSessionIds).toEqual([]);
        expect(result.archivedAgentIds).toEqual([]);
        expect(result.remaining).toEqual({ [agent]: 'AUTH_REFUSED', [s1]: 'AUTH_REFUSED', [s2]: 'AUTH_REFUSED' });
        expect(result.reason).toBe('AUTH_REFUSED');
        expect(faux.requests).toHaveLength(1);
    });

    it('a pass past its deadline sends nothing and reports DEADLINE, never done', async () => {
        const agent = faux.seedAgent('inflect');
        const s1 = faux.seedSession({ agentId: agent });
        const c = new AbortController();
        c.abort();

        const result = await runCleanupPass(
            client(),
            { tenantId: 't1', sessionIds: [s1], agentIds: [agent], listAgentIds: [agent] },
            { signal: c.signal, runsHeld: async () => new Set() },
        );

        expect(result.remainingSessionIds).toEqual([s1]);
        expect(result.remainingAgentIds).toEqual([agent]);
        expect(result.reason).toBe('DEADLINE');
        expect(faux.requests).toEqual([]);
        expect(faux.holdsSession(s1)).toBe(true);
    });

    it('a running session is SESSION_STILL_RUNNING, and a session already gone is done', async () => {
        const agent = faux.seedAgent('inflect');
        const running = faux.seedSession({ agentId: agent, status: 'running' });

        const result = await runCleanupPass(
            client(),
            { tenantId: 't1', sessionIds: [running, 'sesn_never_existed'], agentIds: [], listAgentIds: [] },
            { runsHeld: async () => new Set() },
        );

        expect(result.remaining).toEqual({ [running]: 'SESSION_STILL_RUNNING' });
        expect(result.deletedSessionIds).toEqual(['sesn_never_existed']);
        expect(faux.holdsSession(running)).toBe(true);
    });
});
