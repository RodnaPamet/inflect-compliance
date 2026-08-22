/**
 * Nothing in the RUNNER invokes the npm CLI.
 *
 * This exists to hold up a `.trivyignore` entry, which is why it is a guard
 * over a shell script rather than a test of behaviour.
 *
 * CVE-2026-73566 (HIGH) affects tar 7.5.19, which reaches the image only as
 * the global npm CLI's bundled copy. The exemption's justification is that
 * nothing at runtime invokes npm, so the vulnerable extractor is never
 * reached. That was NOT true until 2026-08-22: the entrypoint ran
 * `npx --yes prisma@7.8.0`, and because the pinned version differed from the
 * installed one, npx went to the registry and tar-extracted the download on
 * every container start. The artefact was observable on the production
 * container at `~/.npm/_npx/<hash>/node_modules/prisma`.
 *
 * So the exemption is CONDITIONAL on a property of this script, and a
 * justification that depends on a condition nothing checks is the failure
 * mode this repo keeps finding. If the entrypoint reverts to npx, or any
 * runtime path shells out to npm, this test fails and the exemption must be
 * withdrawn — not rewritten to match the new reality.
 *
 * Deliberately NOT asserting the reverse ("the local binary is used"): that
 * is the fix, not the invariant. The invariant is the absence of a fetch.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const ENTRYPOINT = path.join(ROOT, 'scripts/entrypoint.sh');

/** Script lines with comments and blank lines removed. */
function executableLines(file: string): string[] {
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
}

describe('the container runner never invokes the npm CLI', () => {
    it('has an entrypoint to check (positive control)', () => {
        // Without this, deleting or renaming the script would make every
        // assertion below vacuously true — an absent file invokes nothing.
        expect(fs.existsSync(ENTRYPOINT)).toBe(true);
        expect(executableLines(ENTRYPOINT).length).toBeGreaterThan(5);
    });

    it('runs the prisma CLI from node_modules, not from the registry', () => {
        const lines = executableLines(ENTRYPOINT);
        const migrate = lines.filter((l) => l.includes('migrate deploy'));

        // Positive companion: the migration step still exists. A future edit
        // that deletes it would otherwise pass the npx assertion below while
        // silently dropping migrations on deploy.
        expect(migrate.length).toBeGreaterThan(0);
        for (const line of migrate) {
            expect(line).toContain('node_modules/.bin/prisma');
        }
    });

    it('shells out to neither npx nor npm anywhere in the entrypoint', () => {
        const offenders = executableLines(ENTRYPOINT).filter((l) =>
            /(^|[\s;&|(])(npx|npm)\s/.test(l),
        );
        expect(offenders).toEqual([]);
    });

    it('detects a reintroduced fetch (regression proof)', () => {
        // The assertion above is a "no offenders" check, so prove the detector
        // is alive rather than trusting an empty list.
        const mutated = ['set -e', 'npx --yes prisma@7.8.0 migrate deploy', 'exec node_modules/.bin/next start'];
        const offenders = mutated.filter((l) => /(^|[\s;&|(])(npx|npm)\s/.test(l));
        expect(offenders).toHaveLength(1);
    });
});
