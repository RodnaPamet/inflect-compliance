/**
 * The permission gate each exported handler of a route file is wrapped in, read
 * from the syntax tree.
 *
 * `requirePermission(...)` is the key a route actually enforces:
 * `ROUTE_PERMISSIONS` is declarative and no request path reads it. So a guard
 * that wants to know which key protects a handler has to read it here, and a
 * guard that only checks the word `requirePermission` appears in the file (an
 * import, a comment) knows nothing about it (#4441).
 *
 * A gate counts only when it is on the handler's SPINE: the exported
 * initializer is the wrapper call, or a call whose arguments lead to it
 * (`withApiErrorHandling(requirePermission(...))`), possibly through a
 * file-level `const` (`withApiErrorHandling(putHandler)`). Function bodies are
 * not entered, so a `requirePermission(...)` that is merely called somewhere
 * inside the handler does not count as wrapping it.
 *
 * Syntax only (`ts.createSourceFile`), so comments can never satisfy it.
 */
import * as ts from 'typescript';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** The wrappers, and the mode each forces (`null`: read from the argument). */
const WRAPPERS: Readonly<Record<string, 'any' | 'all' | null>> = {
    requirePermission: null,
    requireAnyPermission: 'any',
    requireAllPermissions: 'all',
};

export type HandlerGate =
    | { readonly kind: 'gated'; readonly keys: readonly string[]; readonly mode: 'any' | 'all' }
    | { readonly kind: 'ungated' }
    /** A gate whose requirement is not literal, so nobody can say which key it is. */
    | { readonly kind: 'unreadable'; readonly why: string };

function stringList(n: ts.Expression): string[] | null {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
    if (ts.isArrayLiteralExpression(n)) {
        const out: string[] = [];
        for (const e of n.elements) {
            if (!ts.isStringLiteral(e)) return null;
            out.push(e.text);
        }
        return out;
    }
    return null;
}

function requirementOf(call: ts.CallExpression, wrapper: string): HandlerGate {
    const arg = call.arguments[0];
    const forced = WRAPPERS[wrapper];
    if (!arg) return { kind: 'unreadable', why: `${wrapper}() with no requirement` };
    const keys = stringList(arg);
    if (keys) return { kind: 'gated', keys, mode: forced ?? 'all' };
    if (forced === null && ts.isObjectLiteralExpression(arg)) {
        let objKeys: string[] | null = null;
        let mode: 'any' | 'all' = 'all';
        for (const p of arg.properties) {
            if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
                return { kind: 'unreadable', why: arg.getText() };
            }
            if (p.name.text === 'keys') {
                objKeys = stringList(p.initializer);
            } else if (
                p.name.text === 'mode'
                && ts.isStringLiteral(p.initializer)
                && (p.initializer.text === 'any' || p.initializer.text === 'all')
            ) {
                mode = p.initializer.text;
            } else {
                return { kind: 'unreadable', why: arg.getText() };
            }
        }
        if (objKeys) return { kind: 'gated', keys: objKeys, mode };
    }
    return { kind: 'unreadable', why: arg.getText() };
}

function unwrap(e: ts.Expression): ts.Expression {
    let x = e;
    while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) {
        x = x.expression;
    }
    return x;
}

function gateOn(
    expr: ts.Expression,
    consts: ReadonlyMap<string, ts.Expression>,
    seen: Set<string>,
): HandlerGate | null {
    const e = unwrap(expr);
    if (ts.isIdentifier(e)) {
        const init = consts.get(e.text);
        if (!init || seen.has(e.text)) return null;
        seen.add(e.text);
        return gateOn(init, consts, seen);
    }
    if (!ts.isCallExpression(e)) return null;
    if (ts.isIdentifier(e.expression) && e.expression.text in WRAPPERS) {
        return requirementOf(e, e.expression.text);
    }
    for (const a of e.arguments) {
        const found = gateOn(a, consts, seen);
        if (found) return found;
    }
    return null;
}

/**
 * Every exported HTTP handler in `source` and its gate. An `export { x as GET }`
 * or a re-export is reported as unreadable rather than guessed at.
 */
export function handlerGates(source: string, fileName = 'route.ts'): Map<HttpMethod, HandlerGate> {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const consts = new Map<string, ts.Expression>();
    const exported = new Map<HttpMethod, ts.Expression | null>();
    const isMethod = (name: string): name is HttpMethod => (HTTP_METHODS as readonly string[]).includes(name);
    const out = new Map<HttpMethod, HandlerGate>();

    for (const st of sf.statements) {
        const isExported =
            ts.canHaveModifiers(st) && !!ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
                if (!ts.isIdentifier(d.name) || !d.initializer) continue;
                consts.set(d.name.text, d.initializer);
                if (isExported && isMethod(d.name.text)) exported.set(d.name.text, d.initializer);
            }
        } else if (ts.isFunctionDeclaration(st) && isExported && st.name && isMethod(st.name.text)) {
            // A plain function cannot be wrapped: it is the handler itself.
            exported.set(st.name.text, null);
        } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
            for (const el of st.exportClause.elements) {
                if (isMethod(el.name.text)) {
                    out.set(el.name.text, { kind: 'unreadable', why: `re-exported as ${el.getText()}` });
                }
            }
        }
    }

    for (const [method, init] of exported) {
        out.set(method, init === null ? { kind: 'ungated' } : gateOn(init, consts, new Set()) ?? { kind: 'ungated' });
    }
    return out;
}

/** One comparable string for a requirement: a single key as itself, else mode plus sorted keys. */
export function requirementLabel(keys: readonly string[], mode: 'any' | 'all'): string {
    const sorted = [...keys].sort();
    return sorted.length === 1 ? sorted[0] : `${mode}(${sorted.join(', ')})`;
}
