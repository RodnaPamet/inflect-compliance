/**
 * The PII detector is constructed in ONE place, and that place is the mount
 * gate (docs/ai-architecture/presidio.md, Phase 1.4).
 *
 * "Mounted only with a passing record" holds only while nothing else can build
 * a Presidio provider: a second importer could construct one from the env and
 * skip the record. So the importers of `presidio-provider` under `src/` are
 * read off the tree (git-backed, `repoRelativeFiles`) and asserted by exact
 * equality — a new importer fails until somebody decides it is a second seam.
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

const ROOT = path.resolve(__dirname, '../..');
const PROVIDER = 'src/lib/ai/pii/presidio-provider.ts';
const code = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/** An import or re-export of the provider module, by alias or relative path. */
const IMPORTS_PROVIDER = /from\s+'(?:@\/lib\/ai\/pii\/|\.\/)presidio-provider'/;

const providerImporters = () =>
    repoRelativeFiles()
        .filter((f) => f.startsWith('src/') && /\.tsx?$/.test(f))
        .filter((f) => IMPORTS_PROVIDER.test(code(f)))
        .sort();

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
    it('only the mount gate imports the Presidio provider', () => {
        expect(providerImporters()).toEqual(['src/lib/ai/pii/mount.ts']);
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

    it('the import pattern sees both spellings, and the fetch pattern sees every alias', () => {
        // Negative controls, on synthetic source, so a clean run above means something.
        expect(IMPORTS_PROVIDER.test("import { x } from '@/lib/ai/pii/presidio-provider';")).toBe(true);
        expect(IMPORTS_PROVIDER.test("export { x } from './presidio-provider';")).toBe(true);
        expect(IMPORTS_PROVIDER.test("import { x } from './presidio-provider-types';")).toBe(false);
        for (const call of ['await fetch(u)', 'resilientFetch(u)', 'boundedFetch (u)']) {
            expect({ call, found: /[\w.]*fetch\w*\s*\(/i.test(call) }).toEqual({ call, found: true });
        }
    });
});
