/**
 * The PII detector is constructed in ONE place, and that place is the mount
 * gate (docs/ai-architecture/presidio.md, Phase 1.4).
 *
 * "Mounted only with a passing record" holds only while nothing else can build
 * a Presidio provider: a second importer could construct one from the env and
 * skip the record. So the importers of `presidio-provider` under `src/` are
 * read off the tree (git-backed, `repoRelativeFiles`) and asserted by exact
 * equality — a new importer fails until somebody decides it is a second seam.
 * An importer is any module reference that RESOLVES to the provider — a static
 * import or re-export in any spelling (`@/…`, `./…`, `../pii/…`, either quote),
 * `import x = require(…)`, `require(…)` or `import(…)` — read off the syntax
 * tree (`tests/helpers/module-edges.ts`). A regex over two spellings let a
 * sibling directory's `'../pii/presidio-provider'` through. The mount gate may
 * not re-export the provider either, or it would hand the constructor on.
 *
 * The provider itself reaches the network only through the shared
 * in-deployment dial (`inDeploymentRequest`, G6 as amended 2026-11-12) and
 * makes no fetch-shaped call of its own (`fetch`, `safeFetch`,
 * `resilientFetch`, `boundedFetch`): any one would be a second path to the
 * host, around the address rule. The SSRF guard holds the dial itself.
 *
 * And the mount gate's own options are TEST SEAMS: `baseUrl` and `configHash`
 * would bypass the operator's env, and `root` would point "only a committed
 * record mounts" at any directory. So every reference to `resolvePiiDetector`
 * under `src/` must be a call with NO arguments (or its declaration) — read off
 * the syntax tree, so a rename, an alias or passing the function along counts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import { codeOf } from '../helpers/source-blocks';
import { repoRelativeFiles } from '../helpers/repo-files';
import { moduleEdgesOf, NON_LITERAL_LOAD_SITES, nonLiteralModuleLoads, valueImportersOf } from '../helpers/module-edges';

const ROOT = path.resolve(__dirname, '../..');
const PROVIDER = 'src/lib/ai/pii/presidio-provider.ts';
const code = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const MOUNT = 'src/lib/ai/pii/mount.ts';
const srcTs = () => repoRelativeFiles().filter((f) => f.startsWith('src/') && /\.tsx?$/.test(f));
const readSrc = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every file under `src/` with a value edge to the provider, however it is spelled. */
const providerImporters = () => valueImportersOf(PROVIDER, srcTs());

/** Edges from the mount gate that re-export the provider. */
const mountReExportsOfProvider = () =>
    moduleEdgesOf(MOUNT, readSrc(MOUNT)).filter((e) => e.kind === 'export' && e.target === PROVIDER).map((e) => e.spec);

/** Edges to the provider in a synthetic file, for the negative controls. */
const edgesToProvider = (fileRel: string, src: string) =>
    moduleEdgesOf(fileRel, src).filter((e) => !e.typeOnly && e.target === PROVIDER).map((e) => e.kind);

const RESOLVER = 'resolvePiiDetector';

