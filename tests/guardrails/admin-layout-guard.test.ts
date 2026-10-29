/**
 * Guardrail test: the admin subtree's two guards.
 *
 *   1. The ON-SCREEN guard — the centralized client layout
 *      (`admin/layout.tsx`) renders ForbiddenPage for a caller without
 *      `admin.view`, and pages do not duplicate it. The first two describe
 *      blocks below.
 *   2. The DATA guard — every admin SERVER page refuses on the server before
 *      it reads (`gateAdminPage`). The client layout cannot be that guard: see
 *      the block comment above the last two describe blocks.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import { REPO_ROOT, repoFiles, repoRelative } from '../helpers/repo-files';
import { ADMIN_PAGE_REQUIREMENTS } from '@/app/t/[tenantSlug]/(app)/admin/_lib/admin-page-requirements';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ADMIN_LAYOUT_PATH = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/admin/layout.tsx'
);

describe('Admin layout guard', () => {
    test('admin layout.tsx exists', () => {
        expect(fs.existsSync(ADMIN_LAYOUT_PATH)).toBe(true);
    });

    test('admin layout imports RequirePermission', () => {
        const content = codeOf(fs.readFileSync(ADMIN_LAYOUT_PATH, 'utf-8'));
        expect(content).toContain('RequirePermission');
    });

    test('admin layout imports ForbiddenPage', () => {
        const content = codeOf(fs.readFileSync(ADMIN_LAYOUT_PATH, 'utf-8'));
        expect(content).toContain('ForbiddenPage');
    });

    test('admin layout checks admin resource permission', () => {
        const content = codeOf(fs.readFileSync(ADMIN_LAYOUT_PATH, 'utf-8'));
        expect(content).toContain('resource="admin"');
    });
});

/**
 * Guardrail: No admin page should have its own redundant RequirePermission
 * for the "admin" resource. The layout handles the ON-SCREEN guard centrally.
 *
 * That is a statement about what is SHOWN, not about what is sent. The layout
 * is a client component, so it cannot keep a server page's props out of the
 * RSC payload; every admin server page therefore also refuses on the server,
 * through `gateAdminPage` (`admin/_lib/admin-page-gate.tsx`), which is not the
 * redundancy this block refuses and does not import either component it scans
 * for. The last two describe blocks in this file hold that gate.
 *
 * Pages that need finer-grained checks (e.g. admin.manage vs admin.view)
 * should be explicitly allowlisted below.
 *
 * The allowlist is keyed on the path RELATIVE TO the admin dir, not on the
 * basename. Keying on the basename could only ever hold `layout.tsx`, since
 * every page file in the tree is called `page.tsx` — so the "finer-grained
 * checks" carve-out the comment above promises was unreachable, and the first
 * page that legitimately needed a stricter gate would have had to choose
 * between failing CI and moving its guard somewhere the scan does not look.
 *
 * An entry is not a blanket pass. `STRICTER_GUARD_PAGES` is asserted to hold a
 * gate that is genuinely NARROWER than the layout's `admin.view` — an entry
 * that degrades to `action="view"` is redundant again and fails.
 */
