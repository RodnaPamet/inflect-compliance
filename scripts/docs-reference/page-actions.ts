/**
 * The API calls each page makes — the "what you can do" half of a page guide,
 * read from code so a guide can be checked against it.
 *
 * A page's REACH is its `page.tsx` plus every file it imports, transitively,
 * that belongs to the product rather than the platform: anything under
 * `src/app/` (except the API itself) and `src/components/` (except the shared
 * primitives in `ui/`, `layout/` and `icons/`, which every page reaches and
 * which call nothing page-specific). `src/lib/` is not followed.
 *
 * A CALL is `fetch`, one of the api-client helpers, or a `useTenantSWR` read.
 * Its URL is resolved from the expression that builds it: literals, template
 * strings (a `${…}` becomes a run-time segment), `apiUrl(…)` and
 * `buildApiUrl(…)` (the tenant prefix), string concatenation, a conditional's
 * two branches, and a `const` an enclosing scope declares before the call. A
 * PARAMETER is not resolved — its value is whatever the caller passed, and this
 * reads one file at a time. Anything else is UNRESOLVED,
 * and is listed with its file and line rather than dropped: a scanner that
 * silently skips what it cannot read reports full coverage of the part it
 * understands.
 */
import * as path from 'node:path';
import ts from 'typescript';
import { type ApiRoute, type CallSegment, type HttpMethod, HTTP_METHODS, matchRoutes } from './api-routes';
import { enclosingConst, enclosingParam, lineOf, literalText, routeSegments, topLevelConst, walk } from './source';

/** Product code a page's reach may include; platform code it may not. */
export function inReach(file: string): boolean {
    if (file.startsWith('src/app/api/')) return false;
    if (file.startsWith('src/app/')) return true;
    if (file.startsWith('src/components/')) {
        return !/^src\/components\/(ui|layout|icons)\//.test(file);
    }
    return false;
}

const EXTENSIONS = ['.tsx', '.ts', '/index.tsx', '/index.ts'];

/** The repo file an import specifier names, or null for a package or a file outside the repo. */
export function resolveImport(from: string, spec: string, exists: (f: string) => boolean): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
    else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    else return null;
    if (exists(base) && /\.(tsx?|jsx?)$/.test(base)) return base;
    for (const ext of EXTENSIONS) if (exists(base + ext)) return base + ext;
    return null;
}

function importSpecifiers(sf: ts.SourceFile): string[] {
    const specs: string[] = [];
    walk(sf, (n) => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
            const t = literalText(n.moduleSpecifier);
            // A type-only import brings no code with it.
            const typeOnly = ts.isImportDeclaration(n) ? n.importClause?.isTypeOnly : n.isTypeOnly;
            if (t && !typeOnly) specs.push(t);
        } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const t = literalText(n.arguments[0]);
            if (t) specs.push(t);
        }
    });
    return specs;
}

export interface Source {
    exists: (file: string) => boolean;
    parsed: (file: string) => ts.SourceFile;
}

/** Every file in a page's reach, the page first. */
export function pageReach(page: string, src: Source): string[] {
    const seen = new Set<string>([page]);
    const queue = [page];
    while (queue.length) {
        const file = queue.shift()!;
        for (const spec of importSpecifiers(src.parsed(file))) {
            const target = resolveImport(file, spec, src.exists);
            if (target && inReach(target) && !seen.has(target)) {
                seen.add(target);
                queue.push(target);
            }
        }
    }
    return [...seen];
}

export interface ApiCall {
    file: string;
    line: number;
    /** Every method the call can use; empty when it cannot be read. */
    methods: HttpMethod[];
    /** The resolved path, or null when the expression could not be read. */
    segments: CallSegment[] | null;
    /** The source text of the URL argument, for an unresolved call. */
    expression: string;
}

/** Callee → [index of the URL argument, how the method is found]. */
const CALLEES: Record<string, { tenantRelative: boolean; method: HttpMethod | 'init' | 'arg1' }> = {
    fetch: { tenantRelative: false, method: 'init' },
    apiGet: { tenantRelative: false, method: 'GET' },
    apiPost: { tenantRelative: false, method: 'POST' },
    apiPatch: { tenantRelative: false, method: 'PATCH' },
    apiDelete: { tenantRelative: false, method: 'DELETE' },
    postJson: { tenantRelative: false, method: 'POST' },
    apiFetch: { tenantRelative: false, method: 'arg1' },
    useTenantSWR: { tenantRelative: true, method: 'GET' },
    useSWR: { tenantRelative: false, method: 'GET' },
};

/**
 * `useSWR(key, async (url) => (await fetch(url)).json())` — the fetcher's
 * `fetch(url)` is the same call as the key, already counted from the key.
 */
