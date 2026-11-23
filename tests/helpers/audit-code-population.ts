/**
 * Every audit `action` and entity type the source writes, read from the code.
 *
 * `AuditLog.action` and `AuditLog.entity` are free strings: there is no enum
 * to enumerate. What the product writes is what its writers pass, so the
 * population is read off the source the same way a reader would find it — an
 * object literal that carries an `action` beside an `entityType` (the
 * `logEvent` payload) or an `entity` (the `appendAuditEntry` one).
 *
 * A value is taken when it is a string literal, either arm of a conditional,
 * or a same-file `const` holding a literal. Anything else (a parameter, a
 * template, a computed code) cannot be read here and is reported as
 * `unresolved` with its location, so a caller can see the share it does not
 * cover rather than mistake the subset for the whole.
 */
import * as fs from 'node:fs';

import * as ts from 'typescript';

import { repoFiles, repoRelative } from './repo-files';

export interface AuditCodePopulation {
    /** SNAKE_CASE action codes, sorted. */
    readonly actions: readonly string[];
    /** Entity type names as written (`Risk`, `RISK`, `TenantCustomRole`), sorted. */
    readonly entities: readonly string[];
    /** `file:line` of each `action` value that is not a readable literal. */
    readonly unresolved: readonly string[];
}

const ACTION_CODE = /^[A-Z][A-Z0-9_]*$/;
const ENTITY_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function propName(p: ts.ObjectLiteralElementLike): string | null {
    if (!p.name) return null;
    if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
    return null;
}

function propValue(p: ts.ObjectLiteralElementLike): ts.Expression | null {
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) return p.name;
    return null;
}

/** The function (or file) a node is evaluated in. */
function scopeOf(node: ts.Node): ts.Node {
    let n: ts.Node | undefined = node.parent;
    while (n && !ts.isFunctionLike(n) && !ts.isSourceFile(n)) n = n.parent;
    return n ?? node.getSourceFile();
}

/** The scopes a use at `node` can see: its own and every one around it. */
function visibleScopes(node: ts.Node): Set<ts.Node> {
    const out = new Set<ts.Node>();
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
        if (ts.isFunctionLike(n) || ts.isSourceFile(n)) out.add(n);
    }
    return out;
}

let cached: AuditCodePopulation | null = null;

export function auditCodePopulation(): AuditCodePopulation {
    if (cached) return cached;
    const actions = new Set<string>();
    const entities = new Set<string>();
    const unresolved: string[] = [];

    for (const file of repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })) {
        const text = fs.readFileSync(file, 'utf8');
        if (!/\baction\b/.test(text)) continue;
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

        // Every expression assigned to a name: `const x = …`, `let x = …` and a
        // later `x = …`, each with the function it sits in. A use sees the
        // assignments in its own function and in the functions around it — a
        // name is the union of those, which can only add codes, never hide one.
        const assigned = new Map<string, { scope: ts.Node; expr: ts.Expression }[]>();
        const note = (name: string, expr: ts.Expression) =>
            assigned.set(name, [...(assigned.get(name) ?? []), { scope: scopeOf(expr), expr }]);
        const collect = (node: ts.Node): void => {
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
                note(node.name.text, node.initializer);
            }
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(node.left)
            ) {
                note(node.left.text, node.right);
            }
            ts.forEachChild(node, collect);
        };
        collect(sf);

        const resolve = (expr: ts.Expression, seen: ReadonlySet<string> = new Set()): string[] | null => {
            if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
            if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isSatisfiesExpression(expr)) {
                return resolve(expr.expression, seen);
            }
            if (ts.isConditionalExpression(expr)) {
                const a = resolve(expr.whenTrue, seen);
                const b = resolve(expr.whenFalse, seen);
                return a && b ? [...a, ...b] : null;
            }
            if (ts.isIdentifier(expr)) {
                const scopes = visibleScopes(expr);
                const exprs = (assigned.get(expr.text) ?? []).filter((a) => scopes.has(a.scope));
                if (exprs.length === 0 || seen.has(expr.text)) return null;
                const next = new Set([...seen, expr.text]);
                const out: string[] = [];
                for (const { expr: e } of exprs) {
                    const r = resolve(e, next);
                    if (r === null) return null;
                    out.push(...r);
                }
                return out;
            }
            // `MAP.KEY` over an object literal of codes: that value.
            if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
                const out: string[] = [];
                for (let { expr: e } of assigned.get(expr.expression.text) ?? []) {
                    while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) {
                        e = e.expression;
                    }
                    if (!ts.isObjectLiteralExpression(e)) return null;
                    const prop = e.properties.find(
                        (p) => ts.isPropertyAssignment(p) && propName(p) === expr.name.text,
                    );
                    const v = prop && ts.isPropertyAssignment(prop) ? resolve(prop.initializer, seen) : null;
                    if (v === null) return null;
                    out.push(...v);
                }
                return out.length > 0 ? out : null;
            }
            // `MAP[key]` over an object literal of codes: every value it holds.
            if (ts.isElementAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
                const exprs = assigned.get(expr.expression.text) ?? [];
                const out: string[] = [];
                for (let { expr: e } of exprs) {
                    while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) {
                        e = e.expression;
                    }
                    if (!ts.isObjectLiteralExpression(e)) return null;
                    for (const p of e.properties) {
                        const v = ts.isPropertyAssignment(p) ? resolve(p.initializer, seen) : null;
                        if (v === null) return null;
                        out.push(...v);
                    }
                }
                return out.length > 0 ? out : null;
            }
            return null;
        };

        const visit = (node: ts.Node): void => {
            if (ts.isObjectLiteralExpression(node)) {
                const byName = new Map<string, ts.Expression>();
                for (const p of node.properties) {
                    const name = propName(p);
                    const value = propValue(p);
                    if (name && value) byName.set(name, value);
                }
                const action = byName.get('action');
                const entity = byName.get('entityType') ?? byName.get('entity');
                // A Prisma `select` (`action: true`) or `where` (`{ in: … }`)
                // reads the column; it writes no code.
                const isRead =
                    action !== undefined &&
                    (action.kind === ts.SyntaxKind.TrueKeyword || ts.isObjectLiteralExpression(action));
                if (action && entity && !isRead) {
                    const codes = resolve(action);
                    if (codes === null) {
                        unresolved.push(`${repoRelative(file)}:${sf.getLineAndCharacterOfPosition(action.getStart()).line + 1}`);
                    } else {
                        for (const c of codes) if (ACTION_CODE.test(c)) actions.add(c);
                    }
                    for (const e of resolve(entity) ?? []) if (ENTITY_NAME.test(e)) entities.add(e);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }

    cached = {
        actions: [...actions].sort(),
        entities: [...entities].sort(),
        unresolved,
    };
    return cached;
}
