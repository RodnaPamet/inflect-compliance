/**
 * Static call-graph analysis over `src/app/api/**\/route.ts`.
 *
 * It answers exactly ONE question per exported HTTP handler:
 *
 *   *does an authorization decision exist ANYWHERE on a path this handler
 *    can reach?*
 *
 * That is a REACHABILITY question, and it is worth being blunt about what
 * reachability is not:
 *
 *   - It is **not ordering**. A handler that deletes rows and *then* calls
 *     a permission check reads as "reached" here. So does a check inside a
 *     callback that runs after the write.
 *   - It is **not sufficiency**. A handler gated on `risks.view` that then
 *     deletes a risk reads as "reached".
 *   - It is **not liveness**. A check behind a feature flag that is
 *     permanently false reads as "reached".
 *
 * The consumer of this module —
 * `tests/guardrails/api-route-has-some-authorization.test.ts` — is named
 * and documented for that weaker claim. The strong per-route claim stays
 * where it already was, in
 * `tests/guardrails/api-permission-coverage.test.ts`.
 *
 * ── WHY A CALL GRAPH AND NOT A REGEX ────────────────────────────────────
 *
 * The repo authorises through two mechanisms and only one is visible in the
 * route file:
 *
 *   (a) route-level `requirePermission('risks.view', …)` — greppable, and
 *       the only mechanism that emits an `AUTHZ_DENIED` audit row (Epic C.1).
 *   (b) a usecase-layer `assertCan*` reached from the handler — invisible
 *       from the route file. `POST /evidence/[id]/purge` is three lines of
 *       glue whose authorisation lives two modules away:
 *
 *           route → purgeEvidence()      (@/app-layer/usecases/evidence)
 *                 → purgeEntity()        (…/soft-delete-operations)
 *                 → assertCanAdmin(ctx)
 *
 * A rule that only grepped the route file would raise hundreds of findings
 * of which almost all are false. So the analyser follows imports.
 *
 * ── WHAT COUNTS AS A DECISION ───────────────────────────────────────────
 *
 * Deliberately NOT "the identifier starts with assertCan" — that would
 * trust a naming convention, and the org surface (`/api/org/**`) writes the
 * same check as a local `assertRead()` or inline in the handler. The
 * analyser looks for the SHAPE:
 *
 *     if (<condition reading a REQUEST CONTEXT's .permissions /
 *          .appPermissions / .role>)
 *         throw …            // or return a 401/403 response
 *
 * plus a call to `requirePermission` / `requireAnyPermission`.
 *
 * **The context restriction is load-bearing.** An earlier draft matched
 * `.role` / `.permissions` on ANY object, so
 * `if (body.role === 'OWNER') throw badRequest(…)` — input validation of a
 * request body — read as an authorization decision. In this tree `.role` is
 * read off `input` (37x), `membership` (41x) and `body` (5x) at least as
 * often as off `ctx` (39x), so that matcher was wrong about as often as it
 * was right. The root identifier of the property chain must now be in
 * {@link CONTEXT_ROOTS}. An unrecognised root is NOT a decision, which is
 * the fail-CLOSED direction: a context named something new costs a triage,
 * it does not silently pass a route.
 *
 * A decision whose condition COMPARES the role (`ctx.role !== 'OWNER'`,
 * `['OWNER','ADMIN'].includes(ctx.role)`) or reads a permission flag
 * (`ctx.permissions.canAdmin`) is `strong`. A decision that only tests
 * PRESENCE (`if (!ctx.role) throw forbidden('Authentication required')`) is
 * reported separately as `ROLE_PRESENCE_ONLY`: it is a real decision point,
 * but its condition is never false for a real authenticated request, so it
 * authenticates without authorising.
 *
 * `getTenantCtx()` is NOT a decision. It authenticates the session and
 * resolves tenant membership — necessary, but it makes no statement about
 * what this caller may DO. Counting it would pass every tenant route and
 * make the analyser vacuous.
 *
 * ── DEPTH LIMIT ─────────────────────────────────────────────────────────
 *
 * `MAX_MODULE_HOPS = 3`. A "hop" is crossing a module boundary via an
 * import; calls to helpers declared in the SAME module are free (they are
 * part of the same body as far as authorisation is concerned). The purge
 * chain above is two hops, so 3 leaves one hop of margin. Chains longer
 * than that are not resolved and the handler is reported as having no
 * decision — fail-closed, which is the intended direction: the fix is to
 * put the check nearer the entry point, not to raise the limit.
 *
 * The analyser is SYNTACTIC (`ts.createSourceFile`, no type checker). It
 * resolves `@/…` and relative specifiers only; anything from node_modules
 * is a dead end.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/** A hop is one import edge. See the header for why the ceiling is 3. */