function isSwrFetcherParam(arg: ts.Expression): boolean {
    if (!ts.isIdentifier(arg)) return false;
    for (let n: ts.Node | undefined = arg.parent; n; n = n.parent) {
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
            const isParam = n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === arg.text);
            const call = n.parent;
            return (
                isParam &&
                ts.isCallExpression(call) &&
                ts.isIdentifier(call.expression) &&
                /^useSWR/.test(call.expression.text) &&
                call.arguments[1] === n
            );
        }
    }
    return false;
}

/**
 * The component whose PROPS destructure `name`, if `at` sits inside one, and
 * the attribute that supplies it — `{ apiBase: base }` is read as `base`
 * locally and `apiBase` in JSX.
 *
 * A prop is the one name a use site legitimately cannot resolve on its own:
 * its value is written at the render site. In this codebase a panel computes
 * `const apiBase` and hands it to sibling components in the same file under
 * the same name, so refusing the name outright costs the reference a dozen
 * calls it can read — and resolving it from a same-named `const` elsewhere in
 * the file, as the old resolver did, is a guess that happened to be right.
 * Reading the render site is neither.
 */
function destructuredProp(name: string, at: ts.Node): { component: string; attribute: string } | null {
    for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
        if (!ts.isFunctionLike(n)) continue;
        let attribute: string | null = null;
        for (const p of n.parameters) {
            if (!ts.isObjectBindingPattern(p.name)) continue;
            const el = p.name.elements.find((x) => ts.isIdentifier(x.name) && x.name.text === name);
            if (el) attribute = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : name;
        }
        if (!attribute) continue;
        // Only a NAMED component can be found again in JSX.
        if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) return { component: n.name.text, attribute };
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
            const d = n.parent;
            return ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) ? { component: d.name.text, attribute } : null;
        }
        return null;
    }
    return null;
}

/**
 * Every expression a render site in THIS file passes for one attribute of one
 * component. Fail-closed: a render that spreads its props, or omits the
 * attribute, or a component this file never renders, means at least one value
 * is unknown — and a union missing one of its members is not a union, so the
 * call is reported rather than answered from the rest.
 */
/**
 * Every render site of `component` in ONE file, and what it passes for one
 * attribute. `unknown` when a site omits it or spreads instead.
 */
function renderSitesIn(
    sf: ts.SourceFile,
    component: string,
    attribute: string,
): { values: ts.Expression[]; unknown: boolean } {
    const values: ts.Expression[] = [];
    let unknown = false;
    walk(sf, (n) => {
        if (!ts.isJsxSelfClosingElement(n) && !ts.isJsxOpeningElement(n)) return;
        if (!ts.isIdentifier(n.tagName) || n.tagName.text !== component) return;
        const attr = n.attributes.properties.find((a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === attribute);
        const init = attr && ts.isJsxAttribute(attr) ? attr.initializer : undefined;
        if (!init || !ts.isJsxExpression(init) || !init.expression) {
            unknown = true;
            return;
        }
        values.push(init.expression);
    });
    return { values, unknown };
}

/**
 * Does `sf` import `name` from `fromFile`?
 *
 * The guard that makes a cross-file search sound. Two files can each declare a
 * component called `Child`, and searching the reach for `<Child …>` by name
 * alone would read one component's render site as another's — a wrong answer
 * dressed as a resolution, which is the whole class #5661 was about. A render
 * site counts only where the name is bound to the component that declared the
 * prop.
 */
function importsFrom(sf: ts.SourceFile, name: string, fromFile: string, exists: (f: string) => boolean): boolean {
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings) continue;
        const nb = st.importClause.namedBindings;
        if (!ts.isNamedImports(nb)) continue;
        if (!nb.elements.some((el) => el.name.text === name)) continue;
        const spec = literalText(st.moduleSpecifier);
        const target = spec ? resolveImport(sf.fileName, spec, exists) : null;
        if (target === fromFile) return true;
    }
    return false;
}

/**
 * The URL prefix each context hook BUILDS, read off the hook rather than off
 * the name a caller happens to give it (#5662).
 *
 * This was a set of three names — `apiUrl`, `buildApiUrl`, `tenantApiUrl` —
 * every one of which got the tenant prefix. It was right 147 times and wrong
 * three: `const apiUrl = useOrgApiUrl()` builds `/api/org/<slug>`, so the two
 * org-settings calls were published as "no API route matches this path" about
 * routes that are there and serving, and a local `apiUrl(tenantSlug, path)`
 * helper had its FIRST argument read as the path.
 *
 * Keying on the hook is also wider than the list it replaces: any local name
 * bound to one of these resolves, with nothing to add here. The values are the
 * prefixes the hooks themselves write (`src/lib/tenant-context-provider.tsx`,
 * `src/lib/org-context-provider.tsx`), with `\u0000` for the slug.
 */
