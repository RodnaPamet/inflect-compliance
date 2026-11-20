/**
 * The Nucleo icon set stays out of this repository (#5772).
 *
 * Nucleo's licence prohibits redistributing its icons and restricts them to
 * the product they ship in. This repository is public, so committing the set
 * here is redistribution, whatever licence Inflect's own code carries. The set
 * lived at `packages/ui/src/components/ui/icons/nucleo/` (269 icons and a
 * README carrying the notice) until #5772 replaced it with
 * `packages/ui/src/components/ui/icons/glyphs/`: lucide-react icons (ISC)
 * under the local names call sites already used.
 *
 * Two independent detectors, because the set can come back two ways:
 *
 *   1. BY PATH — a directory or file named for Nucleo anywhere outside
 *      `docs/` (prose may name it; code and assets may not).
 *   2. BY CONTENT — the licence notice a Nucleo export carries
 *      (`nucleoapp.com`, `Copyright © Nucleo`), in any tracked text file
 *      outside `docs/`. Catches a copy renamed on the way in.
 *
 * Neither can recognise a single glyph pasted in without its notice; that is
 * a review question, and the glyph set's README says where icons come from.
 *
 * The population is git's (`repoRelativeFiles`), so a worktree or build
 * output can never be scanned by accident.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const SELF = path.relative(REPO_ROOT, __filename).replace(/\\/g, '/');

/** Prose may discuss Nucleo; only code and assets are in scope. */
const inScope = (rel: string): boolean => rel !== SELF && !rel.startsWith('docs/');

const NUCLEO_PATH = /nucleo/i;
const NUCLEO_NOTICE = /nucleoapp\.com|copyright\s+(?:©|\(c\)|&copy;)\s*nucleo/i;

/** Text formats an icon set or its notice could arrive in. */
const TEXT_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.svg', '.css', '.json', '.md', '.txt', '.html', '',
];
const isText = (rel: string): boolean =>
    TEXT_EXTENSIONS.includes(path.extname(rel).toLowerCase());

describe('no Nucleo icon set in the public tree (#5772)', () => {
    const population = repoRelativeFiles().filter(inScope);

    it('the scan reads the repository (not vacuous)', () => {
        expect(population.length).toBeGreaterThan(1000);
        expect(population).toContain('packages/ui/src/components/ui/icons/glyphs/index.ts');
    });

    it('the detectors recognise what they look for, and nothing else', () => {
        expect(NUCLEO_PATH.test('packages/ui/src/components/ui/icons/nucleo/plus.tsx')).toBe(true);
        expect(NUCLEO_PATH.test('packages/ui/src/components/ui/icons/glyphs/plus.tsx')).toBe(false);
        expect(NUCLEO_NOTICE.test('Copyright © Nucleo')).toBe(true);
        expect(NUCLEO_NOTICE.test('https://nucleoapp.com/license')).toBe(true);
        expect(NUCLEO_NOTICE.test('@license lucide-react v1.72.0 - ISC')).toBe(false);
    });

    it('no file or directory outside docs/ is named for Nucleo', () => {
        expect(population.filter((rel) => NUCLEO_PATH.test(rel))).toEqual([]);
    });

    it('no tracked text file outside docs/ carries the Nucleo licence notice', () => {
        const offenders = population.filter((rel) => {
            if (!isText(rel)) return false;
            const abs = path.join(REPO_ROOT, rel);
            // A path can be absent (deleted, not yet committed) or not a
            // regular file (a submodule, a symlinked directory). One read, and
            // its failure is the answer: checking first and reading after is a
            // race (CodeQL js/file-system-race).
            let text: string;
            try {
                text = fs.readFileSync(abs, 'utf8');
            } catch {
                return false;
            }
            return NUCLEO_NOTICE.test(text);
        });
        expect(offenders).toEqual([]);
    });
});