describe('No duplicate admin guards on pages', () => {
    const ADMIN_PAGES_DIR = path.resolve(
        __dirname,
        '../../src/app/t/[tenantSlug]/(app)/admin'
    );

    /**
     * Pages whose own `RequirePermission` is STRICTER than the layout's, with
     * the reason. Path is relative to ADMIN_PAGES_DIR, POSIX separators.
     *
     * Two shapes qualify, and both are narrower than `admin.view`: a whole page
     * behind a stricter key, and a page that keeps `admin.view` but gates ONE
     * affordance leading somewhere stricter.
     */
    const STRICTER_GUARD_PAGES: Record<string, string> = {
        'external-write-policy/[connectionId]/page.tsx':
            'OWNER-only (admin.tenant_lifecycle) — deciding how far an AGENT may go when driving a write to a customer\'s own third-party system is authority of the same class as tenant deletion and DEK rotation, and it is the same key the identity write policy uses for the directory equivalent; an ADMIN who is not an OWNER would otherwise reach a rendered page and be told the policy "couldn\'t load", which is a permission refusal wearing the costume of a broken backend',
        'ai-features/page.tsx':
            'gates ONE section, not the page (owner decision 2026-10-25, #4139): the four AI switches (admin.tenant_lifecycle, OWNER-only) turn AI on or off for the whole workspace, which for some customers is a contractual undertaking that no model processes their data, and their GET discloses the deploy-level flags; a non-OWNER admin gets a sentence naming the owner instead of a section whose API would 403. The page itself stays admin.view, because its Agent engines section is readable by every admin',
        'modules/page.tsx':
            'OWNER-only (admin.tenant_lifecycle) — turning a product module on or off grants or removes a whole surface for the tenant, which is authority of the same class as tenant deletion; an ADMIN who is not an OWNER would otherwise reach the page and read the API 403 as a broken backend',
        'identity-leaver-passes/page.tsx':
            'OWNER-only (admin.tenant_lifecycle) — the report names which of a customer’s people a leaver pass would have disabled; without the page gate a non-OWNER admin sees the API 403 as a load failure',
        'identity-joiner-passes/page.tsx':
            'OWNER-only (admin.tenant_lifecycle) — the report names which of a customer’s people the product would create an account for and at what address; the layout’s admin.view would let a non-OWNER admin reach it and read the API 403 as a broken backend',
        'identity-write-journal/page.tsx':
            'OWNER-only (admin.tenant_lifecycle) — a row names a change made to one of a customer’s people’s accounts and carries the state it replaced; the layout’s admin.view would let a non-OWNER admin reach the page and read the API 403 as a broken backend',
        'identity-write-policy/page.tsx':
            'OWNER-only (admin.tenant_lifecycle) — the page decides whether this product may disable accounts in the customer’s own directory, which is authority of the same class as tenant deletion; the layout’s admin.view would let a non-OWNER admin reach it and read the API 403 as a broken backend',
        'integrations/page.tsx':
            'gates ONE link (admin.tenant_lifecycle) to the OWNER-only leaver-pass report; the page itself stays admin.view, so an ADMIN is never offered a door that closes on them',
        // #3672 — the page stays admin.view; two CARDS on it carry the keys
        // their routes hold, so neither renders for somebody whose request
        // would be refused (and writes an AUTHZ_DENIED row by visiting).
        'integrations/[connectionId]/page.tsx':
            'gates two cards, not the page: the connection-owner card (admin.manage, the connection-write key its PUT route holds) and the integration passport (admin.tenant_lifecycle, OWNER-only, because it shows the external write rung and the prior-state pairings); the page itself stays admin.view, so an ADMIN who is not an OWNER sees the execution history without being offered a passport that would 403',
        // The agent detail page's entry is GONE because the page is: AGENTIC
        // UI 1/4 moved it to `/agents/[agentId]`, outside this registry's
        // population (`/admin/**`) and outside the `/admin` layout whose
        // duplicate-guard question this file asks. Its own gate did not go
        // with the entry — it moved with the page, and the page now needs it
        // MORE, because there is no ancestor `admin.view` layout above it any
        // more. `tests/integration/agents-subpage-authz.test.ts` is what
        // asserts it, from the other side: each moved page refuses at the PAGE
        // rather than leaning on an ancestor.
        //
        // What remains at `admin/agents/[agentId]/page.tsx` is a
        // `redirect()` one-liner. It reads nothing and renders nothing, so
        // there is no gate for it to carry and nothing for a stricter one to
        // protect.
    };

    function findPageFiles(dir: string): string[] {
        const files: string[] = [];
        if (!fs.existsSync(dir)) return files;

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...findPageFiles(fullPath));
            } else if (entry.name === 'page.tsx') {
                files.push(fullPath);
            }
        }
        return files;
    }

    const rel = (p: string) =>
        path.relative(ADMIN_PAGES_DIR, p).split(path.sep).join('/');

    test('no admin page.tsx files import RequirePermission for admin resource', () => {
        const pages = findPageFiles(ADMIN_PAGES_DIR);
        const violations: string[] = [];

        for (const pagePath of pages) {
            const relPath = rel(pagePath);
            if (relPath in STRICTER_GUARD_PAGES) continue;

            const content = codeOf(fs.readFileSync(pagePath, 'utf-8'));
            // Check for RequirePermission import (not just any mention in comments)
            if (
                content.includes("from '@/components/require-permission'") ||
                content.includes('from "@/components/require-permission"')
            ) {
                violations.push(relPath);
            }
        }

        expect(violations).toEqual([]);
    });

    test('no admin page.tsx files import ServerForbiddenPage', () => {
        const pages = findPageFiles(ADMIN_PAGES_DIR);
        const violations: string[] = [];

        for (const pagePath of pages) {
            const relPath = rel(pagePath);
            // A page carrying a stricter gate needs a fallback to render when
            // that gate refuses; ForbiddenPage IS that fallback, so the same
            // carve-out applies here.
            if (relPath in STRICTER_GUARD_PAGES) continue;

            const content = codeOf(fs.readFileSync(pagePath, 'utf-8'));
            if (
                content.includes("from '@/components/ForbiddenPage'") ||
                content.includes('from "@/components/ForbiddenPage"')
            ) {
                violations.push(relPath);
            }
        }

        expect(violations).toEqual([]);
    });

    test('every allowlisted page exists AND guards something stricter than admin.view', () => {
        // Positive half: the carve-out has to describe a real file that really
        // does carry the guard. Without this an entry outlives its page and
        // silently exempts nothing (or, worse, a future file at that path).
        const entries = Object.keys(STRICTER_GUARD_PAGES);
        expect(entries.length).toBeGreaterThan(0);

        for (const relPath of entries) {
            const full = path.join(ADMIN_PAGES_DIR, relPath);
            expect(fs.existsSync(full)).toBe(true);

            const content = codeOf(fs.readFileSync(full, 'utf-8'));

            // Two idioms express the same thing, and the assertion has to see
            // both. A CLIENT page wraps itself in `RequirePermission`; a SERVER
            // page reads `ctx.appPermissions.admin.<key>` and returns the
            // fallback before it fetches anything. Asserting only the client
            // shape did not make server pages safe, it made them unable to be
            // allowlisted — the first one to need a stricter gate would have
            // had to move its check somewhere the scan cannot see, or drop it.
            //
            // Deliberately NOT relaxed to "mentions a permission somewhere":
            // each branch still has to name a key, and the key still has to be
            // narrower than the layout's own `admin.view`.
            const clientGate =
                content.includes('RequirePermission') && content.includes('resource="admin"');
            // Anchored on the REFUSAL — `if (!ctx.appPermissions.admin.x)` —
            // and not on a mention of the key. A bare
            // /appPermissions\.admin\.(\w+)/ sweep reads the props a page
            // threads DOWN to its client (`canGrantTools:
            // ctx.appPermissions.admin.agent_tool_exposure`) as evidence of a
            // gate, so it passed unchanged when the gate was degraded to
            // `admin.view` and again when it was deleted outright. It was
            // measuring that the file talks about permissions, which every
            // such page does by construction.
            const serverGateKeys = [
                ...content.matchAll(/if\s*\(\s*!\s*ctx\.appPermissions\.admin\.([a-z_]+)\s*\)/g),
            ].map((m) => m[1]);
            const serverGate = serverGateKeys.some((k) => k !== 'view');

            expect(clientGate || serverGate).toBe(true);

            // Negative half, paired with the positives above: the exemption is
            // for a NARROWER gate. Re-declaring the layout's own `admin.view`
            // is the redundancy this describe block exists to refuse — in
            // whichever idiom it is written.
            if (clientGate) expect(content).not.toContain('action="view"');
            if (!clientGate) expect(serverGateKeys).not.toEqual(['view']);
            expect(STRICTER_GUARD_PAGES[relPath].length).toBeGreaterThan(20);
        }
    });
});

