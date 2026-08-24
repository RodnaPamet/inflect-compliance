/**
 * B3-2 — every `/api/t/[tenantSlug]/tasks/**` route, executed under a
 * role that must not be allowed through.
 *
 * `tests/guards/tenant-crud-authz-coverage.test.ts` covers two of the
 * seventeen tasks routes, and covers them by regex: it greps the source
 * for `requirePermission('tasks.edit'`. That check passes on a route
 * whose gate names a permission every role holds, on a route that gates
 * GET and forgets DELETE, and on a route whose import is present but
 * whose wrapper was dropped in a refactor. Fifteen routes — the four
 * bulk mutations among them — it never looks at at all.
 *
 * This runs them instead. For each route module and each HTTP method it
 * exports, the handler is invoked twice:
 *
 *   • as a READER — must be refused, and the usecase layer must not be
 *     reached. A missing gate shows up as the domain call happening;
 *     that is the actual defect, and no source pattern can see it.
 *   • as an EDITOR — must get through to the usecase. Without this, a
 *     gate that denies EVERYONE would pass the first assertion and the
 *     suite would be certifying a broken page as secure.
 *
 * Discovery is by directory walk, so a seventeenth route is covered the
 * day it lands rather than the day someone remembers to list it.
 */
import type { NextRequest } from 'next/server';
import * as fs from 'node:fs';
import * as path from 'node:path';

jest.mock('@/app-layer/context', () => ({ getTenantCtx: jest.fn() }));
jest.mock('@/lib/audit', () => ({ appendAuditEntry: jest.fn() }));

// Every one of the seventeen routes reaches the domain through this one
// module. Mocking it makes "did the handler body run?" observable as
// "was any usecase called?" — the question the regex guard cannot ask.
//
// The names are Listed explicitly rather than proxied: a Proxy has no own
// keys, so the ESM-interop wrapper Jest builds around a CJS mock cannot
// see them and the named imports arrive `undefined`.
const USECASE_NAMES = [
    'addTaskComment',
    'addTaskLink',
    'addTaskWatcher',
    'assignTask',
    'bulkAssignTasks',
    'bulkDeleteTask',
    'bulkSetTaskDueDate',
    'bulkSetTaskStatus',
    'createTask',
    'deleteTask',
    'getTask',
    'getTaskActivity',
    'getTaskEvidenceTab',
    'getTaskMetrics',
    'linkTaskEvidence',
    'listTaskComments',
    'listTaskLinks',
    'listTasks',
    'listTasksPaginated',
    'listTasksWithDeleted',
    'listTaskWatchers',
    'removeTaskLink',
    'removeTaskWatcher',
    'restoreTask',
    'setTaskStatus',
    'unlinkTaskEvidence',
    'updateTask',
] as const;

/** Names invoked since the last reset — i.e. "did the handler body run?" */
const usecaseCalls: string[] = [];

jest.mock('@/app-layer/usecases/task', () => {
    // Broad enough for any of the seventeen handlers to finish
    // serialising a response without a second mock.
    const result = {
        id: 't1', rows: [], items: [], count: 0,
        total: 0, updated: 0, deleted: 0, byStatus: {},
    };
    const mod: Record<string, unknown> = {};
    for (const name of USECASE_NAMES) {
        mod[name] = (...args: unknown[]) => {
            void args;
            (global as unknown as { __taskUsecaseCalls: string[] })
                .__taskUsecaseCalls.push(name);
            return Promise.resolve(result);
        };
    }
    return mod;
});

// The mock factory is hoisted above every `const` in this file, so the
// call log has to live somewhere it can reach at CALL time. `global` is
// that place; the local alias below is just for readability.
(global as unknown as { __taskUsecaseCalls: string[] }).__taskUsecaseCalls =
    usecaseCalls;

import { getTenantCtx } from '@/app-layer/context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import type { Role } from '@prisma/client';

const mockGetTenantCtx = getTenantCtx as jest.MockedFunction<typeof getTenantCtx>;

const TASKS_API_DIR = path.resolve(
    __dirname,
    '../../src/app/api/t/[tenantSlug]/tasks',
);

/** Every `route.ts` under the tasks API root, as a module path. */
function discoverRoutes(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) discoverRoutes(full, acc);
        else if (entry.name === 'route.ts') acc.push(full);
    }
    return acc;
}

