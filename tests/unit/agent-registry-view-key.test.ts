/**
 * THE AGENT INVENTORY VIEW KEY (#3710) — `admin.agent_registry_view`.
 *
 * Read-only, held by OWNER, ADMIN, AI_ADMIN and AUDITOR, expressible by a
 * custom role, and reached by a bearer token through ONE named scope that no
 * wildcard carries. Every claim below is asserted against the real function
 * that decides it:
 *
 *   1. who holds it, and that a custom role can carry it;
 *   2. the scope: `admin:agent_registry_view` grants it and nothing else, and
 *      no other scope — `*` and `admin:*` included — grants it, so every key
 *      already issued resolves exactly as it did;
 *   3. THE VIEW KEY GRANTS NO WRITE. Every write handler of every API route that
 *      names `admin.agent_registry` is read off the filesystem and its gate is
 *      asked about a view-only principal, and every usecase gated on the
 *      register key is called with one — each refuses, and a usecase refuses
 *      before it reaches the database;
 *   4. AI_ADMIN reads runs, proposals and the pack and writes none of them, and
 *      cannot approve a proposal;
 *   5. the edge admits an AUDITOR to the inventory GETs and nothing else, and
 *      the static segments it reads as "not an agent id" are the filesystem's.
 */
import { strictMock } from '../helpers/strict-mock';

const DB_REACHED = 'test: a gated usecase reached the database before refusing';

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

const auditSpy = jest.fn(async () => ({ recorded: 'chain' as const, auditId: 'audit-x' }));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (...args: unknown[]) => auditSpy(...(args as [])),
        appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'h', previousHash: null })),
    }),
);

// A usecase that refuses must refuse BEFORE it reads anything. Both specifiers
// the code uses are replaced, so neither path reaches a real client.
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: jest.fn(async () => {
        throw new Error(DB_REACHED);
    }),
}));
jest.mock('@/lib/db-context', () => ({
    ...jest.requireActual('@/lib/db-context'),
    runInTenantContext: jest.fn(async () => {
        throw new Error(DB_REACHED);
    }),
}));

import { readFileSync } from 'fs';
import { NextRequest } from 'next/server';

import {
    AGENT_ADMIN_KEYS,
    PERMISSION_SCHEMA,
    getPermissionsForRole,
    mayReadAgentActivity,
    mayReadAgentInventory,
    parsePermissionsJson,
    permissionsExceeding,
    validatePermissionsJson,
    type PermissionSet,
} from '@/lib/permissions';
import {
    VALID_SCOPES,
    WILDCARD_EXCLUDED_ACTIONS,
    enforceApiKeyScope,
    scopesToPermissions,
} from '@/lib/auth/api-key-auth';
import {
    AGENT_ADMIN_API_STATIC_SEGMENTS,
    AUDITOR_ADMIN_READ_PATHS,
    checkAdminAccess,
    isAuditorAdminReadPath,
} from '@/lib/auth/guard';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { assertPermission, type PermissionKey } from '@/lib/security/permission-middleware';
import type { PermissionMode } from '@/lib/security/permission-middleware';
import { ForbiddenError } from '@/lib/errors/types';
import { TENANT_ROLES } from '@/lib/roles';
import type { RequestContext } from '@/app-layer/types';

import { makeRequestContext } from '../helpers/make-context';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf, declarationOf, functionBodyOf } from '../helpers/source-blocks';

const VIEW = 'admin.agent_registry_view';
const REGISTRY = 'admin.agent_registry';

/** A principal whose ONLY agent key is the view key, on READER's rung. */
const auditor = (): RequestContext => makeRequestContext('AUDITOR', { tenantId: 'tenant-1', userId: 'auditor-1' });

/**
 * The same key on an EDITOR base: the coarse tier says `canWrite`, so a usecase
 * floor that reads the tier admits it — and the route's literal gate is what
 * must refuse. This is the principal that proves the ROUTE is the authority.
 */
function viewOnlyOnEditorBase(): RequestContext {
    const editor = getPermissionsForRole('EDITOR');
    return makeRequestContext('EDITOR', {
        tenantId: 'tenant-1',
        userId: 'editor-view-1',
        appPermissions: { ...editor, admin: { ...editor.admin, agent_registry_view: true } },
    });
}