/*
 * ═══ THE DATA GUARD ═══
 *
 * EVERY ADMIN SERVER PAGE REFUSES ON THE SERVER, BEFORE IT READS ANYTHING.
 *
 * `src/app/t/[tenantSlug]/(app)/admin/layout.tsx` is a CLIENT component. Its
 * `<RequirePermission resource="admin" action="view">` decides what the browser
 * shows, but it runs after the server-component pages below it have rendered,
 * and their props are already in the RSC payload. The edge lets a denied admin
 * PAGE request through as well. So a server page that read data and leaned on
 * the layout sent that data to every tenant member who opened its URL, under
 * an "Access denied" screen. A layout-level server check would not be enough
 * either, because a layout is not re-rendered on client navigation between its
 * pages.
 *
 * The rule these two blocks hold, over every `page.tsx` under the admin subtree that
 * git knows about:
 *
 *   · a CLIENT page (`'use client'`) reads nothing on the server — its data
 *     comes from API routes, each gated by `requirePermission` — so it is out
 *     of scope;
 *   · a SERVER page either only redirects (`REDIRECT_PAGES`, each verified to
 *     await nothing but its params and call nothing but `redirect`), or its
 *     default export's FIRST two statements are
 *
 *         const gate = await gateAdminPage('<its own route>', params);
 *         if (!gate.allowed) return gate.forbidden;
 *
 *     with `gateAdminPage` imported from `admin/_lib/admin-page-gate`, the
 *     route literal equal to the page's own folder path, and that route present
 *     in `ADMIN_PAGE_REQUIREMENTS`;
 *   · no server page awaits at module scope or exports `generateMetadata` /
 *     `generateViewport`, which Next runs outside the default export.
 *
 * Read with the TypeScript parser, not a regex: what is asserted is the order
 * of statements in one function, which a text search cannot see. The mutation
 * cases at the bottom show the detector refusing each way of breaking it.
 */

