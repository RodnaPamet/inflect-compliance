/**
 * The HANDLER layer for an AI_ADMIN (#3699): what `requirePermission` decides
 * after the edge has pre-filtered.
 *
 * The edge allowlist (`tests/unit/ai-admin-edge-allowlist.test.ts`) only
 * decides which requests reach a handler. The authority is the literal
 * `requirePermission` in each route file. This file reads every admin API
 * route on disk, extracts the keys its gates name, and asks the real decision
 * function (`assertPermission`) about an AI_ADMIN context:
 *
 *   - every gate under the agent allowlist names a key AI_ADMIN holds;
 *   - every gate anywhere else under `/admin`, and under the privileged roots
 *     outside it (`sso`, `billing`, `security`, which the edge does not gate
 *     at all), names a key it holds ONLY if a READER holds it too — so even a
 *     request that slipped past the edge gains it nothing a READER lacks, and
 *     every refusal writes an `AUTHZ_DENIED` row;
 *   - real route modules are driven end to end: members, security settings,
 *     SSO, billing and the MFA policy refuse it with a 403; the
 *     ownership-transfer completion admits it.
 *
 * It also pins the coarse FLOOR the agent usecases now take
 * (`assertAgentGovernanceWrite` / `assertAgentGovernanceAdmin`): a strict
 * superset of `assertCanWrite` / `assertCanAdmin` that additionally admits a
 * holder of the agent key, which is what lets AI_ADMIN — on READER's rung of
 * the coarse ladder — run the register at all.
 */
import { strictMock } from '../helpers/strict-mock';

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

const auditSpy = jest.fn(async () => ({ recorded: 'chain' as const, auditId: 'audit-x' }));
// `strictMock`: `@/lib/audit` is a guarded barrel, and a subset factory would
// resolve every other export to `undefined`.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (...args: unknown[]) => auditSpy(...(args as [])),
        appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'h', previousHash: null })),
    }),
);

const completeMock = jest.fn(async () => ({
    transferId: 'transfer-1',
    agentId: 'agent-1',
    ownerUserId: 'ai-1',
    previousOwnerUserId: 'owner-1',
}));
jest.mock('@/app-layer/usecases/agent-ownership-transfer', () => ({
    ...jest.requireActual('@/app-layer/usecases/agent-ownership-transfer'),
    completeAgentOwnershipTransfer: (...args: unknown[]) => completeMock(...(args as [])),
}));

import { readFileSync } from 'fs';
import { NextRequest } from 'next/server';

import { assertPermission, type PermissionKey } from '@/lib/security/permission-middleware';
import { AI_ADMIN_ADMIN_PATH_PREFIXES } from '@/lib/auth/guard';
import { PERMISSION_SCHEMA } from '@/lib/permissions';
import {
    assertAgentGovernanceAdmin,
    assertAgentGovernanceWrite,
} from '@/app-layer/policies/agent-governance.policies';
import { ForbiddenError } from '@/lib/errors/types';
import { makeRequestContext } from '../helpers/make-context';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const API_ADMIN_DIR = 'src/app/api/t/[tenantSlug]/admin';
/** Privileged roots OUTSIDE `/admin`: no edge admin gate, so the handler is the only one. */
const OTHER_PRIVILEGED_DIRS = ['sso', 'billing', 'security'].map((d) => `src/app/api/t/[tenantSlug]/${d}`);
const aiAdmin = () => makeRequestContext('AI_ADMIN', { tenantId: 'tenant-1', userId: 'ai-1' });

const KEY_LITERAL = new RegExp(
    `'((?:${Object.keys(PERMISSION_SCHEMA).join('|')})\\.[a-z_]+)'`,
    'g',
);

/**
 * The permission keys named by every `requirePermission` / `requireAnyPermission`
 * / `requireAllPermissions` call in a route file: the first argument, read as a
 * literal, a literal array or object, or a `const` the file declares.
 */
function gateKeysOf(src: string): string[] {
    const code = codeOf(src);
    const keys = new Set<string>();
    const call = /\brequire(?:Any|All)?Permissions?\s*(?:<[^>]*>)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = call.exec(code)) !== null) {
        let i = m.index + m[0].length;
        while (/\s/.test(code[i])) i++;
        let arg: string;
        if (code[i] === "'") {
            arg = code.slice(i, code.indexOf("'", i + 1) + 1);
        } else if (code[i] === '[' || code[i] === '{') {
            const close = code[i] === '[' ? ']' : '}';
            arg = code.slice(i, code.indexOf(close, i) + 1);
        } else {
            const ident = /^[A-Za-z_$][\w$]*/.exec(code.slice(i))?.[0] ?? '';
            const decl = new RegExp(`const\\s+${ident}\\b[^=]*=\\s*([^;]+);`).exec(code);
            arg = decl?.[1] ?? '';
        }
        for (const k of arg.matchAll(KEY_LITERAL)) keys.add(k[1]);
    }
    return [...keys].sort();
}

