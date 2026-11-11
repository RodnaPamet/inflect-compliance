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
 * The provider itself may reach the network only through `safeFetch` or the
 * test seam `opts.fetchImpl`; any other fetch-shaped call (`fetch`,
 * `resilientFetch`, `boundedFetch`) is an unguarded path to the host.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

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

const providerFetchCalls = () => code(PROVIDER).match(/[\w.]*fetch\w*\s*\(/gi) ?? [];

describe('the PII detector has one construction seam', () => {
    it('only the mount gate imports the Presidio provider', () => {
        expect(providerImporters()).toEqual(['src/lib/ai/pii/mount.ts']);
    });

    it('the provider reaches the network only through safeFetch or the test seam', () => {
        expect([...new Set(providerFetchCalls())].sort()).toEqual(['opts.fetchImpl(', 'safeFetch(']);
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
