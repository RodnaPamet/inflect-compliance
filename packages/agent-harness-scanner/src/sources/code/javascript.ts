/**
 * THE JAVASCRIPT AND TYPESCRIPT READER (#3737) — text in, `FileFacts` out.
 *
 * TypeScript's own parser (`ts.createSourceFile`), which the repository already
 * depends on, builds a SYNTAX tree: no program, no type checker, no module
 * resolution, no emit. It reads JavaScript and TypeScript alike, so a LangChain
 * JS project written in either is one code path. Nothing here requires,
 * imports or evaluates the file: an `import` or a `require("…")` in the scanned
 * code is read as text naming a module, which is all the recogniser needs.
 *
 * A file the parser reports a syntax error in is refused whole
 * (`JavaScriptReadError`), so a definition is never half-read from a tree the
 * parser had to guess at.
 */
import * as ts from 'typescript';

import {
    callsWithin,
    type Binding,
    type CallExpr,
    type Expr,
    type FileFacts,
    type Qualified,
    type ToolDeclaration,
} from './ir';

export class JavaScriptReadError extends Error {
    constructor(readonly line: number, message: string) {
        super(`line ${line}: ${message}`);
        this.name = 'JavaScriptReadError';
    }
}

const MAX_DEPTH = 64;

function scriptKindOf(fileName: string): ts.ScriptKind {
    if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
    if (/\.(ts|mts|cts)$/i.test(fileName)) return ts.ScriptKind.TS;
    if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
    return ts.ScriptKind.JS;
}

