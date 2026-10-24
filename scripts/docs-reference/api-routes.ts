/**
 * The API route table: every `src/app/api/**\/route.ts`, the HTTP methods it
 * exports, and the permission key each method checks at the route itself.
 *
 * A method with no `requirePermission(...)` in its handler is not
 * unprotected: it is authorised in the use case it calls (CLAUDE.md, Epic C.1
 * "Two layers"). The table says which of the two applies and names the key
 * only when the route names it.
 */
import ts from 'typescript';
import { literalText, parse, routeSegments, walk } from './source';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ApiRoute {
    /** Repo path of the route file. */
    file: string;
    /** `/api/t/[tenantSlug]/risks/[id]` — dynamic segments as written on disk. */
    url: string;
    segments: string[];
    /** Method → the permission keys `requirePermission` names; `[]` = checked in the use case. */
    methods: Partial<Record<HttpMethod, string[]>>;
}

const API_DIR = 'src/app/api';

/** The keys a `requirePermission(...)` call inside `node` names. */
function permissionKeys(node: ts.Node, locals: Map<string, ts.Expression>, depth = 0): string[] {
    const keys: string[] = [];
    walk(node, (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'requirePermission') {
            const arg = n.arguments[0];
            const one = literalText(arg);
            if (one) keys.push(one);
            else if (arg && ts.isArrayLiteralExpression(arg)) {
                for (const el of arg.elements) {
                    const k = literalText(el);
                    if (k) keys.push(k);
                }
            }
        }
        // `export const GET = withApiErrorHandling(handler)` — follow a local
        // const once or twice, never further: a deeper chain is not a route's
        // own gate any more.
        if (depth < 2 && ts.isIdentifier(n) && locals.has(n.text) && n !== node) {
            keys.push(...permissionKeys(locals.get(n.text)!, locals, depth + 1));
        }
    });
    return [...new Set(keys)];
}

export function parseApiRoute(file: string, text: string): ApiRoute {
    const sf = parse(file, text);
    const locals = new Map<string, ts.Expression>();
    for (const st of sf.statements) {
        if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
                if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer);
            }
        }
    }
    const methods: Partial<Record<HttpMethod, string[]>> = {};
    const isMethod = (name: string): name is HttpMethod => (HTTP_METHODS as readonly string[]).includes(name);
    const exported = (st: ts.Statement) =>
        ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const st of sf.statements) {
        if (ts.isVariableStatement(st) && exported(st)) {
            for (const d of st.declarationList.declarations) {
                if (ts.isIdentifier(d.name) && isMethod(d.name.text)) {
                    methods[d.name.text] = d.initializer ? permissionKeys(d.initializer, locals) : [];
                }
            }
        } else if (ts.isFunctionDeclaration(st) && st.name && exported(st) && isMethod(st.name.text)) {
            methods[st.name.text] = st.body ? permissionKeys(st.body, locals) : [];
        } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
            for (const el of st.exportClause.elements) {
                const name = el.name.text;
                if (!isMethod(name)) continue;
                const local = el.propertyName?.text ?? name;
                methods[name] = locals.has(local) ? permissionKeys(locals.get(local)!, locals) : [];
            }
        }
    }
    const dir = file.slice(0, -'/route.ts'.length);
    const segments = ['api', ...routeSegments(dir, API_DIR)];
    return { file, url: `/${segments.join('/')}`, segments, methods };
}

export function apiRouteTable(files: readonly string[], read: (f: string) => string): ApiRoute[] {
    return files
        .filter((f) => f.startsWith(`${API_DIR}/`) && /\/route\.ts$/.test(f))
        .map((f) => parseApiRoute(f, read(f)));
}

/** A segment of a called path: a literal, or `null` for a value only known at run time. */
export type CallSegment = string | null;

/**
 * The routes a call reaches, the way Next.js resolves it: a literal segment
 * wins over a dynamic one at the same position, so `/risks/bulk` matches
 * `risks/bulk/route.ts` and not `risks/[id]/route.ts`, and a run-time segment
 * matches a dynamic one. Only when nothing matches that way may a run-time
 * segment stand for a literal one — `/agent-proposals/${id}/${action}` is
 * then every action route under it, each returned.
 */
export function matchRoutes(call: readonly CallSegment[], routes: readonly ApiRoute[]): ApiRoute[] {
    const strict = best(call, routes, false);
    if (strict) return [strict];
    return routes.filter((r) => matchScore(call, r.segments, true) !== null);
}

function best(call: readonly CallSegment[], routes: readonly ApiRoute[], loose: boolean): ApiRoute | null {
    let top: { route: ApiRoute; score: number[] } | null = null;
    for (const r of routes) {
        const score = matchScore(call, r.segments, loose);
        if (!score) continue;
        if (!top || compareScore(score, top.score) > 0) top = { route: r, score };
    }
    return top?.route ?? null;
}

function matchScore(call: readonly CallSegment[], route: readonly string[], loose: boolean): number[] | null {
    const score: number[] = [];
    for (let i = 0; i < route.length; i++) {
        const seg = route[i];
        const catchAll = /^\[\[?\.\.\./.test(seg);
        if (catchAll) {
            const optional = seg.startsWith('[[');
            if (i >= call.length && !optional) return null;
            score.push(0);
            return score;
        }
        if (i >= call.length) return null;
        const c = call[i];
        if (/^\[.+\]$/.test(seg)) score.push(1);
        else if (c !== null && c === seg) score.push(2);
        else if (c === null && loose) score.push(0);
        else return null;
    }
    return call.length === route.length ? score : null;
}

function compareScore(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? -1) - (b[i] ?? -1);
        if (d) return d;
    }
    return 0;
}