export const MAX_MODULE_HOPS = 3;

export const HTTP_METHODS = [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS',
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Identifiers that may root a property chain read as an identity fact.
 *
 * Measured against the tree (2026-08-22): `ctx` is the overwhelming
 * convention, with three long-tail aliases. Everything else that reads
 * `.role` in `src/` — `input`, `membership`, `body`, `invite`, `token`,
 * `user`, … — is request input or a database row, never the caller's own
 * authority.
 *
 * Exported so the guardrail can assert the list still covers the tree.
 */
export const CONTEXT_ROOTS: ReadonlySet<string> = new Set([
    'ctx',
    'orgCtx',
    'tenantCtx',
    'serverCtx',
    'requestContext',
]);

export type Tier =
    /** Route-level `requirePermission(...)` — denials write AUTHZ_DENIED. */
    | 'ROUTE_PERMISSION'
    /** A permission decision reached through the call graph. */
    | 'USECASE_ASSERT'
    /** Only a `if (!ctx.role) throw …` presence check was found. */
    | 'ROLE_PRESENCE_ONLY'
    /** No permission decision reachable on any path. */
    | 'NONE';

export interface HandlerVerdict {
    method: HttpMethod;
    tier: Tier;
    /** Where the decision was found (`purgeEvidence/purgeEntity @…`). */
    via: string | null;
}

const HTTP_METHOD_SET: ReadonlySet<string> = new Set<string>(HTTP_METHODS);
const GATE_CALLS: ReadonlySet<string> = new Set([
    'requirePermission',
    'requireAnyPermission',
]);
const PERMISSION_BAGS: ReadonlySet<string> = new Set([
    'permissions',
    'appPermissions',
]);
const DISCRIMINATING_CALLS: ReadonlySet<string> = new Set([
    'includes',
    'has',
    'indexOf',
    'some',
    'every',
]);
const COMPARISON_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.InKeyword,
]);
/** `return NextResponse.json({…}, { status: 403 })` denies without throwing. */
const DENYING_STATUS = /status:\s*(401|403)/;

interface ImportBinding {
    spec: string;
    imported: string;
}

interface ModuleInfo {
    file: string;
    /** Top-level declarations by name (function / const). */
    decls: Map<string, ts.Node[]>;
    /** Local binding name → the module + symbol it came from. */
    imports: Map<string, ImportBinding>;
    /** `import * as ns from '…'` → local name → specifier. */
    namespaces: Map<string, string>;
    /** `export { a as b } from '…'`. */
    reexports: Map<string, ImportBinding>;
    /** `export * from '…'`. */
    starReexports: string[];
    /** `export { local as Public }` in the same module. */
    exportAliases: Map<string, string>;
}

interface ResolvedDecl {
    info: ModuleInfo;
    nodes: ts.Node[];
}

type Decision = 'strong' | 'presence' | null;

export interface Analyzer {
    /** Classify each exported HTTP handler of one route file. */
    classify(routeFile: string): HandlerVerdict[];
    /**
     * Re-classify with an in-memory source override. Used by the mutation
     * regression proof: strip a gate from a route's SOURCE TEXT and assert
     * the detector notices, without touching the file on disk.
     */
    classifyWithSource(routeFile: string, source: string): HandlerVerdict[];
}