const aiAdmin = (): RequestContext => makeRequestContext('AI_ADMIN', { tenantId: 'tenant-1', userId: 'ai-1' });

async function admitted(ctx: RequestContext, keys: readonly string[], mode: PermissionMode = 'all'): Promise<boolean> {
    try {
        await assertPermission(ctx, { keys: keys as PermissionKey[], mode }, { method: 'GET', path: '/x' });
        return true;
    } catch (err) {
        if (err instanceof ForbiddenError) return false;
        throw err;
    }
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── 1. who holds it ────────────────────────────────────────────────────────

describe('who holds admin.agent_registry_view', () => {
    it.each([
        ['OWNER', true],
        ['ADMIN', true],
        ['AI_ADMIN', true],
        ['AUDITOR', true],
        ['EDITOR', false],
        ['READER', false],
    ] as const)('%s → %s', (role, expected) => {
        expect(getPermissionsForRole(role).admin.agent_registry_view).toBe(expected);
    });

    it('the table covers every built-in role', () => {
        expect([...TENANT_ROLES].sort()).toEqual(['ADMIN', 'AI_ADMIN', 'AUDITOR', 'EDITOR', 'OWNER', 'READER']);
    });

    it('is a real admin key and an AGENT key (so AI_ADMIN holds it by construction)', () => {
        expect(PERMISSION_SCHEMA.admin).toContain('agent_registry_view');
        expect(AGENT_ADMIN_KEYS).toContain('agent_registry_view');
    });

    it('AUDITOR gains it and nothing else that writes — its admin set is the view key and the DSAR read', () => {
        const admin = getPermissionsForRole('AUDITOR').admin as Record<string, boolean>;
        expect(Object.keys(admin).filter((k) => admin[k]).sort()).toEqual(['agent_registry_view', 'compliance_dsar_view']);
    });

    it('the inventory read admits the view key OR the register key; neither alone is needed', () => {
        const none = getPermissionsForRole('READER').admin;
        expect(mayReadAgentInventory(none)).toBe(false);
        expect(mayReadAgentInventory({ ...none, agent_registry_view: true })).toBe(true);
        // A custom role saved before the split carries the register key and
        // takes the view key from a READER base, i.e. false. It keeps the read.
        expect(mayReadAgentInventory({ ...none, agent_registry: true })).toBe(true);
        expect(mayReadAgentInventory(undefined)).toBe(false);
    });

    it('the activity read (runs, proposals) admits admin.view OR the view key, and not the register key', () => {
        const none = getPermissionsForRole('READER').admin;
        expect(mayReadAgentActivity(none)).toBe(false);
        expect(mayReadAgentActivity({ ...none, view: true })).toBe(true);
        expect(mayReadAgentActivity({ ...none, agent_registry_view: true })).toBe(true);
        const registerOnly = { ...none, agent_registry: true };
        expect(mayReadAgentActivity(registerOnly)).toBe(false);
        expect(mayReadAgentActivity(getPermissionsForRole('AI_ADMIN').admin)).toBe(true);
        expect(mayReadAgentActivity(getPermissionsForRole('AUDITOR').admin)).toBe(true);
    });
});

describe('a custom role may express it', () => {
    const blob = (base: 'READER' | 'ADMIN', overrides: Partial<PermissionSet['admin']>) => {
        const set = getPermissionsForRole(base);
        return { ...set, admin: { ...set.admin, ...overrides } };
    };

    it('a blob carrying it validates and parses with it on, over a READER base', () => {
        const json = blob('READER', { agent_registry_view: true });
        expect(validatePermissionsJson(json)).toEqual([]);
        expect(parsePermissionsJson(json, 'READER').admin.agent_registry_view).toBe(true);
    });

    it('a stored blob saved before the key existed takes it from its base role', () => {
        const json = blob('READER', { agent_registry: true }) as Record<string, unknown>;
        const admin = { ...(json.admin as Record<string, boolean>) };
        delete admin.agent_registry_view;
        const parsed = parsePermissionsJson({ ...json, admin }, 'READER');
        expect(parsed.admin.agent_registry_view).toBe(false);
        // …and keeps the inventory read through the register key it does hold.
        expect(mayReadAgentInventory(parsed.admin)).toBe(true);
    });

    it('an ADMIN may grant it (they hold it); an EDITOR-held set may not', () => {
        const granted = parsePermissionsJson(blob('READER', { agent_registry_view: true }), 'READER');
        expect(permissionsExceeding(granted, getPermissionsForRole('ADMIN'))).toEqual([]);
        expect(permissionsExceeding(granted, getPermissionsForRole('EDITOR'))).toEqual(['admin.agent_registry_view']);
    });
});

// ─── 2. the scope ───────────────────────────────────────────────────────────

describe('admin:agent_registry_view — one named scope, and no wildcard', () => {
    const flagsOf = (scopes: string[]) => {
        const p = scopesToPermissions(scopes) as unknown as Record<string, Record<string, boolean>>;
        return Object.entries(p).flatMap(([d, a]) => Object.entries(a).filter(([, on]) => on).map(([k]) => `${d}.${k}`));
    };

    it('is mintable, and grants the view key and NOTHING else — not the register key', () => {
        expect(VALID_SCOPES).toContain('admin:agent_registry_view');
        expect(flagsOf(['admin:agent_registry_view'])).toEqual([VIEW]);
    });

    it('no other mintable scope grants it — `*` and `admin:*` included — so every issued key is unchanged', () => {
        const carrying = VALID_SCOPES.filter((s) => s !== 'admin:agent_registry_view').filter(
            (s) => scopesToPermissions([s]).admin.agent_registry_view === true,
        );
        expect(carrying).toEqual([]);
        // The paired positive: the wildcards still grant what they did.
        expect(scopesToPermissions(['*']).admin.manage).toBe(true);
        expect(scopesToPermissions(['admin:*']).admin.agent_harness_ingest).toBe(true);
        expect(scopesToPermissions(['admin:*']).admin.view).toBe(true);
    });

    it('the credential check agrees: a wildcard does not satisfy the named group, the name does', () => {
        const keyCtx = (scopes: string[]) => makeRequestContext('ADMIN', { apiKeyId: 'key-1', apiKeyScopes: scopes });
        expect(() => enforceApiKeyScope(keyCtx(['*']), 'admin', 'agent_registry_view')).toThrow(ForbiddenError);
        expect(() => enforceApiKeyScope(keyCtx(['admin:*']), 'admin', 'agent_registry_view')).toThrow(ForbiddenError);
        expect(() => enforceApiKeyScope(keyCtx(['admin:read']), 'admin', 'agent_registry_view')).toThrow(ForbiddenError);
        expect(() => enforceApiKeyScope(keyCtx(['admin:agent_registry_view']), 'admin', 'agent_registry_view')).not.toThrow();
        // The wildcards still satisfy every ordinary action, as before.
        expect(() => enforceApiKeyScope(keyCtx(['*']), 'admin', 'read')).not.toThrow();
        expect(() => enforceApiKeyScope(keyCtx(['admin:*']), 'admin', 'write')).not.toThrow();
    });

    it('every action only its name grants is READ-ONLY: it maps to `_view` flags alone', () => {
        const groups = Object.entries(WILDCARD_EXCLUDED_ACTIONS).flatMap(([r, as]) => as.map((a) => `${r}:${a}`));
        expect(groups.sort()).toEqual(['admin:agent_registry_view', 'audits:workpaper_view']);
        for (const g of groups) {
            const flags = flagsOf([g]);
            expect(flags.length).toBeGreaterThan(0);
            expect(flags.filter((f) => !f.endsWith('_view'))).toEqual([]);
        }
    });
});

// ─── 3. the view key grants no write ────────────────────────────────────────

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const KEY_LITERAL = new RegExp(`'((?:${Object.keys(PERMISSION_SCHEMA).join('|')})\\.[a-z_]+)'`, 'g');

/** The keys and mode of the FIRST permission gate inside one exported handler. */
function gateOf(handler: string): { keys: string[]; mode: PermissionMode } {
    const m = /\brequire(Any|All)?Permissions?\s*(?:<[^>]*>)?\s*\(/.exec(handler);
    if (!m) return { keys: [], mode: 'all' };
    let i = m.index + m[0].length;
    while (/\s/.test(handler[i])) i++;
    let arg: string;
    if (handler[i] === "'") arg = handler.slice(i, handler.indexOf("'", i + 1) + 1);
    else if (handler[i] === '[' || handler[i] === '{') arg = handler.slice(i, handler.indexOf(handler[i] === '[' ? ']' : '}', i) + 1);
    else arg = '';
    const keys = [...arg.matchAll(KEY_LITERAL)].map((k) => k[1]);
    const mode: PermissionMode = m[1] === 'Any' || /mode:\s*'any'/.test(arg) ? 'any' : 'all';
    return { keys, mode };
}

const registryRoutes = repoFiles({ under: 'src/app/api', extensions: ['route.ts'] })
    .map((abs) => ({ rel: repoRelative(abs), src: readFileSync(abs, 'utf8') }))
    .filter((r) => r.src.includes(`'${REGISTRY}'`));

const writeHandlers = registryRoutes.flatMap((r) => {
    const code = codeOf(r.src);
    return WRITE_METHODS.filter((m) => new RegExp(`export const ${m} =`).test(code)).map((m) => ({
        id: `${r.rel} ${m}`,
        ...gateOf(declarationOf(code, m)),
    }));
});

describe('every write handler of every route that names admin.agent_registry refuses a view-only principal', () => {
    it('the population is real — derived from the filesystem, not listed here', () => {
        expect(registryRoutes.length).toBeGreaterThan(25);
        expect(writeHandlers.length).toBeGreaterThan(20);
        // Every one is gated by a key this extractor can read; an ungated write
        // would pass the refusal below vacuously.
        expect(writeHandlers.filter((h) => h.keys.length === 0).map((h) => h.id)).toEqual([]);
    });

    it('no write handler names the view key', () => {
        expect(writeHandlers.filter((h) => h.keys.includes(VIEW)).map((h) => h.id)).toEqual([]);
    });

    it.each([
        ['AUDITOR (READER rung)', auditor],
        ['a custom role on an EDITOR base holding only the view key', viewOnlyOnEditorBase],
    ])('%s is refused by every one of them, and each refusal is audited', async (_label, principal) => {
        const admittedTo: string[] = [];
        for (const h of writeHandlers) if (await admitted(principal(), h.keys, h.mode)) admittedTo.push(h.id);
        expect(admittedTo).toEqual([]);
        expect(auditSpy).toHaveBeenCalledTimes(writeHandlers.length);
    });

    it('the paired positive: an OWNER passes every one of them', async () => {
        const refused: string[] = [];
        for (const h of writeHandlers) if (!(await admitted(makeRequestContext('OWNER'), h.keys, h.mode))) refused.push(h.id);
        expect(refused).toEqual([]);
    });
});

/**
 * Every usecase gated on the register key — directly, or through a private
 * helper one call away — read off the source. Called with a view-only principal
 * and stub arguments, each must refuse with a ForbiddenError, and before the
 * database (which would throw `DB_REACHED` instead).
 */
const GATE = /assertAgentGovernance(?:Write|Admin)\(ctx, 'agent_registry'\)|!ctx\.appPermissions\??\.admin\??\.agent_registry\)/;

function gatedUsecases(): Array<{ file: string; name: string }> {
    const files = [
        ...repoFiles({ under: 'src/app-layer/usecases', extensions: ['.ts'] }),
        ...repoFiles({ under: 'src/lib/agentic', extensions: ['.ts'] }),
    ];
    const out: Array<{ file: string; name: string }> = [];
    for (const abs of files) {
        const src = readFileSync(abs, 'utf8');
        // Only a file that names the key can gate on it.
        if (!src.includes('agent_registry')) continue;
        const code = codeOf(src);
        const exported = [...code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
        const helpers = [...code.matchAll(/(?<!export\s+)(?<!export\s+async\s+)\bfunction\s+(\w+)\s*\(\s*ctx\b/g)]
            .map((m) => m[1])
            .filter((n) => !exported.includes(n) && GATE.test(functionBodyOf(src, n)));
        for (const name of exported) {
            const body = functionBodyOf(src, name);
            if (GATE.test(body) || helpers.some((h) => new RegExp(`\\b${h}\\(ctx\\)`).test(body))) {
                out.push({ file: repoRelative(abs), name });
            }
        }
    }
    return out;
}

/** What stays on the register key ALONE — every gated usecase must be here or be an inventory read. */
const INVENTORY_READS = new Set<string>([
    // None. The inventory reads moved to `mayReadAgentInventory`, so the GATE
    // pattern above no longer matches them; a match here would mean a read was
    // left on the register key, which is a decision to record, not to absorb.
]);

describe('every usecase gated on admin.agent_registry refuses a view-only principal before the database', () => {
    const gated = gatedUsecases();

    it('the population is real', () => {
        expect(gated.length).toBeGreaterThan(20);
        expect(gated.map((g) => g.name)).toEqual(
            expect.arrayContaining(['createRegisteredAgent', 'activateRegisteredAgent', 'retireRegisteredAgent', 'addHarnessScannerKey']),
        );
        expect(gated.filter((g) => INVENTORY_READS.has(g.name))).toEqual([]);
    });

    it('AUDITOR is refused by each, with a ForbiddenError and no database read', async () => {
        const outcomes: string[] = [];
        for (const { file, name } of gated) {
            const mod = (await import(`@/${file.replace(/^src\//, '').replace(/\.ts$/, '')}`)) as Record<
                string,
                (...args: unknown[]) => unknown
            >;
            try {
                await Promise.resolve().then(() => mod[name](auditor(), {}, {}, {}, {}));
                outcomes.push(`${file}#${name}: ADMITTED`);
            } catch (err) {
                if (!(err instanceof ForbiddenError)) {
                    outcomes.push(`${file}#${name}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        expect(outcomes).toEqual([]);
    });
});

// ─── 4. AI_ADMIN reads, writes none, approves nothing ───────────────────────

describe('AI_ADMIN reads runs, proposals and the pack, and writes none of them', () => {
    it('holds the reads: the activity read, the inventory read, and the pack routes’ gate', async () => {
        const ctx = aiAdmin();
        expect(mayReadAgentActivity(ctx.appPermissions.admin)).toBe(true);
        expect(mayReadAgentInventory(ctx.appPermissions.admin)).toBe(true);
        expect(ctx.appPermissions.admin.view).toBe(false);
        expect(await admitted(ctx, [VIEW, REGISTRY], 'any')).toBe(true);
    });

    it('cannot approve, reject or bulk-reject a proposal: approval writes the domain the proposal changes', async () => {
        const { approveAgentProposal, rejectAgentProposal, bulkRejectAgentProposals } = await import(
            '@/app-layer/usecases/agent-proposals'
        );
        await expect(approveAgentProposal(aiAdmin(), 'proposal-1')).rejects.toBeInstanceOf(ForbiddenError);
        await expect(rejectAgentProposal(aiAdmin(), 'proposal-1')).rejects.toBeInstanceOf(ForbiddenError);
        await expect(bulkRejectAgentProposals(aiAdmin(), ['proposal-1'])).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('the approve ROUTE refuses it with a 403, before the usecase reads anything', async () => {
        getTenantCtxMock.mockResolvedValue(aiAdmin());
        const { POST } = await import('@/app/api/t/[tenantSlug]/agent-proposals/[id]/approve/route');
        const res = await POST(
            new NextRequest('http://localhost/api/t/acme/agent-proposals/proposal-1/approve', {
                method: 'POST',
                headers: new Headers({ 'content-type': 'application/json' }),
                body: JSON.stringify({}),
            }),
            { params: Promise.resolve({ tenantSlug: 'acme', id: 'proposal-1' }) },
        );
        expect(res.status).toBe(403);
    });

    it('cannot start, resume or abort a run', async () => {
        const { startWorkflowRun, resumeWorkflowRun, abortWorkflowRun } = await import(
            '@/app-layer/usecases/workflow-runs'
        );
        await expect(startWorkflowRun(aiAdmin(), 'posture-review', {})).rejects.toBeInstanceOf(ForbiddenError);
        await expect(resumeWorkflowRun(aiAdmin(), 'run-1')).rejects.toBeInstanceOf(ForbiddenError);
        await expect(abortWorkflowRun(aiAdmin(), 'run-1')).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('cannot FILE the pack: filing writes an Evidence row, under the register key AND evidence.edit', async () => {
        const { exportAgentGovernancePack } = await import('@/app-layer/usecases/agent-governance-pack-export');
        // AI_ADMIN holds the register key and lacks evidence.edit; AUDITOR holds
        // neither. Both read the pack (above) and neither files it.
        expect(aiAdmin().appPermissions.evidence.edit).toBe(false);
        await expect(exportAgentGovernancePack(aiAdmin())).rejects.toThrow('You do not have permission to edit evidence.');
        await expect(exportAgentGovernancePack(auditor())).rejects.toBeInstanceOf(ForbiddenError);
    });
});

// ─── 5. the declarative map, and the edge ───────────────────────────────────

describe('the route-permission map', () => {
    const resolve = (path: string, method: string) => {
        const r = resolveRoutePermission(path, method);
        return r ? { keys: ([] as string[]).concat(r.permission), mode: r.mode } : null;
    };
    const INVENTORY = { keys: [VIEW, REGISTRY], mode: 'any' };

    it.each([
        ['/api/t/acme/admin/agents', 'GET'],
        ['/api/t/acme/admin/agents/agent-1', 'GET'],
        ['/api/t/acme/admin/agents/harness-scans', 'GET'],
        ['/api/t/acme/admin/agents/harness-estates', 'GET'],
        ['/api/t/acme/admin/agents/reports', 'GET'],
    ])('%s %s is the inventory read', (path, method) => {
        expect(resolve(path, method)).toEqual(INVENTORY);
    });

    it.each([
        ['/api/t/acme/admin/agents', 'POST'],
        ['/api/t/acme/admin/agents/agent-1', 'PATCH'],
        ['/api/t/acme/admin/agents/agent-1', 'DELETE'],
        ['/api/t/acme/admin/agents/harness-scanner-keys', 'GET'],
        ['/api/t/acme/admin/agents/skills', 'GET'],
        ['/api/t/acme/admin/agents/peers', 'POST'],
        ['/api/t/acme/admin/agents/intake', 'POST'],
        // Declaring, changing or removing a client estate (#3678).
        ['/api/t/acme/admin/agents/harness-estates', 'POST'],
        ['/api/t/acme/admin/agents/harness-estates/est-1', 'PATCH'],
        ['/api/t/acme/admin/agents/harness-estates/est-1', 'DELETE'],
        // Filing the pack is a WRITE — an Evidence row — so not the view key.
        ['/api/t/acme/admin/agents/reports/export', 'POST'],
    ])('%s %s stays on the register key alone', (path, method) => {
        expect(resolve(path, method)).toEqual({ keys: [REGISTRY], mode: 'all' });
    });

    it('the runs and proposals reads behind the run routes admit admin.view OR the view key', () => {
        expect(resolve('/api/t/acme/agent-runs/run-1/stream', 'GET')).toEqual({ keys: ['admin.view', VIEW], mode: 'any' });
        expect(resolve('/api/t/acme/agent-runs/run-1/checkpoint', 'GET')).toEqual({ keys: ['admin.view', VIEW], mode: 'any' });
    });
});

describe('the edge: an AUDITOR reaches the inventory GETs and nothing else under /admin', () => {
    const memberships = [{ slug: 'acme', role: 'AUDITOR' }];

    it('the static segments beside [agentId] are exactly the filesystem’s', () => {
        const onDisk = new Set(
            repoFiles({ under: 'src/app/api/t/[tenantSlug]/admin/agents', extensions: ['route.ts'] })
                .map((abs) => repoRelative(abs).replace('src/app/api/t/[tenantSlug]/admin/agents/', '').split('/')[0])
                .filter((seg) => seg !== 'route.ts' && !seg.startsWith('[')),
        );
        expect([...AGENT_ADMIN_API_STATIC_SEGMENTS].sort()).toEqual([...onDisk].sort());
    });

    it.each([
        '/api/t/acme/admin/agents',
        '/api/t/acme/admin/agents/',
        '/api/t/acme/admin/agents/agent-1',
        '/api/t/acme/admin/agents/harness-scans',
        '/api/t/acme/admin/agents/harness-estates',
        '/api/t/acme/admin/agents/reports',
        // #4898: the usecase applies the Owner's switch; the edge only admits.
        '/api/t/acme/admin/mcp/quarantine',
    ])('admits GET and HEAD %s', (path) => {
        expect(checkAdminAccess(path, 'AUDITOR', memberships, 'GET')).toBe('allow');
        expect(checkAdminAccess(path, 'AUDITOR', memberships, 'HEAD')).toBe('allow');
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE', undefined])('refuses %s on the same paths', (method) => {
        for (const path of ['/api/t/acme/admin/agents', '/api/t/acme/admin/agents/agent-1', '/api/t/acme/admin/agents/harness-estates']) {
            expect(checkAdminAccess(path, 'AUDITOR', memberships, method)).toBe('deny');
        }
    });

    it('refuses every static sibling, every deeper path, every other admin root, and the export', () => {
        const refused = [
            ...AGENT_ADMIN_API_STATIC_SEGMENTS.filter(
                (s) => s !== 'harness-scans' && s !== 'harness-estates' && s !== 'reports',
            ).map((s) => `/api/t/acme/admin/agents/${s}`),
            // One estate's own path is a write path (PATCH, DELETE): the
            // allowance is the exact list template, nothing beneath it.
            '/api/t/acme/admin/agents/harness-estates/est-1',
            '/api/t/acme/admin/agents/agent-1/risk-assessment',
            '/api/t/acme/admin/agents/agent-1/tools',
            '/api/t/acme/admin/agents/reports/export',
            '/api/t/acme/admin/members',
            '/api/t/acme/admin/dsar-requests',
            '/t/acme/admin/agents',
        ];
        expect(refused.filter((p) => checkAdminAccess(p, 'AUDITOR', memberships, 'GET') !== 'deny')).toEqual([]);
    });

    it('refuses non-canonical forms, and judges the role in the URL’s tenant', () => {
        for (const p of ['/api/t/acme/admin/agents/%2e%2e', '/api/t/acme/admin/agents//x', '/api/t/acme/admin/agents/..']) {
            expect(isAuditorAdminReadPath(p, 'GET')).toBe(false);
        }
        expect(checkAdminAccess('/api/t/acme/admin/agents', 'AUDITOR', [{ slug: 'acme', role: 'READER' }], 'GET')).toBe('deny');
        expect(checkAdminAccess('/api/t/acme/admin/agents', 'READER', [{ slug: 'acme', role: 'EDITOR' }], 'GET')).toBe('deny');
    });

    it('every path the allowance names is a route whose GET gate admits an AUDITOR', async () => {
        const routeOf: Record<string, string> = {
            '/api/t/[slug]/admin/agents': 'src/app/api/t/[tenantSlug]/admin/agents/route.ts',
            '/api/t/[slug]/admin/agents/[agentId]': 'src/app/api/t/[tenantSlug]/admin/agents/[agentId]/route.ts',
            '/api/t/[slug]/admin/agents/harness-scans': 'src/app/api/t/[tenantSlug]/admin/agents/harness-scans/route.ts',
            '/api/t/[slug]/admin/agents/harness-estates': 'src/app/api/t/[tenantSlug]/admin/agents/harness-estates/route.ts',
            '/api/t/[slug]/admin/agents/reports': 'src/app/api/t/[tenantSlug]/admin/agents/reports/route.ts',
            '/api/t/[slug]/admin/mcp/quarantine': 'src/app/api/t/[tenantSlug]/admin/mcp/quarantine/route.ts',
        };
        expect(Object.keys(routeOf).sort()).toEqual([...AUDITOR_ADMIN_READ_PATHS].sort());
        for (const rel of Object.values(routeOf)) {
            const gate = gateOf(declarationOf(codeOf(readFileSync(rel, 'utf8')), 'GET'));
            expect({ rel, admitted: await admitted(auditor(), gate.keys, gate.mode) }).toEqual({ rel, admitted: true });
        }
    });
});