const APP_ROOT = 'src/app/t/[tenantSlug]/(app)';
const ADMIN_DIR = `${APP_ROOT}/admin`;
const GATE_MODULE = `${ADMIN_DIR}/_lib/admin-page-gate`;

/**
 * Server pages that only redirect: they read nothing and render nothing, so
 * there is nothing for a gate to protect. Each is checked below to really be a
 * redirect and nothing else.
 */
const REDIRECT_PAGES: Record<string, string> = {
    '/admin/agents':
        'compatibility shim to /agents (AGENTIC UI 1/4); the register page there carries its own gate',
    '/admin/agents/[agentId]':
        'compatibility shim to /agents/:agentId; the detail page there carries its own gate',
    '/admin/agents/review-quality':
        'compatibility shim to /agents/review-quality; that page carries its own gate',
    '/admin/mcp/agent-receipts':
        'compatibility shim to /agents/receipts; that page carries its own gate',
    '/admin/mcp/quarantine':
        'compatibility shim to /agents/quarantine; that page carries its own gate',
};

type Verdict =
    | { kind: 'client' }
    | { kind: 'redirect' }
    | { kind: 'gated'; route: string }
    | { kind: 'violation'; reason: string };

/** `src/app/t/[tenantSlug]/(app)/admin/x/[id]/page.tsx` → `/admin/x/[id]`. */
function routeOf(rel: string): string {
    return rel.slice(APP_ROOT.length, rel.length - '/page.tsx'.length);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => m.kind === kind);
}