/**
 * A `function <name>(…)` declaration visible from `at`. A declaration is not a
 * `const`, so the scope resolver never sees one — and `OnboardingWizard.tsx`
 * declares `function apiUrl(tenantSlug, path)`, whose FIRST argument is the
 * workspace slug. Finding it is what lets its calls be refused instead of
 * falling through to the legacy name test that produced the wrong path.
 */
function functionDeclarationNamed(name: string, at: ts.Node): ts.FunctionDeclaration | null {
    for (let n: ts.Node | undefined = at; n; n = n.parent) {
        if (!ts.isBlock(n) && !ts.isSourceFile(n)) continue;
        for (const st of n.statements) {
            if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
        }
    }
    return null;
}

/**
 * The function a builder binding holds, unwrapping the `useCallback` /
 * `useMemo` a React builder is almost always declared inside:
 * `const apiUrl = useCallback((path) => `/api/t/${slug}${path}`, [slug])`.
 *
 * 17 of the repo's local builders are declared that way against 10 bare
 * arrows, so treating the wrapper as "not a builder" lost 42 route rows —
 * measured, which is the only reason this arm exists.
 */
function builderFunction(e: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | null {
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && /^use(Memo|Callback)$/.test(e.expression.text)) {
        const inner = e.arguments[0];
        if (inner && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner))) {
            // useMemo returns the VALUE its factory returns; useCallback returns
            // the callback itself. Only the latter is the builder.
            return e.expression.text === 'useCallback' ? inner : builderFunction(inner.body as ts.Expression);
        }
    }
    return null;
}

/** The one expression a block body returns, or null if it does not return exactly one. */
function soleReturn(body: ts.Block): ts.Expression | null {
    const returns: ts.Expression[] = [];
    walk(body, (n) => {
        if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
    });
    return returns.length === 1 ? returns[0] : null;
}

/**
 * The names this scan used to treat as tenant URL builders unconditionally.
 *
 * They are kept as a LAST RESORT, below every binding test, because removing
 * them outright was measured at 14 route rows lost — builders reach a call
 * site through more shapes than a file-local resolver can read (a prop from
 * another file, a hook of a hook). The binding tests above still DISQUALIFY:
 * a callee bound to `useOrgApiUrl`, or to a function of the wrong arity, never
 * reaches this line, which is what #5662 is about. `nameFallbacks` counts how
 * often it fires so the residual is a number somebody can watch shrink rather
 * than a silent assumption.
 */
const LEGACY_BUILDER_NAMES = new Set(['apiUrl', 'buildApiUrl', 'tenantApiUrl']);

const URL_BUILDER_HOOKS: Record<string, string> = {
    useTenantApiUrl: '/api/t/\u0000',
    useOrgApiUrl: '/api/org/\u0000',
};

/**
 * A trailing `${query}` on a path is its query string, not a path segment:
 * `/admin/integrations/identity-accounts${query}`. Recognised by name, and
 * only at the very end of a template, because `foo-${id}` is a real segment.
 */
const QUERY_SUFFIX = /(query|qs|params|search|filter)/i;

/** The SWR key helpers (`CACHE_KEYS.risks.list()`), read once from src/lib/swr-keys.ts. */
const SWR_KEYS_FILE = 'src/lib/swr-keys.ts';

interface KeyEntry {
    sf: ts.SourceFile;
    expr: ts.Expression;
}

/**
 * Resolves the expression that builds a URL into the paths it can take,
 * following `const`s an ENCLOSING scope declares before the use site, `const`s
 * a file imports by name, and the `CACHE_KEYS` table. Each path is text with `\u0000` standing for a value
 * only known at run time; null means the expression could not be read.
 */
export class UrlResolver {
    private swrKeys: Map<string, KeyEntry> | null = null;

    /**
     * Parameters bound to a call's arguments while a local builder's BODY is
     * being read — `apiUrl('/assets/bulk')` against
     * `const apiUrl = (path) => `/api/t/${tenantSlug}${path}``. A frame is
     * pushed for the body and popped after, so the binding reaches only that
     * body; every other name in it still resolves in its own scope, which is
     * how `tenantSlug` stays a run-time value while `path` becomes the literal.
     */
    private bound: { name: string; expr: ts.Expression; sf: ts.SourceFile }[] = [];

    /** How many calls took the legacy NAME test because no binding could be read. */
    nameFallbacks = 0;

    /**
     * The files of the page being read, set by `pageActions` for the duration
     * of one page — the scope within which a prop's render site is looked for
     * (#5688). Empty when the resolver is driven directly, which keeps the
     * same-file behaviour #5661 shipped.
     */
    private reach: readonly string[] = [];

    /** Run `body` with the page's reach visible to prop resolution. */
    withReach<T>(files: readonly string[], body: () => T): T {
        const before = this.reach;
        this.reach = files;
        try {
            return body();
        } finally {
            this.reach = before;
        }
    }