/** `src/app/api/t/[tenantSlug]/admin/a/b/route.ts` → `/api/t/[slug]/admin/a/b`. */
const templateOf = (rel: string) =>
    rel.replace(/^src\/app/, '').replace('[tenantSlug]', '[slug]').replace(/\/route\.ts$/, '');
const insideAllowlist = (rel: string) => {
    const t = templateOf(rel);
    return AI_ADMIN_ADMIN_PATH_PREFIXES.some((p) => t === p || t.startsWith(`${p}/`));
};

async function admits(key: string, ctx = aiAdmin()): Promise<boolean> {
    try {
        await assertPermission(ctx, key as PermissionKey, { method: 'GET', path: '/x' });
        return true;
    } catch (err) {
        if (err instanceof ForbiddenError) return false;
        throw err;
    }
}

const routes = [API_ADMIN_DIR, ...OTHER_PRIVILEGED_DIRS]
    .flatMap((under) => repoFiles({ under, extensions: ['route.ts'] }))
    .map((abs) => {
        const rel = repoRelative(abs);
        return { rel, keys: gateKeysOf(readFileSync(abs, 'utf8')) };
    });

beforeEach(() => jest.clearAllMocks());

describe('every admin API gate on disk, asked about an AI_ADMIN', () => {
    it('the population is real: routes on both sides, and the extractor found keys', () => {
        expect(routes.filter((r) => insideAllowlist(r.rel)).length).toBeGreaterThan(20);
        expect(routes.filter((r) => !insideAllowlist(r.rel)).length).toBeGreaterThan(50);
        // Every route under the agent allowlist is gated by a key this
        // extractor can read; a route it could not read would pass vacuously.
        expect(routes.filter((r) => insideAllowlist(r.rel) && r.keys.length === 0).map((r) => r.rel)).toEqual([]);
    });

    // Routes under the agent subtree that are OWNER-only BY DESIGN. The edge
    // admits an AI_ADMIN to the subtree; the handler is the authority and
    // refuses it here, which is the intended outcome, not a gap. The list is
    // closed: a new route under the subtree whose key AI_ADMIN lacks fails the
    // test below until it is classified here with a reason.
    const OWNER_ONLY_UNDER_AGENT_SUBTREE: Readonly<Record<string, string>> = {
        // 2b (#3670): the orphan pass's mode decides whether agents are stopped
        // automatically, which is tenant lifecycle, as the identity ladder's
        // mode is (`/admin/identity-write-policy`).
        'src/app/api/t/[tenantSlug]/admin/agents/owner-orphan-pass/route.ts: admin.tenant_lifecycle':
            'the orphan-pass mode is an OWNER decision (tenant lifecycle), like the identity write ladder',
    };

    it('every gate under the agent allowlist names only keys AI_ADMIN holds, or is a listed OWNER-only route', async () => {
        const refused: string[] = [];
        for (const r of routes.filter((x) => insideAllowlist(x.rel))) {
            for (const key of r.keys) if (!(await admits(key))) refused.push(`${r.rel}: ${key}`);
        }
        expect(refused.sort()).toEqual(Object.keys(OWNER_ONLY_UNDER_AGENT_SUBTREE).sort());
        // Each listed exception is refused for a key that is OWNER-only, never
        // an agent key AI_ADMIN should have held.
        for (const entry of Object.keys(OWNER_ONLY_UNDER_AGENT_SUBTREE)) {
            expect(entry.endsWith(': admin.tenant_lifecycle') || entry.endsWith(': admin.owner_management')).toBe(true);
        }
    });

    it('every gate anywhere else admits AI_ADMIN only where it admits a READER too', async () => {
        const reader = makeRequestContext('READER', { tenantId: 'tenant-1', userId: 'reader-1' });
        const beyondReader: string[] = [];
        let asked = 0;
        for (const r of routes.filter((x) => !insideAllowlist(x.rel))) {
            for (const key of r.keys) {
                asked += 1;
                if ((await admits(key)) && !(await admits(key, reader))) beyondReader.push(`${r.rel}: ${key}`);
            }
        }
        expect(asked).toBeGreaterThan(50);
        expect(beyondReader).toEqual([]);
    });

    it('…and no gate outside the allowlist names an admin key AI_ADMIN holds', () => {
        const held = new Set(['agent_registry', 'agent_tool_exposure', 'agent_policy_card', 'agent_kill_switch', 'agent_external_tools', 'agent_harness_ingest', 'agent_ownership'].map((k) => `admin.${k}`));
        const offenders = routes
            .filter((r) => !insideAllowlist(r.rel))
            .flatMap((r) => r.keys.filter((k) => held.has(k)).map((k) => `${r.rel}: ${k}`));
        expect(offenders).toEqual([]);
    });

    it('a refusal writes the AUTHZ_DENIED row, as for any role', async () => {
        await expect(
            assertPermission(aiAdmin(), 'admin.members', { method: 'GET', path: '/api/t/acme/admin/members' }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect(auditSpy).toHaveBeenCalledTimes(1);
    });
});

describe('real route modules, end to end', () => {
    const routeArgs = (extra: Record<string, string> = {}) => ({
        params: Promise.resolve({ tenantSlug: 'acme', ...extra }),
    });

    it.each([
        ['GET', 'admin/members', '@/app/api/t/[tenantSlug]/admin/members/route'],
        ['GET', 'admin/security-settings', '@/app/api/t/[tenantSlug]/admin/security-settings/route'],
        ['GET', 'sso', '@/app/api/t/[tenantSlug]/sso/route'],
        ['GET', 'billing/events', '@/app/api/t/[tenantSlug]/billing/events/route'],
        ['PUT', 'security/mfa/policy', '@/app/api/t/[tenantSlug]/security/mfa/policy/route'],
    ] as const)('%s %s refuses an AI_ADMIN with a generic 403', async (method, _label, mod) => {
        getTenantCtxMock.mockResolvedValue(aiAdmin());
        const handlers = (await import(mod)) as Record<
            string,
            (req: NextRequest, args: unknown) => Promise<Response>
        >;
        const res = await handlers[method](
            new NextRequest('http://localhost/api/t/acme/x', {
                method,
                ...(method === 'GET' ? {} : { body: '{}', headers: new Headers({ 'content-type': 'application/json' }) }),
            }),
            routeArgs(),
        );
        expect(res.status).toBe(403);
        expect(JSON.stringify(await res.json())).not.toMatch(/admin\./);
        expect(auditSpy).toHaveBeenCalledTimes(1);
    });

    it('POST …/ownership-transfer/complete admits an AI_ADMIN and reaches the usecase', async () => {
        getTenantCtxMock.mockResolvedValue(aiAdmin());
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/admin/agents/[agentId]/ownership-transfer/complete/route'
        );
        const res = await POST(
            new NextRequest('http://localhost/api/t/acme/admin/agents/agent-1/ownership-transfer/complete', {
                method: 'POST',
                headers: new Headers({ 'content-type': 'application/json' }),
                body: JSON.stringify({ transferId: 'transfer-1' }),
            }),
            routeArgs({ agentId: 'agent-1' }) as never,
        );
        expect(res.status).toBe(200);
        expect(completeMock).toHaveBeenCalledTimes(1);
        expect(auditSpy).not.toHaveBeenCalled();
    });
});

describe('the agent usecases’ coarse floor — a strict superset of the one it replaced', () => {
    const KEYS = ['agent_registry', 'agent_tool_exposure', 'agent_policy_card', 'agent_kill_switch'] as const;

    it.each(KEYS)('AI_ADMIN (READER’s rung, holding %s) passes both floors', (key) => {
        const ctx = aiAdmin();
        expect(ctx.permissions.canWrite).toBe(false);
        expect(ctx.permissions.canAdmin).toBe(false);
        expect(() => assertAgentGovernanceWrite(ctx, key)).not.toThrow();
        expect(() => assertAgentGovernanceAdmin(ctx, key)).not.toThrow();
    });

    it.each(['OWNER', 'ADMIN'])('%s passes both floors on the coarse tier, as before', (role) => {
        for (const key of KEYS) {
            expect(() => assertAgentGovernanceWrite(makeRequestContext(role), key)).not.toThrow();
            expect(() => assertAgentGovernanceAdmin(makeRequestContext(role), key)).not.toThrow();
        }
    });

    it('EDITOR passes the write floor and is refused the admin floor, as before (no agent key)', () => {
        for (const key of KEYS) {
            expect(() => assertAgentGovernanceWrite(makeRequestContext('EDITOR'), key)).not.toThrow();
            expect(() => assertAgentGovernanceAdmin(makeRequestContext('EDITOR'), key)).toThrow(ForbiddenError);
        }
    });

    it.each(['READER', 'AUDITOR'])('%s is refused both floors, as before', (role) => {
        for (const key of KEYS) {
            expect(() => assertAgentGovernanceWrite(makeRequestContext(role), key)).toThrow(
                'You do not have permission to modify records in this context.',
            );
            expect(() => assertAgentGovernanceAdmin(makeRequestContext(role), key)).toThrow(
                'You do not have permission to perform administrative actions in this context.',
            );
        }
    });

    it('the key asked is the one that counts — holding a different agent key is not enough', () => {
        const base = makeRequestContext('READER');
        const onlyKill = {
            ...base,
            appPermissions: {
                ...base.appPermissions,
                admin: { ...base.appPermissions.admin, agent_kill_switch: true },
            },
        };
        expect(() => assertAgentGovernanceWrite(onlyKill, 'agent_kill_switch')).not.toThrow();
        expect(() => assertAgentGovernanceWrite(onlyKill, 'agent_registry')).toThrow(ForbiddenError);
    });

    it('a context with no read access is refused whatever key it holds', () => {
        const ctx = aiAdmin();
        const noRead = { ...ctx, permissions: { ...ctx.permissions, canRead: false } };
        expect(() => assertAgentGovernanceWrite(noRead, 'agent_registry')).toThrow(ForbiddenError);
    });
});
