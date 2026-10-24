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
 * two branches, and a `const` in the same file. Anything else is UNRESOLVED,
 * and is listed with its file and line rather than dropped: a scanner that
 * silently skips what it cannot read reports full coverage of the part it
 * understands.
 */
import * as path from 'node:path';
import ts from 'typescript';
import { type ApiRoute, type CallSegment, type HttpMethod, HTTP_METHODS, matchRoutes } from './api-routes';
import { lineOf, literalText, parse, routeSegments, walk } from './source';

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
 * following `const`s in the same file, `const`s a file imports by name, and
 * the `CACHE_KEYS` table. Each path is text with `\u0000` standing for a value
 * only known at run time; null means the expression could not be read.
 */
export class UrlResolver {
    private consts = new Map<ts.SourceFile, Map<string, ts.Expression[]>>();
    private swrKeys: Map<string, KeyEntry> | null = null;

    constructor(private readonly src: Source) {}

    private localConsts(sf: ts.SourceFile): Map<string, ts.Expression[]> {
        let m = this.consts.get(sf);
        if (!m) {
            m = new Map();
            const map = m;
            walk(sf, (n) => {
                if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
                    const list = map.get(n.name.text) ?? [];
                    list.push(n.initializer);
                    map.set(n.name.text, list);
                }
            });
            this.consts.set(sf, m);
        }
        return m;
    }

    /** The initialiser a name refers to: a const in this file, or one it imports. */
    private identifier(name: string, sf: ts.SourceFile, at: ts.Node): { sf: ts.SourceFile; expr: ts.Expression } | null {
        const local = this.localConsts(sf).get(name);
        if (local) {
            const before = local.filter((e) => e.pos < at.pos);
            return { sf, expr: before[before.length - 1] ?? local[0] };
        }
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
            const found = this.localConsts(tsf).get(exported);
            return found ? { sf: tsf, expr: found[0] } : null;
        }
        return null;
    }

    private keys(): Map<string, KeyEntry> {
        if (this.swrKeys) return this.swrKeys;
        this.swrKeys = new Map();
        if (!this.src.exists(SWR_KEYS_FILE)) return this.swrKeys;
        const sf = this.src.parsed(SWR_KEYS_FILE);
        const table = this.localConsts(sf).get('CACHE_KEYS')?.[0];
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
