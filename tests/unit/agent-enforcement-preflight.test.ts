/**
 * The "would stop working" list is the keys the agent tool boundary refuses
 * under enforcement — decided by the gate's own code, not a second rule (#4117).
 *
 * The list used to be every live key with no agent binding. Enforcement is
 * applied at `/api/mcp` only, behind the endpoint capability gate, by
 * `assertRegisteredAgent`, so that rule was wrong in both directions:
 *
 *   - TOO LONG: an unbound key with no MCP capability scope (a CI key carrying
 *     `controls:read`) is refused at the capability gate before the
 *     registration gate is reached, whatever the setting. It never stops
 *     working because of it, yet it was listed.
 *   - TOO SHORT: a key bound to a SUSPENDED, DRAFT or RETIRED agent, or to one
 *     the register no longer holds, is refused by the registration gate just as
 *     an unbound key is (`agent_not_active` / `agent_not_found`), yet it was
 *     left out because it has a binding.
 *
 * The fake database below answers `findMany` by actually applying the `where`
 * it is given, so the assertions are about which rows the usecase selects and
 * keeps — not about the shape of its query.
 */

type Row = Record<string, unknown>;

/** The subset of Prisma's `where` the pre-flight uses, applied for real. */
function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, cond]) => {
        if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
        const value = row[key];
        if (cond === null) return value === null || value === undefined;
        if (cond instanceof Date || typeof cond !== 'object') return value === cond;
        const c = cond as { gt?: Date; in?: unknown[] };
        if (c.in) return c.in.includes(value);
        if (c.gt) return value instanceof Date && value.getTime() > c.gt.getTime();
        throw new Error(`fake db: unsupported condition on ${key}`);
    });
}

function pick(row: Row, select: Record<string, boolean>): Row {
    return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

const tables: { tenantApiKey: Row[]; registeredAgent: Row[] } = { tenantApiKey: [], registeredAgent: [] };
const table = (name: keyof typeof tables) => ({
    findMany: jest.fn(async ({ where, select }: { where: Row; select: Record<string, boolean> }) =>
        tables[name].filter((r) => matches(r, where)).map((r) => pick(r, select)),
    ),
});
const mockDb = {
    tenantSecuritySettings: { findUnique: jest.fn(async () => ({ requireRegisteredAgent: false })) },
    tenantApiKey: table('tenantApiKey'),
    registeredAgent: table('registeredAgent'),
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

import { previewAgentEnforcement } from '@/app-layer/usecases/tenant-security-settings';
import { makeRequestContext } from '../helpers/make-context';

const TENANT = 'tenant-1';
const past = new Date(Date.now() - 86_400_000);
const future = new Date(Date.now() + 86_400_000);

function agent(id: string, status: string, extra: Row = {}): Row {
    return { id, tenantId: TENANT, status, autonomyLevel: 2, riskTier: null, deletedAt: null, ...extra };
}

function key(id: string, extra: Row): Row {
    return {
        id,
        tenantId: TENANT,
        name: id,
        keyPrefix: `iflk_${id}`,
        lastUsedAt: null,
        agentId: null,
        scopes: ['mcp:read'],
        revokedAt: null,
        expiresAt: null,
        ...extra,
    };
}

beforeEach(() => {
    tables.registeredAgent = [
        agent('a-active', 'ACTIVE'),
        agent('a-suspended', 'SUSPENDED'),
        agent('a-draft', 'DRAFT'),
        agent('a-retired', 'RETIRED'),
        agent('a-deleted', 'ACTIVE', { deletedAt: past }),
        agent('a-other-tenant', 'ACTIVE', { tenantId: 'tenant-2' }),
    ];
    tables.tenantApiKey = [
        // REFUSED under enforcement — each for its own reason.
        key('unbound-mcp', {}),
        key('unbound-wildcard', { scopes: ['*'] }),
        key('suspended-agent', { agentId: 'a-suspended' }),
        key('draft-agent', { agentId: 'a-draft', scopes: ['mcp:propose'] }),
        key('retired-agent', { agentId: 'a-retired' }),
        key('deleted-agent', { agentId: 'a-deleted' }),
        key('cross-tenant-agent', { agentId: 'a-other-tenant' }),
        // NOT refused by enforcement.
        key('active-agent', { agentId: 'a-active' }),
        key('unbound-integration', { scopes: ['controls:read', 'evidence:write'] }),
        key('suspended-agent-no-mcp', { agentId: 'a-suspended', scopes: ['risks:read'] }),
        key('unbound-no-scopes', { scopes: [] }),
        // Not live: the authenticator refuses them already.
        key('revoked', { revokedAt: past }),
        key('expired', { expiresAt: past }),
        key('unbound-mcp-expiring', { expiresAt: future }),
    ];
});

async function breakingIds(): Promise<string[]> {
    const preflight = await previewAgentEnforcement(makeRequestContext('ADMIN', { tenantId: TENANT }));
    return preflight.breaking.map((c) => c.id).sort();
}

describe('the pre-flight lists exactly the keys enforcement refuses', () => {
    it('is the gate’s verdict over every live key that can reach the agent tools', async () => {
        expect(await breakingIds()).toEqual(
            [
                'unbound-mcp',
                'unbound-wildcard',
                'unbound-mcp-expiring',
                'suspended-agent',
                'draft-agent',
                'retired-agent',
                'deleted-agent',
                'cross-tenant-agent',
            ].sort(),
        );
    });

    it('leaves out an unbound key with no agent-tool scope — the capability gate refuses it either way', async () => {
        const ids = await breakingIds();
        expect(ids).not.toContain('unbound-integration');
        expect(ids).not.toContain('unbound-no-scopes');
        expect(ids).not.toContain('suspended-agent-no-mcp');
    });

    it('includes a key bound to an agent that is not ACTIVE, or that the register no longer holds', async () => {
        const ids = await breakingIds();
        for (const id of ['suspended-agent', 'draft-agent', 'retired-agent', 'deleted-agent', 'cross-tenant-agent']) {
            expect(ids).toContain(id);
        }
        expect(ids).not.toContain('active-agent');
    });

    it('names each row without leaking the binding or scopes it was judged by', async () => {
        const preflight = await previewAgentEnforcement(makeRequestContext('ADMIN', { tenantId: TENANT }));
        for (const row of preflight.breaking) {
            expect(Object.keys(row).sort()).toEqual(['id', 'keyPrefix', 'lastUsedAt', 'name']);
        }
    });
});