/** Every node of `kind` under `root`, not descending into nested functions when `shallow`. */
function collect<T extends ts.Node>(root: ts.Node, test: (n: ts.Node) => n is T, shallow = false): T[] {
    const out: T[] = [];
    const visit = (n: ts.Node): void => {
        if (test(n)) out.push(n);
        if (shallow && n !== root && ts.isFunctionLike(n)) return;
        ts.forEachChild(n, visit);
    };
    visit(root);
    return out;
}

/** `const <id> = await gateAdminPage('<route>', <identifier>);` → the id and route. */
function gateCall(stmt: ts.Statement | undefined): { id: string; route: string } | null {
    if (!stmt || !ts.isVariableStatement(stmt)) return null;
    const decls = stmt.declarationList.declarations;
    if (decls.length !== 1) return null;
    const [decl] = decls;
    if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isAwaitExpression(decl.initializer)) return null;
    const call = decl.initializer.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'gateAdminPage') {
        return null;
    }
    const [route, params] = call.arguments;
    if (call.arguments.length !== 2 || !route || !ts.isStringLiteral(route) || !params || !ts.isIdentifier(params)) {
        return null;
    }
    return { id: decl.name.text, route: route.text };
}

/** `if (!<id>.allowed) return <id>.forbidden;`, with no else. */
function isRefusal(stmt: ts.Statement | undefined, id: string): boolean {
    if (!stmt || !ts.isIfStatement(stmt) || stmt.elseStatement) return false;
    const cond = stmt.expression;
    if (!ts.isPrefixUnaryExpression(cond) || cond.operator !== ts.SyntaxKind.ExclamationToken) return false;
    const tested = cond.operand;
    if (!ts.isPropertyAccessExpression(tested) || !ts.isIdentifier(tested.expression)) return false;
    if (tested.expression.text !== id || tested.name.text !== 'allowed') return false;
    const then = ts.isBlock(stmt.thenStatement) && stmt.thenStatement.statements.length === 1
        ? stmt.thenStatement.statements[0]
        : stmt.thenStatement;
    if (!ts.isReturnStatement(then) || !then.expression) return false;
    const ret = then.expression;
    return (
        ts.isPropertyAccessExpression(ret) &&
        ts.isIdentifier(ret.expression) &&
        ret.expression.text === id &&
        ret.name.text === 'forbidden'
    );
}

/** Whether `gateAdminPage` is imported from the one real gate module. */
function importsRealGate(sf: ts.SourceFile, rel: string): boolean {
    const pageDir = path.posix.dirname(rel);
    return sf.statements.some((s) => {
        if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) return false;
        const spec = s.moduleSpecifier.text;
        const resolved = spec.startsWith('.')
            ? path.posix.normalize(path.posix.join(pageDir, spec))
            : spec.startsWith('@/')
              ? `src/${spec.slice(2)}`
              : spec;
        if (resolved !== GATE_MODULE) return false;
        const named = s.importClause?.namedBindings;
        return (
            !!named &&
            ts.isNamedImports(named) &&
            named.elements.some((e) => e.name.text === 'gateAdminPage' && !e.propertyName)
        );
    });
}