    /**
     * Every expression that passes `attribute` to `component`, anywhere in the
     * page's reach, each with the file it was written in so it resolves in its
     * OWN scope.
     *
     * #5661 read render sites in the declaring file only, which left a builder
     * handed down from a parent in another file unresolvable — 19 calls fell
     * back to the callee's NAME because of it (#5688, #5662's residual).
     *
     * Fail-closed is unchanged and now spans files: one render site that
     * spreads its props, or omits the attribute, makes the value unknown. A
     * union missing a member is not a union, and the page's reach is the only
     * population this can see — a component rendered from outside it resolves
     * to nothing rather than to the sites that happen to be inside.
     */
    private propValues(sf: ts.SourceFile, component: string, attribute: string): { expr: ts.Expression; sf: ts.SourceFile }[] | null {
        const out: { expr: ts.Expression; sf: ts.SourceFile }[] = [];
        let unknown = false;

        const take = (f: ts.SourceFile) => {
            const found = renderSitesIn(f, component, attribute);
            if (found.unknown) unknown = true;
            for (const expr of found.values) out.push({ expr, sf: f });
        };

        take(sf);
        for (const file of this.reach) {
            if (file === sf.fileName) continue;
            const other = this.src.parsed(file);
            if (!importsFrom(other, component, sf.fileName, this.src.exists)) continue;
            take(other);
        }

        return unknown || out.length === 0 ? null : out;
    }

    constructor(private readonly src: Source) {}