export function createAnalyzer(repoRoot: string): Analyzer {
    const srcRoot = path.join(repoRoot, 'src');
    const moduleCache = new Map<string, ModuleInfo>();
    const resolveCache = new Map<string, string | null>();

    // ── module loading ───────────────────────────────────────────────

    function resolveSpec(spec: string, fromFile: string): string | null {
        const key = `${fromFile}::${spec}`;
        const cached = resolveCache.get(key);
        if (cached !== undefined) return cached;

        let base: string;
        if (spec.startsWith('@/')) base = path.join(srcRoot, spec.slice(2));
        else if (spec.startsWith('./') || spec.startsWith('../'))
            base = path.resolve(path.dirname(fromFile), spec);
        else {
            resolveCache.set(key, null);
            return null;
        }

        let found: string | null = null;
        for (const cand of [
            `${base}.ts`,
            `${base}.tsx`,
            path.join(base, 'index.ts'),
            path.join(base, 'index.tsx'),
        ]) {
            if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
                found = cand;
                break;
            }
        }
        resolveCache.set(key, found);
        return found;
    }

    function parseModule(file: string, source: string): ModuleInfo {
        const sf = ts.createSourceFile(
            file,
            source,
            ts.ScriptTarget.Latest,
            /* setParentNodes */ true,
            ts.ScriptKind.TSX,
        );
        const info: ModuleInfo = {
            file,
            decls: new Map(),
            imports: new Map(),
            namespaces: new Map(),
            reexports: new Map(),
            starReexports: [],
            exportAliases: new Map(),
        };
        const addDecl = (name: string, node: ts.Node): void => {
            const bucket = info.decls.get(name);
            if (bucket) bucket.push(node);
            else info.decls.set(name, [node]);
        };

        for (const st of sf.statements) {
            if (
                ts.isImportDeclaration(st) &&
                ts.isStringLiteral(st.moduleSpecifier)
            ) {
                const spec = st.moduleSpecifier.text;
                const clause = st.importClause;
                if (!clause) continue;
                if (clause.name)
                    info.imports.set(clause.name.text, { spec, imported: 'default' });
                const bindings = clause.namedBindings;
                if (bindings && ts.isNamespaceImport(bindings)) {
                    info.namespaces.set(bindings.name.text, spec);
                } else if (bindings && ts.isNamedImports(bindings)) {
                    for (const el of bindings.elements) {
                        info.imports.set(el.name.text, {
                            spec,
                            imported: el.propertyName
                                ? el.propertyName.text
                                : el.name.text,
                        });
                    }
                }
                continue;
            }

            if (ts.isExportDeclaration(st)) {
                const spec =
                    st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
                        ? st.moduleSpecifier.text
                        : null;
                const clause = st.exportClause;
                if (!clause) {
                    if (spec) info.starReexports.push(spec);
                    continue;
                }
                if (ts.isNamedExports(clause)) {
                    for (const el of clause.elements) {
                        const imported = el.propertyName
                            ? el.propertyName.text
                            : el.name.text;
                        if (spec) info.reexports.set(el.name.text, { spec, imported });
                        else info.exportAliases.set(el.name.text, imported);
                    }
                }
                continue;
            }

            if (ts.isFunctionDeclaration(st) && st.name) {
                addDecl(st.name.text, st);
                continue;
            }
            if (ts.isVariableStatement(st)) {
                for (const d of st.declarationList.declarations) {
                    if (ts.isIdentifier(d.name)) addDecl(d.name.text, d);
                }
            }
        }
        return info;
    }

    function loadModule(file: string): ModuleInfo {
        const cached = moduleCache.get(file);
        if (cached) return cached;
        const info = parseModule(file, fs.readFileSync(file, 'utf8'));
        moduleCache.set(file, info);
        return info;
    }

    // ── the decision detector ────────────────────────────────────────

    function calleeName(expr: ts.Expression): string | null {
        if (ts.isIdentifier(expr)) return expr.text;
        if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
        return null;
    }

    /**
     * The identifier at the base of a property chain: `a.b.c` → `a`,
     * `a!.b` → `a`, `f().b` → null (unresolvable, so fail closed).
     */
    function chainRoot(expr: ts.Expression): string | null {
        let cur: ts.Expression = expr;
        for (;;) {
            if (ts.isIdentifier(cur)) return cur.text;
            if (ts.isPropertyAccessExpression(cur)) {
                cur = cur.expression;
                continue;
            }
            if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
                cur = cur.expression;
                continue;
            }
            return null;
        }
    }

    /**
     * `ctx.permissions…` / `ctx.appPermissions…` / `ctx.role` in the
     * subtree — and ONLY when rooted at a request context. See the header:
     * matching any object made `body.role === 'OWNER'` look like authz.
     */
    function identityRefs(node: ts.Node): Array<'bag' | 'role'> {
        const refs: Array<'bag' | 'role'> = [];
        const visit = (n: ts.Node): void => {
            if (ts.isPropertyAccessExpression(n)) {
                const isBag = PERMISSION_BAGS.has(n.name.text);
                const isRole = n.name.text === 'role';
                if (isBag || isRole) {
                    const root = chainRoot(n.expression);
                    if (root !== null && CONTEXT_ROOTS.has(root)) {
                        refs.push(isBag ? 'bag' : 'role');
                        return;
                    }
                }
            }
            ts.forEachChild(n, visit);
        };
        visit(node);
        return refs;
    }

    /** Does the condition COMPARE, or does it only test presence? */
    function conditionDiscriminates(cond: ts.Node): boolean {
        let found = false;
        const visit = (n: ts.Node): void => {
            if (found) return;
            if (
                ts.isBinaryExpression(n) &&
                COMPARISON_TOKENS.has(n.operatorToken.kind)
            ) {
                found = true;
                return;
            }
            if (ts.isCallExpression(n)) {
                const nm = calleeName(n.expression);
                if (nm && DISCRIMINATING_CALLS.has(nm)) {
                    found = true;
                    return;
                }
            }
            if (ts.isElementAccessExpression(n)) {
                found = true;
                return;
            }
            ts.forEachChild(n, visit);
        };
        visit(cond);
        return found;
    }

    /** A branch that throws, or returns a 401/403 response. */
    function branchDenies(node: ts.Node): boolean {
        let found = false;
        const visit = (n: ts.Node): void => {
            if (found) return;
            if (ts.isThrowStatement(n)) {
                found = true;
                return;
            }
            ts.forEachChild(n, visit);
        };
        visit(node);
        return found || DENYING_STATUS.test(node.getText());
    }

    function bodyDecision(node: ts.Node): Decision {
        let best: Decision = null;
        const visit = (n: ts.Node): void => {
            if (best === 'strong') return;
            if (ts.isIfStatement(n)) {
                const refs = identityRefs(n.expression);
                const denies =
                    branchDenies(n.thenStatement) ||
                    (n.elseStatement !== undefined && branchDenies(n.elseStatement));
                if (refs.length > 0 && denies) {
                    if (refs.includes('bag') || conditionDiscriminates(n.expression))
                        best = 'strong';
                    else if (best === null) best = 'presence';
                }
            }
            ts.forEachChild(n, visit);
        };
        visit(node);
        return best;
    }

    function hasGateCall(node: ts.Node): boolean {
        let found = false;
        const visit = (n: ts.Node): void => {
            if (found) return;
            if (ts.isCallExpression(n)) {
                const nm = calleeName(n.expression);
                if (nm && GATE_CALLS.has(nm)) {
                    found = true;
                    return;
                }
            }
            ts.forEachChild(n, visit);
        };
        visit(node);
        return found;
    }

    // ── call-graph traversal ─────────────────────────────────────────

    interface CallRefs {
        /** Plain identifiers used as a callee or passed to a call. */
        names: Set<string>;
        /** `[moduleSpecifier, exportedName]` reached through `import * as ns`. */
        nsRefs: Array<[string, string]>;
    }

    function collectCallRefs(node: ts.Node, info: ModuleInfo): CallRefs {
        const names = new Set<string>();
        const nsRefs: Array<[string, string]> = [];

        const noteNamespace = (obj: ts.Identifier, prop: ts.MemberName): boolean => {
            const spec = info.namespaces.get(obj.text);
            if (spec === undefined) return false;
            nsRefs.push([spec, prop.text]);
            return true;
        };

        const visit = (n: ts.Node): void => {
            if (ts.isCallExpression(n)) {
                const e = n.expression;
                if (ts.isIdentifier(e)) names.add(e.text);
                else if (ts.isPropertyAccessExpression(e)) {
                    if (
                        !(
                            ts.isIdentifier(e.expression) &&
                            noteNamespace(e.expression, e.name)
                        )
                    ) {
                        names.add(e.name.text);
                    }
                }
                // `withValidatedBody(Schema, handlerDefinedElsewhere)`
                for (const a of n.arguments) {
                    if (ts.isIdentifier(a)) names.add(a.text);
                    else if (
                        ts.isPropertyAccessExpression(a) &&
                        ts.isIdentifier(a.expression)
                    ) {
                        noteNamespace(a.expression, a.name);
                    }
                }
            }
            ts.forEachChild(n, visit);
        };
        visit(node);

        // `export const PATCH = PUT;` — an alias, not a call.
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            ts.isIdentifier(node.initializer)
        ) {
            names.add(node.initializer.text);
        }
        return { names, nsRefs };
    }

    /**
     * Resolve an exported/declared symbol to its declaration node(s),
     * following re-export chains. Re-exports do not consume a hop —
     * a barrel is not a call.
     */
    function resolveDecl(
        file: string,
        name: string,
        budget: number,
    ): ResolvedDecl | null {
        if (budget < 0) return null;
        const info = loadModule(file);

        const re = info.reexports.get(name);
        if (re) {
            const target = resolveSpec(re.spec, file);
            return target ? resolveDecl(target, re.imported, budget - 1) : null;
        }
        const alias = info.exportAliases.get(name);
        const nodes =
            info.decls.get(name) ?? (alias ? info.decls.get(alias) : undefined);
        if (nodes) return { info, nodes };

        const imp = info.imports.get(alias ?? name);
        if (imp) {
            const target = resolveSpec(imp.spec, file);
            return target ? resolveDecl(target, imp.imported, budget - 1) : null;
        }
        for (const spec of info.starReexports) {
            const target = resolveSpec(spec, file);
            const r = target ? resolveDecl(target, name, budget - 1) : null;
            if (r) return r;
        }
        return null;
    }

    /** Budget for following re-export/barrel chains (no calls involved). */
    const REEXPORT_BUDGET = 4;

    function reachedDecision(
        rootInfo: ModuleInfo,
        rootNodes: ts.Node[],
        label: string,
    ): { decision: Decision; via: string | null } {
        const seen = new Set<string>();
        // A holder rather than two `let`s: TypeScript narrows a captured
        // `let` from its initialiser and then reports every later
        // `best === 'strong'` as an impossible comparison, because it cannot
        // see that the mutually-recursive walkers assign it.
        const found: { best: Decision; via: string | null } = { best: null, via: null };
        // Read through a function, not inline: after the `presence` branch
        // below assigns, TypeScript narrows `found.best` for the rest of that
        // body and calls every later `=== 'strong'` impossible — it cannot see
        // the mutually-recursive walkers reassigning it.
        const isStrong = (): boolean => found.best === 'strong';

        const walkSymbol = (
            file: string,
            symbol: string,
            hops: number,
            trail: string,
        ): void => {
            const key = `${file}::${symbol}::${hops}`;
            if (seen.has(key)) return;
            seen.add(key);
            const r = resolveDecl(file, symbol, REEXPORT_BUDGET);
            if (!r) return;
            for (const node of r.nodes) {
                walkBody(r.info, node, hops, trail);
                if (isStrong()) return;
            }
        };

        const walkBody = (
            info: ModuleInfo,
            node: ts.Node,
            hops: number,
            trail: string,
        ): void => {
            if (isStrong()) return;

            if (hasGateCall(node)) {
                found.best = 'strong';
                found.via = `${trail} → requirePermission`;
                return;
            }
            const decision = bodyDecision(node);
            if (decision === 'strong') {
                found.best = 'strong';
                found.via = `${trail} @${path.relative(repoRoot, info.file)}`;
                return;
            }
            if (decision === 'presence' && found.best === null) {
                found.best = 'presence';
                found.via = `${trail} @${path.relative(repoRoot, info.file)} (presence-only)`;
            }

            const { names, nsRefs } = collectCallRefs(node, info);

            // Same-module helpers are free — they are part of this body.
            for (const name of names) {
                const local = info.decls.get(name);
                if (!local) continue;
                for (const decl of local) {
                    if (decl === node) continue;
                    const key = `${info.file}::local:${name}::${hops}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    walkBody(info, decl, hops, `${trail}/${name}`);
                    if (isStrong()) return;
                }
            }

            if (hops <= 0) return;
            for (const name of names) {
                const imp = info.imports.get(name);
                if (!imp) continue;
                const target = resolveSpec(imp.spec, info.file);
                if (!target) continue;
                walkSymbol(target, imp.imported, hops - 1, `${trail}/${name}`);
                if (isStrong()) return;
            }
            for (const [spec, prop] of nsRefs) {
                const target = resolveSpec(spec, info.file);
                if (!target) continue;
                walkSymbol(target, prop, hops - 1, `${trail}/${prop}`);
                if (isStrong()) return;
            }
        };

        for (const node of rootNodes) {
            walkBody(rootInfo, node, MAX_MODULE_HOPS, label);
            if (isStrong()) break;
        }
        return { decision: found.best, via: found.via };
    }

    // ── handler discovery ────────────────────────────────────────────

    function isExported(node: ts.Node): boolean {
        const stmt = ts.isVariableDeclaration(node) ? node.parent.parent : node;
        const modifiers = ts.canHaveModifiers(stmt)
            ? ts.getModifiers(stmt)
            : undefined;
        return (modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    }

    function handlersOf(info: ModuleInfo): HttpMethod[] {
        const out = new Set<string>();
        for (const [name, nodes] of info.decls) {
            if (HTTP_METHOD_SET.has(name) && nodes.some(isExported)) out.add(name);
        }
        for (const name of info.exportAliases.keys())
            if (HTTP_METHOD_SET.has(name)) out.add(name);
        for (const name of info.reexports.keys())
            if (HTTP_METHOD_SET.has(name)) out.add(name);
        return HTTP_METHODS.filter((m) => out.has(m));
    }

    function classifyInfo(info: ModuleInfo): HandlerVerdict[] {
        return handlersOf(info).map((method): HandlerVerdict => {
            const decl = resolveDecl(info.file, method, REEXPORT_BUDGET);
            if (decl && decl.nodes.some((n) => hasGateCall(n))) {
                return { method, tier: 'ROUTE_PERMISSION', via: 'requirePermission' };
            }
            const nodes = decl ? decl.nodes : [];
            const { decision, via } = reachedDecision(
                decl ? decl.info : info,
                nodes,
                method,
            );
            const tier: Tier =
                decision === 'strong'
                    ? 'USECASE_ASSERT'
                    : decision === 'presence'
                      ? 'ROLE_PRESENCE_ONLY'
                      : 'NONE';
            return { method, tier, via };
        });
    }

    return {
        classify(routeFile: string): HandlerVerdict[] {
            return classifyInfo(loadModule(routeFile));
        },

        classifyWithSource(routeFile: string, source: string): HandlerVerdict[] {
            const previous = moduleCache.get(routeFile);
            moduleCache.set(routeFile, parseModule(routeFile, source));
            try {
                return classifyInfo(loadModule(routeFile));
            } finally {
                if (previous) moduleCache.set(routeFile, previous);
                else moduleCache.delete(routeFile);
            }
        },
    };
}