/** The page's verdict. Pure over (source, path) so the mutation cases can call it. */
function classify(source: string, rel: string): Verdict {
    const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const first = sf.statements[0];
    if (
        first &&
        ts.isExpressionStatement(first) &&
        ts.isStringLiteral(first.expression) &&
        first.expression.text === 'use client'
    ) {
        return { kind: 'client' };
    }

    // Module scope: no await outside a function, and no second render entry.
    const topLevelAwaits = collect(sf, ts.isAwaitExpression, true).filter(
        (n) => !ts.findAncestor(n, ts.isFunctionLike),
    );
    if (topLevelAwaits.length > 0) return { kind: 'violation', reason: 'awaits at module scope' };
    for (const s of sf.statements) {
        if (
            ts.isFunctionDeclaration(s) &&
            hasModifier(s, ts.SyntaxKind.ExportKeyword) &&
            s.name &&
            ['generateMetadata', 'generateViewport'].includes(s.name.text)
        ) {
            return { kind: 'violation', reason: `exports ${s.name.text}, which runs outside the gated default export` };
        }
        if (ts.isFunctionDeclaration(s) && s.name?.text === 'gateAdminPage') {
            return { kind: 'violation', reason: 'declares its own gateAdminPage' };
        }
    }

    const page = sf.statements.find(
        (s): s is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(s) &&
            hasModifier(s, ts.SyntaxKind.ExportKeyword) &&
            hasModifier(s, ts.SyntaxKind.DefaultKeyword),
    );
    if (!page?.body) {
        return { kind: 'violation', reason: 'default export is not a function declaration this guard can read' };
    }
    const body = page.body.statements;
    const route = routeOf(rel);

    if (route in REDIRECT_PAGES) {
        const awaits = collect(page.body, ts.isAwaitExpression);
        const calls = collect(page.body, ts.isCallExpression);
        const onlyParams = awaits.every((a) => ts.isIdentifier(a.expression) && a.expression.text === 'params');
        const onlyRedirect =
            calls.length > 0 &&
            calls.every((c) => ts.isIdentifier(c.expression) && c.expression.text === 'redirect');
        return onlyParams && onlyRedirect
            ? { kind: 'redirect' }
            : { kind: 'violation', reason: 'listed as redirect-only but awaits or calls something besides params and redirect' };
    }

    const gate = gateCall(body[0]);
    if (!gate) {
        return { kind: 'violation', reason: "first statement is not `const gate = await gateAdminPage('<route>', params)`" };
    }
    if (!isRefusal(body[1], gate.id)) {
        return { kind: 'violation', reason: `second statement is not \`if (!${gate.id}.allowed) return ${gate.id}.forbidden;\`` };
    }
    if (!importsRealGate(sf, rel)) {
        return { kind: 'violation', reason: `gateAdminPage is not imported from ${GATE_MODULE}` };
    }
    if (gate.route !== route) {
        return { kind: 'violation', reason: `gates under '${gate.route}', not its own route '${route}'` };
    }
    if (!(gate.route in ADMIN_PAGE_REQUIREMENTS)) {
        return { kind: 'violation', reason: `'${gate.route}' has no row in ADMIN_PAGE_REQUIREMENTS` };
    }
    return { kind: 'gated', route: gate.route };
}

// ─── The population ─────────────────────────────────────────────────

const pages = repoFiles({ under: ADMIN_DIR })
    .map(repoRelative)
    .filter((rel) => path.posix.basename(rel) === 'page.tsx')
    .sort();