    /**
     * The initialiser a name refers to AT THIS USE SITE: a `const` an
     * enclosing scope declares before it, or one the file imports by name. A
     * PARAMETER resolves to nothing — its value is the caller's, which this
     * resolver does not follow — so the call is reported UNRESOLVED.
     *
     * It used to read a flat map of EVERY `const` in the file by name, built by
     * walking the whole tree, and take the last one positionally before the use
     * site in any scope — falling back, via `?? local[0]`, to a declaration
     * AFTER it. So in `AccessReviewDetailClient.tsx` the `url` parameter of
     * `postJson` (line 292) resolved to the file's only `const url`, at line
     * 1114 inside an unrelated callback, and the fetch on line 293 was
     * attributed to that route. The page guide then said the page called an
     * endpoint it does not call, and the one it does call went uncounted — a
     * resolver that answers from a declaration the use site cannot see does not
     * report less, it reports something else.
     *
     * `enclosingParam` / `enclosingConst` are `source.ts`'s, and `refusals.ts`
     * resolves identifiers through the same two. Two resolvers for one question
     * is what let this one be wrong on its own.
     */
    private identifier(name: string, sf: ts.SourceFile, at: ts.Node): { sf: ts.SourceFile; expr: ts.Expression } | null {
        // Innermost binding first: a parameter under substitution shadows
        // everything, exactly as it does at run time.
        for (let i = this.bound.length - 1; i >= 0; i--) {
            if (this.bound[i].name === name) return { sf: this.bound[i].sf, expr: this.bound[i].expr };
        }
        if (enclosingParam(name, at)) return null;

        const scoped = enclosingConst(name, at);
        if (scoped) return { sf, expr: scoped };

        for (const st of sf.statements) {
            if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings) continue;
            const nb = st.importClause.namedBindings;
            if (!ts.isNamedImports(nb)) continue;
            const el = nb.elements.find((e) => e.name.text === name);
            if (!el) continue;
            const spec = literalText(st.moduleSpecifier);
            const target = spec ? resolveImport(sf.fileName, spec, this.src.exists) : null;
            if (!target) return null;
            const tsf = this.src.parsed(target);
            const exported = (el.propertyName ?? el.name).text;
            const found = topLevelConst(tsf, exported);
            return found ? { sf: tsf, expr: found } : null;
        }
        return null;
    }

    /**
     * A call whose callee is bound to a URL builder, resolved from the binding.
     * `undefined` when the callee is not a builder at all.
     *
     * Two bindings count. A context HOOK contributes a fixed prefix. A local
     * ONE-parameter function contributes its whole body, read with the
     * argument bound to the parameter — which is both commoner and more
     * accurate than a prefix: `incidents/[incidentId]/page.tsx` writes
     * `(path) => `/api/t/${tenantSlug}/incidents/${incidentId}${path}``, and
     * the retired name heuristic emitted `/api/t/<slug>` for it, silently
     * dropping two segments.
     *
     * A local function with any other arity is NOT a builder: the slug-first
     * `function apiUrl(tenantSlug, path)` in `OnboardingWizard.tsx` is the
     * reason — reading `arguments[0]` as the path there produced a path built
     * from the workspace slug.
     */
    private builderCall(e: ts.CallExpression, sf: ts.SourceFile, depth: number): string[] | null | undefined {
        if (!ts.isIdentifier(e.expression)) return undefined;
        const arg = e.arguments[0];

        const prefix = this.builderPrefix(e.expression, sf);
        if (prefix) {
            const inner = arg ? this.paths(arg, sf, depth + 1) : null;
            return inner ? inner.map((p) => `${prefix}${p.startsWith('/') ? '' : '/'}${p}`) : null;
        }

        const fns = this.builderFunctionsFor(e.expression, sf);
        if (fns && fns.length > 1) {
            // More than one render site hands this child a builder. Read each
            // and union, the way a conditional's two branches already are —
            // and refuse unless EVERY one reads, since a union missing a
            // member is not a union.
            const each = fns.map(({ fn, sf: fsf }) => this.readBuilderBody(fn, fsf, e, depth));
            if (!each.every((x) => x !== null)) return null;
            return [...new Set((each as string[][]).flat())];
        }

        const only = fns?.[0];
        if (only) {
            const read = this.readBuilderBody(only.fn, only.sf, e, depth);
            return read;
        }
        return this.legacyNameFallback(e, sf, depth);
    }

    /**
     * The builder FUNCTION each of a callee's bindings holds, following a
     * destructured prop to its render sites (#5688).
     *
     * `builderPrefix` answers only for a context HOOK, which is why a prop
     * whose parent writes `const apiUrl = useCallback((path) => …)` fell back
     * to the callee's name: the prefix is not a constant, it is the function's
     * body. Nine of the twelve remaining fallbacks were that one missing hop.
     */
    private builderFunctionsFor(
        id: ts.Identifier,
        sf: ts.SourceFile,
        depth = 0,
    ): { fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration; sf: ts.SourceFile }[] | null {
        if (depth > 4) return null;

        const bound = this.identifier(id.text, sf, id);
        if (bound) {
            const fn = builderFunction(bound.expr);
            return fn ? [{ fn, sf: bound.sf }] : null;
        }
        const decl = functionDeclarationNamed(id.text, id);
        if (decl) return [{ fn: decl, sf }];

        const prop = destructuredProp(id.text, id);
        const values = prop ? this.propValues(sf, prop.component, prop.attribute) : null;
        if (!values) return null;

        const out: { fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration; sf: ts.SourceFile }[] = [];
        for (const v of values) {
            if (!ts.isIdentifier(v.expr)) {
                const fn = builderFunction(v.expr);
                if (!fn) return null;
                out.push({ fn, sf: v.sf });
                continue;
            }
            const nested = this.builderFunctionsFor(v.expr, v.sf, depth + 1);
            if (!nested) return null;
            out.push(...nested);
        }
        return out.length ? out : null;
    }

    /** Read one builder's body with the call's arguments bound by position. */
    private readBuilderBody(
        fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
        fnFile: ts.SourceFile,
        e: ts.CallExpression,
        depth: number,
    ): string[] | null {
        {
            const sf = fnFile;
            const bound = { sf: fnFile };
            const body = ts.isBlock(fn.body!) ? soleReturn(fn.body as ts.Block) : (fn.body as ts.Expression);
            if (!body) return null;

            // Every parameter is bound to the argument in its own position —
            // which is just how a call works, and is where #5662's defect
            // actually was: the old code assumed argument 0 was the PATH, so a
            // slug-first `apiUrl(tenantSlug, path)` had the workspace slug read
            // as the path. Binding by position makes the arity irrelevant and
            // the result exact: that helper now resolves to the onboarding
            // route its second argument names. A parameter with no argument is
            // left unbound and reads as a run-time value.
            const names = fn.parameters.map((x) => (ts.isIdentifier(x.name) ? x.name.text : null));
            let pushed = 0;
            names.forEach((name, i) => {
                const a = e.arguments[i];
                if (name && a) {
                    this.bound.push({ name, expr: a, sf });
                    pushed++;
                }
            });
            try {
                return this.paths(body, bound.sf ?? sf, depth + 1);
            } finally {
                for (let i = 0; i < pushed; i++) this.bound.pop();
            }
        }
    }

    /** No binding could be read: fall back to the callee's NAME, and count it. */
    private legacyNameFallback(e: ts.CallExpression, sf: ts.SourceFile, depth: number): string[] | null | undefined {
        if (!ts.isIdentifier(e.expression) || !LEGACY_BUILDER_NAMES.has(e.expression.text)) return undefined;
        this.nameFallbacks++;
        const arg = e.arguments[0];
        const inner = arg ? this.paths(arg, sf, depth + 1) : null;
        return inner ? inner.map((p) => `/api/t/\u0000${p.startsWith('/') ? '' : '/'}${p}`) : null;
    }

    /**
     * The prefix the callee is bound to build, or null when the binding does
     * not say so — a local function with its own body, a parameter, an import
     * this cannot follow. Null means the call falls through and is reported,
     * which is the whole point: the old name test could not tell
     * `useOrgApiUrl` from `useTenantApiUrl`, and answered for both.
     *
     * A builder handed down as a PROP is resolved from the render sites, and
     * only when every one of them agrees: two parents passing different
     * builders to one child make the prefix unknown, not a majority verdict.
     */
    private builderPrefix(id: ts.Identifier, sf: ts.SourceFile): string | null {
        const hookOf = (e: ts.Expression): string | null =>
            ts.isCallExpression(e) && ts.isIdentifier(e.expression) ? (URL_BUILDER_HOOKS[e.expression.text] ?? null) : null;

        const bound = this.identifier(id.text, sf, id);
        if (bound) return hookOf(bound.expr);

        const prop = destructuredProp(id.text, id);
        const values = prop ? this.propValues(sf, prop.component, prop.attribute) : null;
        if (!values) return null;
        const prefixes = new Set(
            values.map((v) => {
                // In ITS file's scope, not the child's: a parent elsewhere in
                // the reach binds its own `apiUrl`.
                if (ts.isIdentifier(v.expr)) return this.builderPrefix(v.expr, v.sf);
                return hookOf(v.expr);
            }),
        );
        return prefixes.size === 1 && !prefixes.has(null) ? [...prefixes][0] : null;
    }

    private keys(): Map<string, KeyEntry> {
        if (this.swrKeys) return this.swrKeys;
        this.swrKeys = new Map();
        if (!this.src.exists(SWR_KEYS_FILE)) return this.swrKeys;
        const sf = this.src.parsed(SWR_KEYS_FILE);
        const table = topLevelConst(sf, 'CACHE_KEYS');
        const unwrap = (e: ts.Expression): ts.Expression => (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) ? unwrap(e.expression) : e);
        const add = (prefix: string, e: ts.Expression) => {
            const v = unwrap(e);
            if (ts.isObjectLiteralExpression(v)) {
                for (const p of v.properties) {
                    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
                        add(`${prefix}${p.name.text}.`, p.initializer);
                    } else if (ts.isSpreadAssignment(p)) {
                        add(prefix, p.expression);
                    }
                }
            } else if (ts.isCallExpression(v) && ts.isIdentifier(v.expression) && v.expression.text === 'makeResource') {
                const base = literalText(v.arguments[0]);
                if (base === null) return;
                const mk = (text: string) => ts.factory.createNoSubstitutionTemplateLiteral(text);
                this.swrKeys!.set(`${prefix}list`, { sf, expr: mk(`/${base}`) });
                this.swrKeys!.set(`${prefix}detail`, { sf, expr: mk(`/${base}/\u0000`) });
            } else if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) {
                const body = v.body;
                let expr: ts.Expression | undefined;
                if (ts.isBlock(body)) {
                    // `let key = …; …; return key;` — the first assignment is the path.
                    const ret = body.statements.find(ts.isReturnStatement);
                    expr = ret?.expression;
                    if (expr && ts.isIdentifier(expr)) {
                        const name = expr.text;
                        const decl = body.statements
                            .filter(ts.isVariableStatement)
                            .flatMap((s) => [...s.declarationList.declarations])
                            .find((d) => ts.isIdentifier(d.name) && d.name.text === name);
                        expr = decl?.initializer;
                    }
                } else {
                    expr = body;
                }
                if (expr) this.swrKeys!.set(prefix.slice(0, -1), { sf, expr });
            }
        };
        if (table) add('', table);
        return this.swrKeys;
    }

    /** `CACHE_KEYS.audits.cycle` → `audits.cycle`, else null. */
    private keyPath(e: ts.Expression): string | null {
        const parts: string[] = [];
        let cur: ts.Expression = e;
        while (ts.isPropertyAccessExpression(cur)) {
            parts.unshift(cur.name.text);
            cur = cur.expression;
        }
        return ts.isIdentifier(cur) && cur.text === 'CACHE_KEYS' && parts.length ? parts.join('.') : null;
    }

    paths(expr: ts.Expression, sf: ts.SourceFile, depth = 0): string[] | null {
        if (depth > 8) return null;
        const e =
            ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)
                ? expr.expression
                : expr;
        const lit = literalText(e);
        if (lit !== null) return [lit];
        if (ts.isTemplateExpression(e)) {
            let acc = [e.head.text];
            e.templateSpans.forEach((span, i) => {
                const last = i === e.templateSpans.length - 1 && span.literal.text === '';
                const inner = this.paths(span.expression, sf, depth + 1);
                let parts: string[];
                // Glued to the text before it (`…/identity-accounts${query}`), a
                // trailing query-named value is the query string; after a `/` it
                // is a segment (`/vendors/${params.vendorId}`).
                const glued = acc.every((a) => a.length > 0 && !a.endsWith('/'));
                if (inner) parts = inner;
                else if (last && glued && QUERY_SUFFIX.test(span.expression.getText(sf))) parts = [''];
                else parts = ['\u0000'];
                acc = acc.flatMap((a) => parts.map((p) => a + p + span.literal.text));
            });
            return acc;
        }
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const l = this.paths(e.left, sf, depth + 1);
            const r = this.paths(e.right, sf, depth + 1) ?? ['\u0000'];
            return l ? l.flatMap((a) => r.map((b) => a + b)) : null;
        }
        if (ts.isConditionalExpression(e)) {
            // `cond ? path : null` is the SWR "do not fetch yet" idiom: the call
            // is the path branch.
            const isNull = (x: ts.Expression) =>
                x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
            if (isNull(e.whenFalse)) return this.paths(e.whenTrue, sf, depth + 1);
            if (isNull(e.whenTrue)) return this.paths(e.whenFalse, sf, depth + 1);
            const a = this.paths(e.whenTrue, sf, depth + 1);
            const b = this.paths(e.whenFalse, sf, depth + 1);
            return a && b ? [...a, ...b] : null;
        }
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
            // A URL builder is recognised by what it is BOUND to, never by its
            // name. `undefined` means "not a builder" and falls through to the
            // arms below; `null` means "a builder this cannot read", which is
            // reported rather than given a guessed prefix.
            const built = this.builderCall(e, sf, depth);
            if (built !== undefined) return built;
        }
        if (ts.isCallExpression(e)) {
            const key = this.keyPath(e.expression);
            const entry = key ? this.keys().get(key) : undefined;
            if (entry) return this.paths(entry.expr, entry.sf, depth + 1);
        }
        if (ts.isElementAccessExpression(e)) {
            // `ENDPOINT[type]` over an object of paths: every value is a call it can make.
            const obj = this.paths(e.expression, sf, depth + 1);
            if (obj) return obj;
            const target = ts.isIdentifier(e.expression) ? this.identifier(e.expression.text, sf, e) : null;
            if (target && ts.isObjectLiteralExpression(target.expr)) {
                const values = target.expr.properties
                    .filter(ts.isPropertyAssignment)
                    .map((p) => this.paths(p.initializer, target.sf, depth + 1));
                return values.every(Boolean) && values.length ? values.flat() as string[] : null;
            }
            return null;
        }
        if (ts.isIdentifier(e)) {
            const target = this.identifier(e.text, sf, e);
            if (target && !ts.isObjectLiteralExpression(target.expr)) return this.paths(target.expr, target.sf, depth + 1);
            const prop = destructuredProp(e.text, e);
            const values = prop ? this.propValues(sf, prop.component, prop.attribute) : null;
            if (values) {
                const each = values.map((v) => this.paths(v.expr, v.sf, depth + 1));
                if (each.every((x) => x !== null)) return [...new Set((each as string[][]).flat())];
            }
        }
        // `useMemo(() => …, deps)`: the key is what the factory returns —
        // every `return` of a block body.
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && /^use(Memo|Callback)$/.test(e.expression.text)) {
            const fn = e.arguments[0];
            if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
            if (!ts.isBlock(fn.body)) return this.paths(fn.body, sf, depth + 1);
            const returns: ts.Expression[] = [];
            walk(fn.body, (n) => {
                if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
            });
            const each = returns.map((r) => this.paths(r, sf, depth + 1));
            return each.length && each.every(Boolean) ? (each.flat() as string[]) : null;
        }
        return null;
    }

    /** Every method a `fetch` init's `method:` can take; null when it cannot be read. */
    methods(expr: ts.Expression, sf: ts.SourceFile): HttpMethod[] | null {
        const texts = this.paths(expr, sf);
        if (!texts) return null;
        const up = texts.map((t) => t.toUpperCase());
        return up.every((t) => (HTTP_METHODS as readonly string[]).includes(t)) ? [...new Set(up as HttpMethod[])] : null;
    }
}

