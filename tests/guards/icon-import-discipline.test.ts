/**
 * Icon-import discipline.
 *
 * The Nucleo icon barrel (`@/components/ui/icons/nucleo`) re-exports
 * hundreds of single-icon modules via `export *`. That tree-shakes ONLY
 * when consumers use NAMED imports (`import { Bell } from …`) — a wildcard
 * (`import * as Icons from …`) or default import forces the whole barrel
 * into the page chunk. `next.config.js` lists the barrel in
 * `optimizePackageImports` for the same reason; this guard keeps every
 * call site on the form that optimization needs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const NUCLEO = '@/components/ui/icons/nucleo';

function tsxFiles(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === '.next') continue;
            tsxFiles(abs, out);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
            out.push(abs);
        }
    }
    return out;
}

describe('icon import discipline', () => {
    const files = tsxFiles(SRC);

    it('the scan found source files (not vacuous)', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it('no wildcard or default import from the Nucleo barrel', () => {
        const offenders: string[] = [];
        // `import * as X from '…/nucleo'`  OR  `import X from '…/nucleo'`
        // (a default import — the barrel has no default export, but a
        // mistaken one would also defeat tree-shaking). Named imports
        // `import { … }` and type-only imports are fine.
        // Slashes need no escaping inside a RegExp built from a string
        // (only regex *literals* treat `/` specially), so embed NUCLEO as-is.
        const wildcard = new RegExp(`import\\s+\\*\\s+as\\s+\\w+\\s+from\\s+['"]${NUCLEO}`);
        const def = new RegExp(`import\\s+\\w+\\s+from\\s+['"]${NUCLEO}`);
        for (const abs of files) {
            const src = codeOf(fs.readFileSync(abs, 'utf8'));
            if (!src.includes(NUCLEO)) continue;
            for (const line of src.split('\n')) {
                const t = line.trim();
                if (t.startsWith('//') || t.startsWith('*')) continue;
                if (wildcard.test(line) || def.test(line)) {
                    offenders.push(`${path.relative(ROOT, abs)}: ${t}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the barrel is registered in optimizePackageImports', () => {
        expect(codeOf(fs.readFileSync(path.join(ROOT, 'next.config.js'), 'utf8'))).toContain(NUCLEO);
    });
});