/** Read one file's imports, bindings, tool declarations and calls. Throws `JavaScriptReadError`. */
export function readJavaScript(fileName: string, src: string): FileFacts {
    const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
    const diagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
    if (diagnostics.length > 0) {
        const at = sf.getLineAndCharacterOfPosition(diagnostics[0].start).line + 1;
        throw new JavaScriptReadError(at, 'the file does not parse');
    }

    const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const imports = new Map<string, Qualified>();
    const bindings = new Map<string, Binding[]>();
    const toolDeclarations = new Map<string, ToolDeclaration>();
    const calls: { call: CallExpr; boundTo: string | null }[] = [];
    /** One IR node per syntax node, so a binding and the call list share identity. */
    const lowered = new Map<ts.Node, Expr>();

    const keyOf = (name: ts.PropertyName): string | null => {
        if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
        if (ts.isPrivateIdentifier(name)) return null;
        return null;
    };

    const lower = (node: ts.Expression, depth = 0): Expr => {
        const cached = lowered.get(node);
        if (cached) return cached;
        const line = lineOf(node);
        let e: Expr;
        if (depth > MAX_DEPTH) {
            e = { k: 'opaque', line };
        } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
            || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isAwaitExpression(node)) {
            e = lower(node.expression, depth + 1);
        } else if (ts.isIdentifier(node)) {
            e = { k: 'ref', name: node.text, line };
        } else if (node.kind === ts.SyntaxKind.ThisKeyword) {
            e = { k: 'ref', name: 'this', line };
        } else if (ts.isPropertyAccessExpression(node)) {
            e = ts.isIdentifier(node.name)
                ? { k: 'attr', obj: lower(node.expression, depth + 1), name: node.name.text, line }
                : { k: 'opaque', line };
        } else if (ts.isElementAccessExpression(node)) {
            e = { k: 'sub', obj: lower(node.expression, depth + 1), key: lower(node.argumentExpression, depth + 1), line };
        } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const args = (node.arguments ?? []).map((a) => (ts.isSpreadElement(a) ? lower(a.expression, depth + 1) : lower(a, depth + 1)));
            const spread = (node.arguments ?? []).some((a) => ts.isSpreadElement(a));
            e = { k: 'call', fn: lower(node.expression, depth + 1), args, kwargs: new Map(), spread, line };
        } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            e = { k: 'str', value: node.text, template: false, line };
        } else if (ts.isTemplateExpression(node)) {
            e = { k: 'str', value: node.head.text, template: true, line };
        } else if (ts.isArrayLiteralExpression(node)) {
            e = {
                k: 'list',
                items: node.elements.map((el) => (ts.isSpreadElement(el) ? lower(el.expression, depth + 1) : lower(el, depth + 1))),
                spread: false,
                line,
            };
        } else if (ts.isObjectLiteralExpression(node)) {
            const entries: (readonly [string | null, Expr])[] = [];
            let spread = false;
            for (const p of node.properties) {
                if (ts.isPropertyAssignment(p)) entries.push([keyOf(p.name), lower(p.initializer, depth + 1)]);
                else if (ts.isShorthandPropertyAssignment(p)) entries.push([p.name.text, { k: 'ref', name: p.name.text, line: lineOf(p) }]);
                else if (ts.isSpreadAssignment(p)) spread = true;
                else if (ts.isMethodDeclaration(p) && p.name) entries.push([keyOf(p.name), { k: 'func', line: lineOf(p) }]);
            }
            e = { k: 'dict', entries, spread, line };
        } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
            e = { k: 'func', line };
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            e = { k: 'concat', parts: [lower(node.left, depth + 1), lower(node.right, depth + 1)], line };
        } else {
            e = { k: 'opaque', line };
        }
        lowered.set(node, e);
        return e;
    };

    const bind = (key: string, expr: Expr, line: number) => {
        const list = bindings.get(key) ?? [];
        list.push({ line, expr });
        bindings.set(key, list);
    };
    /** `a.b.c` or `this.llm` as a dotted binding key; null for anything else. */
    const dottedKey = (node: ts.Expression): string | null => {
        if (ts.isIdentifier(node)) return node.text;
        if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
            const head = dottedKey(node.expression);
            return head === null ? null : `${head}.${node.name.text}`;
        }
        return null;
    };
    const requiredModule = (init: ts.Expression | undefined): string | null => {
        let node = init;
        while (node && (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression;
        if (node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
            && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
            return node.arguments[0].text;
        }
        return null;
    };
    const qualifyName = (node: ts.Expression): string | null => {
        if (ts.isIdentifier(node)) {
            const q = imports.get(node.text);
            return q ? [q.module, ...q.path].join('.') : null;
        }
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
            const head = qualifyName(node.expression);
            return head === null ? null : `${head}.${node.name.text}`;
        }
        return null;
    };

    // Imports first, so a tool class declared above its import still resolves.
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause) {
            const moduleName = st.moduleSpecifier.text;
            const clause = st.importClause;
            if (clause.name) imports.set(clause.name.text, { module: moduleName, path: ['default'] });
            const named = clause.namedBindings;
            if (named && ts.isNamespaceImport(named)) imports.set(named.name.text, { module: moduleName, path: [] });
            if (named && ts.isNamedImports(named)) {
                for (const el of named.elements) imports.set(el.name.text, { module: moduleName, path: [(el.propertyName ?? el.name).text] });
            }
        }
    }

    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer) {
            const moduleName = requiredModule(node.initializer);
            if (moduleName !== null) {
                if (ts.isIdentifier(node.name)) imports.set(node.name.text, { module: moduleName, path: [] });
                else if (ts.isObjectBindingPattern(node.name)) {
                    for (const el of node.name.elements) {
                        if (!ts.isIdentifier(el.name)) continue;
                        const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
                        imports.set(el.name.text, { module: moduleName, path: [imported] });
                    }
                }
            } else if (ts.isIdentifier(node.name)) {
                const value = lower(node.initializer);
                bind(node.name.text, value, lineOf(node));
                callsWithin(value).forEach((c, i) => calls.push({ call: c, boundTo: i === 0 && value.k === 'call' ? node.name.getText(sf) : null }));
                return ts.forEachChild(node.initializer, skipLowered);
            }
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const key = dottedKey(node.left);
            if (key !== null) {
                const value = lower(node.right);
                bind(key, value, lineOf(node));
                callsWithin(value).forEach((c, i) => calls.push({ call: c, boundTo: i === 0 && value.k === 'call' ? key : null }));
                return ts.forEachChild(node.right, skipLowered);
            }
        }
        if (ts.isPropertyDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
            const value = lower(node.initializer);
            bind(`this.${node.name.text}`, value, lineOf(node));
            callsWithin(value).forEach((c, i) => calls.push({ call: c, boundTo: i === 0 && value.k === 'call' ? `this.${node.name.getText(sf)}` : null }));
            return ts.forEachChild(node.initializer, skipLowered);
        }
        if (ts.isClassDeclaration(node) && node.name) {
            const extendsClause = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
            const base = extendsClause?.types[0]?.expression;
            const q = base ? qualifyName(base) : null;
            if (q !== null && /^(?:@langchain\/|langchain\/)[\w./-]*\.(?:StructuredTool|Tool|DynamicTool|DynamicStructuredTool)$/.test(q)) {
                const nameMember = node.members.find(
                    (m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'name',
                );
                const declared = nameMember?.initializer;
                const toolName = declared && (ts.isStringLiteral(declared) || ts.isNoSubstitutionTemplateLiteral(declared)) ? declared.text : node.name.text;
                toolDeclarations.set(node.name.text, { line: lineOf(node), toolName });
            }
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const value = lower(node);
            for (const c of callsWithin(value)) calls.push({ call: c, boundTo: null });
            return ts.forEachChild(node, skipLowered);
        }
        ts.forEachChild(node, visit);
    };
    /** Below an expression already lowered: only its function bodies hold statements left to read. */
    const skipLowered = (node: ts.Node): void => {
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
            ts.forEachChild(node, visit);
            return;
        }
        ts.forEachChild(node, skipLowered);
    };
    ts.forEachChild(sf, visit);

    return { language: 'javascript', imports, bindings, toolDeclarations, calls };
}
