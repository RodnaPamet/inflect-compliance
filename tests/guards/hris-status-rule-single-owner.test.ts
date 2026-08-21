/**
 * "Dates beat the status string" must have exactly ONE implementation.
 *
 * It had two, written months apart by different hands, and they disagreed. The
 * Workday mapper was fixed in #2012 after it was found returning on a `terminat`
 * token before ever reading the termination date; BambooHR carried the identical
 * inversion and was not fixed, because nothing connected the two. A third HRIS
 * provider would have written a third copy and had a one-in-two chance of
 * getting the ordering wrong again.
 *
 * The failure mode is what makes this worth a guard rather than a code review:
 * a mis-ordered mapper produces a plausible status for every row, so nothing
 * errors, nothing looks wrong, and the consequence only appears once the JML
 * leaver pass disables the wrong person's account.
 *
 * This is not a shape-of-the-diff ratchet. It fires on a real future event —
 * somebody adding a Gusto or Rippling mapper and hand-rolling the token
 * matching instead of calling the shared rule.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const PROVIDERS = path.join(ROOT, 'src/app-layer/integrations/providers');
const OWNER = 'src/app-layer/integrations/providers/hris/employment-status.ts';

/** Strip comments so prose quoting a token is not mistaken for code. */
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The employment-status token matching, in any quoting style. */
const STATUS_TOKEN = /includes\(\s*['"`](?:terminat|leave|pre-hire|prehire|onboard)/;

function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return e.isFile() && full.endsWith('.ts') ? [full] : [];
    });
}

describe('the HRIS employment-status rule has one owner', () => {
    const files = walk(PROVIDERS).map((f) => path.relative(ROOT, f));

    it('the owner really does hold the token matching — so the detector below is bound to something', () => {
        // Without this, a broken regex would make every `not.toMatch` below
        // pass while checking nothing.
        expect(files).toContain(OWNER);
        expect(codeOnly(fs.readFileSync(path.join(ROOT, OWNER), 'utf8'))).toMatch(STATUS_TOKEN);
    });

    it('no other provider re-derives it', () => {
        const offenders = files.filter(
            (f) => f !== OWNER && STATUS_TOKEN.test(codeOnly(fs.readFileSync(path.join(ROOT, f), 'utf8'))),
        );
        expect(offenders).toEqual([]);
    });

    it('both HRIS mappers call the shared rule rather than deciding for themselves', () => {
        for (const mapper of [
            'src/app-layer/integrations/providers/hris/index.ts',
            'src/app-layer/integrations/providers/workday/roster.ts',
        ]) {
            const src = codeOnly(fs.readFileSync(path.join(ROOT, mapper), 'utf8'));
            expect(src).toMatch(/deriveEmploymentStatus\s*\(/);
        }
    });
});