/** `/api/t/\u0000/risks/\u0000?x=1` → `['api','t',null,'risks',null]`. */
export function toSegments(p: string): CallSegment[] | null {
    const noQuery = p.split(/[?#]/)[0];
    if (!noQuery.startsWith('/')) return null;
    const parts = noQuery.split('/').filter((s) => s.length > 0);
    // Two run-time values in one segment (`${tenantSlug}${endpoint}`) hide
    // how many segments the second one holds, so the path is unreadable.
    if (parts.some((s) => s.split('\u0000').length > 2)) return null;
    return parts.map((s) => (s.includes('\u0000') ? null : s));
}

function methodsOf(call: ts.CallExpression, how: HttpMethod | 'init' | 'arg1', sf: ts.SourceFile, r: UrlResolver): HttpMethod[] | null {
    if (how === 'arg1') return call.arguments[1] ? r.methods(call.arguments[1], sf) : ['GET'];
    if (how !== 'init') return [how];
    const init = call.arguments[1];
    if (!init) return ['GET'];
    if (!ts.isObjectLiteralExpression(init)) return null;
    const prop = init.properties.find(
        (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'method',
    );
    if (!prop) return init.properties.some(ts.isSpreadAssignment) ? null : ['GET'];
    return r.methods(prop.initializer, sf);
}

/** Every API call a file makes. */
export function apiCalls(file: string, sf: ts.SourceFile, r: UrlResolver): ApiCall[] {
    const calls: ApiCall[] = [];
    walk(sf, (n) => {
        if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
        const how = CALLEES[n.expression.text];
        if (!how || n.arguments.length === 0) return;
        const arg = n.arguments[0];
        // useTenantSWR(null) is the SWR "do not fetch" idiom.
        if (arg.kind === ts.SyntaxKind.NullKeyword) return;
        if (isSwrFetcherParam(arg)) return;
        const methods = methodsOf(n, how.method, sf, r);
        let paths = r.paths(arg, sf);
        if (paths && how.tenantRelative) paths = paths.map((p) => `/api/t/\u0000${p.startsWith('/') ? '' : '/'}${p}`);
        const base = { file, line: lineOf(sf, n), expression: arg.getText(sf).replace(/\s+/g, ' ').slice(0, 120) };
        if (!paths) {
            calls.push({ ...base, methods: methods ?? [], segments: null });
            return;
        }
        for (const p of new Set(paths)) {
            // A URL written out in full that is not root-relative — an external
            // site, a relative asset — is not a call to this API.
            if (!p.includes('\u0000') && !p.startsWith('/')) continue;
            const segs = toSegments(p);
            if (segs && segs[0] !== 'api') continue;
            calls.push({ ...base, methods: methods ?? [], segments: segs });
        }
    });
    return calls;
}

export interface ResolvedAction {
    method: HttpMethod;
    route: ApiRoute;
    /** Permission keys the route checks itself; `[]` = checked in the use case. */
    permission: string[];
    sites: { file: string; line: number }[];
}

export interface UnresolvedCall {
    file: string;
    line: number;
    why: string;
    expression: string;
}

export interface PageActions {
    page: string;
    resolved: ResolvedAction[];
    unresolved: UnresolvedCall[];
}

export function pageActions(page: string, src: Source, routes: readonly ApiRoute[], r = new UrlResolver(src)): PageActions {
    const byKey = new Map<string, ResolvedAction>();
    const unresolved: UnresolvedCall[] = [];
    const missing = (c: ApiCall, why: string) => unresolved.push({ file: c.file, line: c.line, why, expression: c.expression });
    const reach = pageReach(page, src);
    for (const file of reach) {
        for (const c of r.withReach(reach, () => apiCalls(file, src.parsed(file), r))) {
            if (!c.segments) {
                missing(c, 'the URL is built in a way the scan cannot follow');
                continue;
            }
            const matched = matchRoutes(c.segments, routes);
            if (matched.length === 0) {
                missing(c, 'no API route matches this path');
                continue;
            }
            if (c.methods.length === 0) {
                missing(c, 'the HTTP method is decided at run time');
                continue;
            }
            // A call whose URL and method are BOTH conditional (`editing ? PATCH
            // /x/1 : POST /x`) is read as every pairing; only the pairings a
            // route serves are kept, and the call is missing only when none is.
            const served = matched.flatMap((route) => c.methods.filter((m) => route.methods[m]).map((m) => ({ route, m })));
            if (served.length === 0) {
                missing(c, `${matched[0].file} exports no ${c.methods.join(' or ')}`);
                continue;
            }
            for (const { route, m } of served) {
                const key = `${m} ${route.url}`;
                const hit = byKey.get(key) ?? { method: m, route, permission: route.methods[m]!, sites: [] };
                if (!hit.sites.some((x) => x.file === c.file && x.line === c.line)) hit.sites.push({ file: c.file, line: c.line });
                byKey.set(key, hit);
            }
        }
    }
    const resolved = [...byKey.values()].sort(
        (a, b) => a.route.url.localeCompare(b.route.url) || HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method),
    );
    return { page, resolved, unresolved };
}

/** Every `page.tsx` under `src/app/`, as `{ file, route }`. */
export function appPages(files: readonly string[]): { file: string; route: string }[] {
    return files
        .filter((f) => /^src\/app\/(?:.+\/)?page\.tsx$/.test(f))
        .map((f) => {
            const dir = f.slice(0, -'/page.tsx'.length);
            return { file: f, route: `/${routeSegments(dir, 'src/app').join('/')}` };
        });
}