/** Every use of the resolver in `source` that is not a zero-argument call or its own declaration. */
function resolverMisuses(file: string, source: string): string[] {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    const where = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === RESOLVER) {
            const parent = node.parent;
            const isDeclaration = ts.isFunctionDeclaration(parent) && parent.name === node;
            const isCallee =
                (ts.isCallExpression(parent) && parent.expression === node) ||
                (ts.isPropertyAccessExpression(parent) && parent.name === node && ts.isCallExpression(parent.parent) && parent.parent.expression === parent);
            const call = isCallee ? (ts.isCallExpression(parent) ? parent : (parent.parent as ts.CallExpression)) : null;
            // `import { resolvePiiDetector } from …` without a rename is a binding, not a use.
            const plainImport = ts.isImportSpecifier(parent) && !parent.propertyName;
            if (isDeclaration || plainImport) {
                // fine
            } else if (call && call.arguments.length === 0) {
                // fine: the production call
            } else {
                out.push(`${where(node)} ${call ? 'passes options' : 'is referenced other than by a zero-argument call'}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

const srcResolverMisuses = () =>
    repoRelativeFiles()
        .filter((f) => f.startsWith('src/') && /\.tsx?$/.test(f))
        .flatMap((f) => {
            const source = fs.readFileSync(path.join(ROOT, f), 'utf8');
            return source.includes(RESOLVER) ? resolverMisuses(f, source) : [];
        });

const providerFetchCalls = () => code(PROVIDER).match(/[\w.]*fetch\w*\s*\(/gi) ?? [];

describe('the PII detector has one construction seam', () => {
    it('only the mount gate imports the Presidio provider, and it hands the provider on to nobody', () => {
        expect(providerImporters()).toEqual([MOUNT]);
        expect(mountReExportsOfProvider()).toEqual([]);
    });

    it('no file under src/ loads a module by a name the import scan cannot read', () => {
        const sites = srcTs().filter((f) => nonLiteralModuleLoads(f, readSrc(f)) > 0);
        expect(sites).toEqual(Object.keys(NON_LITERAL_LOAD_SITES).sort());
    });

    it('the importer scan resolves every spelling of a reference to the provider', () => {
        // Negative controls on synthetic source in real directories, so the one
        // importer above means something. Each would have passed the old regex.
        const cases: Array<[string, string, string[]]> = [
            ['src/lib/ai/parsing/x.ts', "import { createPresidioDetector } from '../pii/presidio-provider';", ['import']],
            ['src/lib/ai/x.ts', 'import { createPresidioDetector } from "./pii/presidio-provider";', ['import']],
            ['src/lib/ai/pii/x.ts', "export * from './presidio-provider';", ['export']],
            ['src/x.ts', "const p = require('./lib/ai/pii/presidio-provider');", ['require']],
            ['src/x.ts', "const p = await import('@/lib/ai/pii/presidio-provider');", ['dynamic-import']],
            ['src/lib/ai/pii/x.ts', "import p = require('./presidio-provider');", ['import-equals']],
            ['src/lib/ai/pii/x.ts', "import type { PresidioOptions } from './presidio-provider';", []],
            ['src/lib/ai/pii/x.ts', "import { x } from './presidio-provider-types';", []],
        ];
        for (const [file, src, kinds] of cases) {
            expect({ src, kinds: edgesToProvider(file, src) }).toEqual({ src, kinds });
        }
        expect(nonLiteralModuleLoads('src/x.ts', 'await import(`./pii/${name}`); require(name);')).toBe(2);
    });

    it('the provider reaches the network only through the in-deployment dial', () => {
        expect(providerFetchCalls()).toEqual([]);
        expect(code(PROVIDER).match(/\binDeploymentRequest\s*\(/g) ?? []).toHaveLength(1);
        expect(code(PROVIDER).includes('fetchImpl')).toBe(false);
    });

    it('no caller under src/ passes the mount gate a test seam', () => {
        expect(srcResolverMisuses()).toEqual([]);
    });

    it('the resolver scan sees options, aliases and the function passed along', () => {
        // Negative controls on synthetic source, so the empty list above means something.
        const misuses = (src: string) => resolverMisuses('x.ts', src).length;
        expect(misuses('resolvePiiDetector();')).toBe(0);
        expect(misuses('export function resolvePiiDetector(o = {}) { return o; }')).toBe(0);
        expect(misuses("import { resolvePiiDetector } from './mount';")).toBe(0);
        expect(misuses('resolvePiiDetector({ fetchImpl: resilientFetch });')).toBe(1);
        expect(misuses("resolvePiiDetector({ root: '/tmp' });")).toBe(1);
        expect(misuses('mount.resolvePiiDetector({ root: dir });')).toBe(1);
        expect(misuses("import { resolvePiiDetector as r } from './mount';")).toBe(1);
        expect(misuses('const f = resolvePiiDetector; f({ root });')).toBe(1);
    });

    it('the fetch pattern sees every alias', () => {
        // Negative controls, on synthetic source, so a clean run above means something.
        for (const call of ['await fetch(u)', 'resilientFetch(u)', 'boundedFetch (u)']) {
            expect({ call, found: /[\w.]*fetch\w*\s*\(/i.test(call) }).toEqual({ call, found: true });
        }
    });
});