const ROUTE_FILES = discoverRoutes(TASKS_API_DIR).sort();

/**
 * Routes whose HTTP gate is deliberately `tasks.view` on a write verb,
 * with the finer decision pushed into the usecase. Each entry has to
 * say WHY, because the entry is the thing standing between "documented
 * split" and "missing gate" — and those look identical from here.
 */
/**
 * Methods gated ABOVE the EDITOR tier — the mirror of VIEW_GATED_WRITES.
 *
 * The blanket "lets an EDITOR through" assertion below encodes the C.1
 * parity rule: a granular `.edit` key is true for the same roles as coarse
 * `canWrite`, so gating a write route changes the denial SHAPE and not who
 * is allowed. That rule does not extend to destructive verbs.
 *
 * `deleteTask` asserts `assertCanAdmin` — deleting is an ADMIN verb across
 * the codebase, and the comment on that assert records why the task-side
 * exception was closed: `bulkDeleteTask` was already ADMIN, so an EDITOR
 * refused the bulk delete could loop the single DELETE and reach the same
 * outcome. "A gate one call site can iterate around is not a gate."
 *
 * While the ROUTE declared the EDITOR-tier `tasks.edit`, an EDITOR passed the
 * middleware and was refused by the usecase — and a usecase throw writes no
 * AUTHZ_DENIED row, so that denial never reached the security trail. The key
 * now matches the assert, which means an EDITOR is refused HERE, and this
 * table is what keeps the two halves from drifting apart again.
 */
const ADMIN_GATED_WRITES: Record<string, { methods: string[]; reason: string }> = {
    '[taskId]/route.ts': {
        methods: ['DELETE'],
        reason:
            'deleteTask asserts assertCanAdmin. The route now declares ' +
            'admin.manage to match, so the denial happens at the layer that ' +
            'writes AUTHZ_DENIED rather than one layer deeper where nothing ' +
            'is recorded.',
    },
    'bulk/delete/route.ts': {
        methods: ['POST'],
        reason:
            'bulkDeleteTask has ALWAYS asserted assertCanAdmin — it is the ' +
            'gate the single DELETE above was raised to match. Its route, ' +
            'though, still declared tasks.edit, so the EDITOR it refused was ' +
            'refused one layer too deep and left no AUTHZ_DENIED row. Key ' +
            'corrected to admin.manage in #2117; who may bulk-delete is ' +
            'unchanged, where the refusal is recorded is not.',
    },
};

const VIEW_GATED_WRITES: Record<string, { methods: string[]; reason: string }> = {
    '[taskId]/watchers/route.ts': {
        methods: ['POST', 'DELETE'],
        reason:
            'Watching yourself is a personal subscription a READER must be ' +
            'able to do, so the route opens on tasks.view and addTaskWatcher / ' +
            'removeTaskWatcher escalate to the write gate when the target ' +
            'userId is not the caller. The route-level assertion below can ' +
            'only see that the usecase was reached; the escalation itself is ' +
            'the usecase layer\'s test to make.',
    },
};
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function ctxFor(role: Role): RequestContext {
    return {
        requestId: 'req-authz',
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role,
        permissions: {
            canRead: true,
            canWrite: role === 'OWNER' || role === 'ADMIN' || role === 'EDITOR',
            canAdmin: role === 'OWNER' || role === 'ADMIN',
            canAudit: role === 'AUDITOR',
            canExport: true,
        },
        appPermissions: getPermissionsForRole(role),
    };
}

