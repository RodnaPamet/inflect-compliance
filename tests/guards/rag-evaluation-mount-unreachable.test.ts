/**
 * GUARD — the Ragas answer stage's mount decision cannot be reached by a
 * deployed app (Ragas Phase 1.2; `src/app-layer/services/rag-evaluation-mount.ts`).
 *
 * The `search_knowledge` gate opens on a committed, passing record. The one
 * other way it answers MOUNTED is the evaluation's own scope, which the answer
 * stage opens for the run that produces the first record. The owner's rule for
 * that seam: no gate bypass may exist in a deployed app. This guard holds it as
 * a property of the IMPORT GRAPH and the CALL SITES, read with the TypeScript
 * parser (never a regex over source text), over every git-listed module:
 *
 *   1. The opener (`withRagEvaluationMount`) is named only under
 *      `scripts/rag-eval/` and `tests/`. Inside `src/` the module is imported
 *      by the gate alone, by name, for its reader — no namespace import, no
 *      re-export, no dynamic import, no `require`.
 *   2. Nothing under `src/` imports anything under `scripts/`, and no app
 *      entry point — a route, a page, a layout, the middleware, the
 *      instrumentation hook, the worker, the scheduler — reaches
 *      `scripts/rag-eval/` through its import closure.
 *   3. The two other seams the stage uses are not passed by production either:
 *      every call of `askAssistant` under `src/` passes two arguments (the
 *      third is the model-client seam), and every `new AnthropicAssistantProvider`
 *      under `src/` passes at most two (the third is the endpoint).
 *
 * Behind the graph, a production process refuses the scope at both ends
 * (`tests/unit/rag-eval-answer-stage.test.ts` holds that).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import { REPO_ROOT, repoFiles, repoRelative } from '../helpers/repo-files';

const SEAM = 'src/app-layer/services/rag-evaluation-mount.ts';
const GATE = 'src/app-layer/services/knowledge-search-mount.ts';
const OPENER = 'withRagEvaluationMount';
const READER = 'ragEvaluationMountInScope';
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

interface ModuleRef {
    /** Repo-relative path of the module referenced, or null when it is a package. */
    readonly target: string | null;
    readonly specifier: string;
    readonly kind: 'import' | 'export-from' | 'dynamic-import' | 'require';
    /** Names bound from it; '*' for a namespace or default binding, a re-export of all, or a dynamic load. */
    readonly names: readonly string[];
}

interface ParsedModule {
    readonly rel: string;
    readonly refs: readonly ModuleRef[];
    readonly identifiers: ReadonlySet<string>;
    readonly calls: ReadonlyArray<{ readonly callee: string; readonly args: number; readonly isNew: boolean; readonly line: number }>;
}

function resolveSpecifier(fromRel: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(REPO_ROOT, 'src', spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(REPO_ROOT, path.dirname(fromRel), spec);
    else return null;
    const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => path.join(base, `index${e}`))];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return repoRelative(c);
    }
    return null;
}