const verdicts = pages.map((rel) => ({
    rel,
    route: routeOf(rel),
    verdict: classify(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'), rel),
}));

describe('admin server pages gate on the server before they read', () => {
    test('the population is the admin subtree, and it is not empty', () => {
        // Zero pages would make every assertion below vacuously true.
        expect(pages.length).toBeGreaterThan(0);
        expect(pages.every((rel) => rel.startsWith(`${ADMIN_DIR}/`))).toBe(true);
    });

    test('no admin page is in violation', () => {
        const violations = verdicts.flatMap(({ rel, verdict }) =>
            verdict.kind === 'violation' ? [`${rel}: ${verdict.reason}`] : [],
        );
        expect(violations).toEqual([]);
    });

    test('every server page is either gated or a declared redirect', () => {
        const server = verdicts.filter((v) => v.verdict.kind !== 'client');
        expect(server.length).toBeGreaterThan(0);
        const unaccounted = server
            .filter((v) => v.verdict.kind !== 'gated' && v.verdict.kind !== 'redirect')
            .map((v) => v.rel);
        expect(unaccounted).toEqual([]);
    });

    test('ADMIN_PAGE_REQUIREMENTS has exactly one row per gated page', () => {
        const gatedRoutes = verdicts
            .flatMap((v) => (v.verdict.kind === 'gated' ? [v.verdict.route] : []))
            .sort();
        expect(gatedRoutes).toEqual(Object.keys(ADMIN_PAGE_REQUIREMENTS).sort());
    });

    test('every REDIRECT_PAGES entry is a page that exists and only redirects', () => {
        const redirects = verdicts
            .flatMap((v) => (v.verdict.kind === 'redirect' ? [v.route] : []))
            .sort();
        expect(redirects).toEqual(Object.keys(REDIRECT_PAGES).sort());
        for (const reason of Object.values(REDIRECT_PAGES)) {
            expect(reason.length).toBeGreaterThan(20);
        }
    });
});

// ─── The detector refuses each way of breaking the rule ─────────────

describe('the detector is not satisfied by a broken page', () => {
    const PERSONNEL = `${ADMIN_DIR}/personnel/page.tsx`;
    const AGENTS_REDIRECT = `${ADMIN_DIR}/agents/page.tsx`;
    const personnel = fs.readFileSync(path.join(REPO_ROOT, PERSONNEL), 'utf-8');
    const redirectPage = fs.readFileSync(path.join(REPO_ROOT, AGENTS_REDIRECT), 'utf-8');

    const GATE = "    const gate = await gateAdminPage('/admin/personnel', params);\n";
    const REFUSE = '    if (!gate.allowed) return gate.forbidden;\n';
    const READ = '    const rows = (await listEmployees(gate.ctx)) as unknown as EmployeeRow[];\n';

    /** Apply one edit, failing if the anchor is gone, so no mutant is silently the original. */
    function mutate(src: string, from: string, to: string): string {
        expect(src.split(from).length).toBe(2);
        return src.replace(from, to);
    }

    test('the real personnel page passes', () => {
        expect(classify(personnel, PERSONNEL)).toEqual({ kind: 'gated', route: '/admin/personnel' });
    });

    test('a read moved above the gate is refused', () => {
        const mutant = mutate(personnel, GATE + REFUSE + READ, READ + GATE + REFUSE);
        expect(classify(mutant, PERSONNEL).kind).toBe('violation');
    });

    test('a gate whose refusal is never returned is refused', () => {
        const mutant = mutate(personnel, REFUSE, '');
        expect(classify(mutant, PERSONNEL).kind).toBe('violation');
    });

    test('no gate at all is refused', () => {
        const mutant = mutate(personnel, GATE + REFUSE, '');
        expect(classify(mutant, PERSONNEL).kind).toBe('violation');
    });

    test("a gate under another page's route is refused", () => {
        const mutant = mutate(personnel, "gateAdminPage('/admin/personnel'", "gateAdminPage('/admin'");
        expect(classify(mutant, PERSONNEL)).toEqual({
            kind: 'violation',
            reason: "gates under '/admin', not its own route '/admin/personnel'",
        });
    });

    test('a locally declared stand-in for the gate is refused', () => {
        const mutant = mutate(
            personnel,
            "import { gateAdminPage } from '../_lib/admin-page-gate';\n",
            'async function gateAdminPage(..._a: unknown[]) { return { allowed: true } as never; }\n',
        );
        expect(classify(mutant, PERSONNEL).kind).toBe('violation');
    });

    test('a generateMetadata export is refused', () => {
        const mutant = `${personnel}\nexport async function generateMetadata() { return {}; }\n`;
        expect(classify(mutant, PERSONNEL).kind).toBe('violation');
    });

    test('a redirect page that starts reading is refused', () => {
        expect(classify(redirectPage, AGENTS_REDIRECT)).toEqual({ kind: 'redirect' });
        const mutant = mutate(
            redirectPage,
            '    const { tenantSlug } = await params;\n',
            '    const { tenantSlug } = await params;\n    await listEmployees(ctx);\n',
        );
        expect(classify(mutant, AGENTS_REDIRECT).kind).toBe('violation');
    });
});