/** A request shaped enough for the middleware and the body parsers. */
function requestFor(method: string): NextRequest {
    const body = {
        taskIds: ['task-1'],
        ids: ['task-1'],
        status: 'IN_PROGRESS',
        assigneeUserId: 'user-2',
        dueAt: '2026-09-01',
        title: 'x',
        body: 'x',
        userId: 'user-2',
        evidenceId: 'ev-1',
        // `AddTaskLinkSchema` — a link needs a real enum member.
        entityType: 'CONTROL',
        entityId: 'ctl-1',
        // `LinkTaskEvidenceSchema` — evidence attaches by URL.
        url: 'https://example.test/evidence.pdf',
        note: null,
    };
    return {
        method,
        url: 'https://test.local/api/t/acme/tasks',
        nextUrl: {
            pathname: '/api/t/acme/tasks',
            searchParams: new URLSearchParams(),
        },
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as NextRequest;
}

const routeArgs = {
    params: Promise.resolve({
        tenantSlug: 'acme',
        taskId: 'task-1',
        evidenceId: 'ev-1',
        linkId: 'link-1',
    }),
};

/**
 * Invoke one exported method. Returns whether the domain was reached —
 * the handler body running is the only thing that matters here, and a
 * thrown `forbidden` is exactly as much of a refusal as a 403 body
 * (`withApiErrorHandling` turns one into the other at the boundary).
 */
async function reachedDomain(
    handler: (req: NextRequest, args: typeof routeArgs) => Promise<unknown>,
    method: string,
): Promise<boolean> {
    usecaseCalls.length = 0;
    try {
        await handler(requestFor(method), routeArgs);
    } catch {
        /* forbidden / validation — either way, see what was called */
    }
    return usecaseCalls.length > 0;
}

describe('tasks API — every route refuses a READER and admits an EDITOR', () => {
    beforeEach(() => {
        usecaseCalls.length = 0;
        mockGetTenantCtx.mockReset();
    });

    it('discovers the whole tasks route surface, not a curated pair', () => {
        // The regex guard lists two. If this drops to two, discovery
        // broke; if it grows, the new route is already covered below.
        expect(ROUTE_FILES.length).toBeGreaterThanOrEqual(17);
    });

    for (const file of ROUTE_FILES) {
        const rel = path.relative(TASKS_API_DIR, file);

        describe(rel, () => {
            const mod = require(file) as Record<string, unknown>;
            const exported = METHODS.filter((m) => typeof mod[m] === 'function');

            it('exports at least one HTTP method', () => {
                expect(exported.length).toBeGreaterThan(0);
            });

            for (const method of exported) {
                const handler = mod[method] as (
                    req: NextRequest,
                    args: typeof routeArgs,
                ) => Promise<unknown>;

                const carveOut = VIEW_GATED_WRITES[rel];
                const delegated =
                    carveOut !== undefined && carveOut.methods.includes(method);

                it(`${method} does not let a READER reach the domain`, async () => {
                    mockGetTenantCtx.mockResolvedValue(ctxFor('READER'));
                    const reached = await reachedDomain(handler, method);
                    // A READER may read; writes must be refused outright —
                    // except where a documented carve-out delegates the
                    // decision one layer down.
                    if (method !== 'GET' && !delegated) {
                        expect({ route: rel, method, reachedDomain: reached }).toEqual({
                            route: rel,
                            method,
                            reachedDomain: false,
                        });
                    } else if (delegated) {
                        // Keeps the carve-out honest in BOTH directions: the
                        // day this route grows a real write gate, the entry
                        // above is stale and has to come out in that diff.
                        expect({ route: rel, method, reachedDomain: reached }).toEqual({
                            route: rel,
                            method,
                            reachedDomain: true,
                        });
                    }
                });

                const adminOnly = ADMIN_GATED_WRITES[rel]?.methods.includes(method) ?? false;

                it(`${method} lets an EDITOR through — the gate is not deny-all`, async () => {
                    mockGetTenantCtx.mockResolvedValue(ctxFor('EDITOR'));
                    const reached = await reachedDomain(handler, method);
                    expect({ route: rel, method, reachedDomain: reached }).toEqual({
                        route: rel,
                        method,
                        // An ADMIN-tier verb refuses an EDITOR at the gate, by
                        // design — that is the whole point of matching the key
                        // to the usecase's assert.
                        reachedDomain: !adminOnly,
                    });
                });

                if (adminOnly) {
                    it(`${method} still admits an ADMIN — the gate is not deny-all`, async () => {
                        // The not-deny-all half the assertion above gives up
                        // for this method. Without it, gating DELETE to a
                        // permission NOBODY holds would look correct.
                        mockGetTenantCtx.mockResolvedValue(ctxFor('ADMIN'));
                        const reached = await reachedDomain(handler, method);
                        expect({ route: rel, method, reachedDomain: reached }).toEqual({
                            route: rel,
                            method,
                            reachedDomain: true,
                        });
                    });
                }
            }
        });
    }
});