export function parseModule(rel: string, text: string): ParsedModule {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const refs: ModuleRef[] = [];
    const identifiers = new Set<string>();
    const calls: Array<{ callee: string; args: number; isNew: boolean; line: number }> = [];
    const ref = (specifier: string, kind: ModuleRef['kind'], names: string[]) =>
        refs.push({ target: resolveSpecifier(rel, specifier), specifier, kind, names });
    const calleeName = (e: ts.Expression): string | null =>
        ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;

    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) identifiers.add(node.text);
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const names: string[] = [];
            const clause = node.importClause;
            if (clause?.name) names.push('*');
            const bindings = clause?.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
            if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) names.push((e.propertyName ?? e.name).text);
            ref(node.moduleSpecifier.text, 'import', names);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            const names =
                node.exportClause && ts.isNamedExports(node.exportClause)
                    ? node.exportClause.elements.map((e) => (e.propertyName ?? e.name).text)
                    : ['*'];
            ref(node.moduleSpecifier.text, 'export-from', names);
        } else if (ts.isCallExpression(node)) {
            const [first] = node.arguments;
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword && first && ts.isStringLiteralLike(first)) {
                ref(first.text, 'dynamic-import', ['*']);
            } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && first && ts.isStringLiteralLike(first)) {
                ref(first.text, 'require', ['*']);
            }
            const name = calleeName(node.expression);
            if (name) calls.push({ callee: name, args: node.arguments.length, isNew: false, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
        } else if (ts.isNewExpression(node)) {
            const name = calleeName(node.expression);
            if (name) calls.push({ callee: name, args: node.arguments?.length ?? 0, isNew: true, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return { rel, refs, identifiers, calls };
}

const MODULES: ReadonlyMap<string, ParsedModule> = new Map(
    [...repoFiles({ under: 'src', extensions: EXTENSIONS }), ...repoFiles({ under: 'scripts', extensions: EXTENSIONS })]
        .filter((abs) => !abs.endsWith('.d.ts') && fs.existsSync(abs))
        .map((abs) => {
            const rel = repoRelative(abs);
            return [rel, parseModule(rel, fs.readFileSync(abs, 'utf8'))] as const;
        }),
);

const inSrc = (rel: string) => rel.startsWith('src/');

/** Every module reachable from `entry` through any import, re-export, dynamic import or require. */
function closure(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
        const rel = stack.pop()!;
        if (seen.has(rel)) continue;
        seen.add(rel);
        for (const r of MODULES.get(rel)?.refs ?? []) if (r.target && MODULES.has(r.target)) stack.push(r.target);
    }
    return seen;
}

const ENTRY_POINT = /^src\/app\/.*\/(route|page|layout|template|loading|error|not-found|default)\.(ts|tsx)$|^src\/app\/(page|layout|not-found|error|global-error)\.(ts|tsx)$/;
const ENTRY_POINTS = [
    ...[...MODULES.keys()].filter((rel) => ENTRY_POINT.test(rel)),
    'src/middleware.ts',
    'src/instrumentation.ts',
    'scripts/worker.ts',
    'scripts/scheduler.ts',
];

describe('the Ragas evaluation mount is unreachable from a deployed app', () => {
    it('reads a real population (a collapse would pass everything below vacuously)', () => {
        expect(MODULES.size).toBeGreaterThan(1000);
        expect(MODULES.has(SEAM)).toBe(true);
        expect(MODULES.has(GATE)).toBe(true);
        expect(ENTRY_POINTS.filter((e) => e.includes('/route.')).length).toBeGreaterThan(200);
        for (const e of ['src/middleware.ts', 'src/instrumentation.ts', 'scripts/worker.ts', 'scripts/scheduler.ts']) expect(MODULES.has(e)).toBe(true);
    });

    it('inside src/, only the gate imports the seam, and only its reader, by name', () => {
        const importers = [...MODULES.values()]
            .filter((m) => inSrc(m.rel))
            .flatMap((m) => m.refs.filter((r) => r.target === SEAM).map((r) => ({ rel: m.rel, kind: r.kind, names: [...r.names] })));
        expect(importers).toEqual([{ rel: GATE, kind: 'import', names: expect.arrayContaining([READER]) }]);
        expect(importers[0].names.every((n) => n === READER || n === 'RagEvaluationMount')).toBe(true);
    });

    it('the opener is named only by the answer stage and the tests', () => {
        const naming = [...MODULES.values()].filter((m) => m.rel !== SEAM && m.identifiers.has(OPENER)).map((m) => m.rel);
        expect(naming.length).toBeGreaterThan(0);
        expect(naming.filter((rel) => !rel.startsWith('scripts/rag-eval/'))).toEqual([]);
    });

    it('nothing under src/ imports anything under scripts/', () => {
        const crossing = [...MODULES.values()]
            .filter((m) => inSrc(m.rel))
            .flatMap((m) => m.refs.filter((r) => r.target?.startsWith('scripts/')).map((r) => `${m.rel} -> ${r.target}`));
        expect(crossing).toEqual([]);
    });

    it('no app entry point reaches the answer stage', () => {
        const reaching = ENTRY_POINTS.filter((e) => [...closure(e)].some((rel) => rel.startsWith('scripts/rag-eval/')));
        expect(reaching).toEqual([]);
        // The stage itself does reach the seam: the walk sees what it is looking for.
        expect(closure('scripts/rag-eval/answer.ts').has(SEAM)).toBe(true);
    });

    it('production passes neither model-client seam: askAssistant takes two arguments, the provider at most two', () => {
        const offending = [...MODULES.values()]
            .filter((m) => inSrc(m.rel))
            .flatMap((m) =>
                m.calls
                    .filter((c) => (!c.isNew && c.callee === 'askAssistant' && c.args !== 2) || (c.isNew && c.callee === 'AnthropicAssistantProvider' && c.args > 2))
                    .map((c) => `${m.rel}:${c.line} ${c.isNew ? 'new ' : ''}${c.callee}(${c.args} args)`),
            );
        expect(offending).toEqual([]);
        // The population is real: the route calls askAssistant, the factory constructs the provider.
        const sites = [...MODULES.values()].filter((m) => inSrc(m.rel)).flatMap((m) => m.calls.filter((c) => ['askAssistant', 'AnthropicAssistantProvider'].includes(c.callee)));
        expect(sites.some((c) => c.callee === 'askAssistant')).toBe(true);
        expect(sites.some((c) => c.callee === 'AnthropicAssistantProvider' && c.isNew)).toBe(true);
    });

    it('the reader sees what it guards against (a planted route is caught)', () => {
        const route = 'src/app/api/t/[tenantSlug]/planted/route.ts';
        const planted = parseModule(
            route,
            [
                "import { withRagEvaluationMount } from '@/app-layer/services/rag-evaluation-mount';",
                "import * as seam from '@/app-layer/services/rag-evaluation-mount';",
                "export const POST = () => askAssistant(ctx, body, { turnProvider });",
                "const p = new AnthropicAssistantProvider(k, w, url);",
                "void import('../../../../../../scripts/rag-eval/answer');",
            ].join('\n'),
        );
        expect(planted.identifiers.has(OPENER)).toBe(true);
        expect(planted.refs.filter((r) => r.target === SEAM).map((r) => r.names)).toEqual([[OPENER], ['*']]);
        expect(planted.calls.find((c) => c.callee === 'askAssistant')?.args).toBe(3);
        expect(planted.calls.find((c) => c.callee === 'AnthropicAssistantProvider')?.args).toBe(3);
        expect(planted.refs.some((r) => r.kind === 'dynamic-import' && r.target === 'scripts/rag-eval/answer.ts')).toBe(true);
    });
});
