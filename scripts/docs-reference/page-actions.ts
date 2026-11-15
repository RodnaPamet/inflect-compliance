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
function propValues(sf: ts.SourceFile, component: string, attribute: string): ts.Expression[] | null {
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
    return unknown || values.length === 0 ? null : values;
}

const TENANT_URL_BUILDERS = new Set(['apiUrl', 'buildApiUrl', 'tenantApiUrl']);

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
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && TENANT_URL_BUILDERS.has(e.expression.text)) {
            const inner = e.arguments[0] ? this.paths(e.arguments[0], sf, depth + 1) : null;
            return inner ? inner.map((p) => `/api/t/\u0000${p.startsWith('/') ? '' : '/'}${p}`) : null;
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
            const values = prop ? propValues(sf, prop.component, prop.attribute) : null;
            if (values) {
                const each = values.map((v) => this.paths(v, sf, depth + 1));
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
    for (const file of pageReach(page, src)) {
        for (const c of apiCalls(file, src.parsed(file), r)) {
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
