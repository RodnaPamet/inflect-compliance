/**
 * Reading a module's export surface and a `jest.mock` factory's keys — with
 * the TypeScript parser, not a regular expression (#2897).
 *
 * Two hand-rolled regex versions of this produced numbers that could not be
 * defended. The first counted comment text as export names, so a factory's
 * "missing exports" came back as `// R18-PR10 — periodic sheen-sweep loop`.
 * The second reported `0/6 exports` for factories that plainly supply keys.
 * Both were wrong in the direction of looking alarming, which is the worst
 * direction for a number a ratchet is pinned to.
 *
 * `typescript` is already a dependency and answers both questions exactly, so
 * the measurement stopped being an approximation.
 */
import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sourceFile = (file: string): ts.SourceFile =>
    ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

const isExported = (n: ts.Node): boolean =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);

/**
 * The VALUE exports of a module. Types are erased before a mock ever runs, so
 * a factory that omits one omits nothing.
 */
export function valueExportsOf(file: string): Set<string> {
    const out = new Set<string>();
    sourceFile(file).forEachChild((n) => {
        if (ts.isFunctionDeclaration(n) && isExported(n) && n.name) out.add(n.name.text);
        else if (ts.isClassDeclaration(n) && isExported(n) && n.name) out.add(n.name.text);
        else if (ts.isEnumDeclaration(n) && isExported(n)) out.add(n.name.text);
        else if (ts.isVariableStatement(n) && isExported(n)) {
            for (const d of n.declarationList.declarations) {
                if (ts.isIdentifier(d.name)) out.add(d.name.text);
            }
        } else if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.exportClause) {
            if (ts.isNamedExports(n.exportClause)) {
                for (const e of n.exportClause.elements) {
                    if (!e.isTypeOnly) out.add(e.name.text);
                }
            }
        }
    });
    return out;
}

export interface MockFactory {
    readonly moduleId: string;
    /** Top-level keys of the returned object literal, or null if not one. */
    readonly keys: ReadonlySet<string> | null;
    /** Whether the factory defers to the real module in any form. */
    readonly defersToReal: boolean;
}

/** Every `jest.mock('<id>', () => …)` in a test file. */
export function mockFactoriesIn(file: string): MockFactory[] {
    const sf = sourceFile(file);
    const found: MockFactory[] = [];

    const keysOf = (obj: ts.ObjectLiteralExpression): Set<string> => {
        const k = new Set<string>();
        for (const p of obj.properties) {
            if (ts.isSpreadAssignment(p)) continue;
            const nm = p.name;
            if (nm && (ts.isIdentifier(nm) || ts.isStringLiteral(nm))) k.add(nm.text);
        }
        return k;
    };

    const visit = (n: ts.Node): void => {
        if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.name.text === 'mock' &&
            ts.isIdentifier(n.expression.expression) &&
            n.expression.expression.text === 'jest' &&
            n.arguments.length >= 2 &&
            ts.isStringLiteral(n.arguments[0])
        ) {
            const factory = n.arguments[1];
            let obj: ts.ObjectLiteralExpression | null = null;
            if (ts.isArrowFunction(factory)) {
                const b = factory.body;
                if (ts.isObjectLiteralExpression(b)) obj = b;
                else if (ts.isParenthesizedExpression(b) && ts.isObjectLiteralExpression(b.expression)) {
                    obj = b.expression;
                }
            }
            const text = factory.getText(sf);
            found.push({
                moduleId: (n.arguments[0] as ts.StringLiteral).text,
                keys: obj ? keysOf(obj) : null,
                defersToReal: /requireActual|strictMock/.test(text),
            });
        }
        n.forEachChild(visit);
    };
    sf.forEachChild(visit);
    return found;
}

/** `@/x/y` → the file it resolves to, or null when it is not repo source. */
export function resolveAliasedModule(root: string, moduleId: string): string | null {
    if (!moduleId.startsWith('@/')) return null;
    const base = path.join(root, 'src', moduleId.slice(2));
    for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}
