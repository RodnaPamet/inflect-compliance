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
 * ── UPDATE 2026-09-30: the CLI is gone, not just unused ──────────────
 *
 * The exemptions all argued the vendored copy was "unreachable because the
 * server never invokes the npm CLI". That is a reason not to SHIP it. Exempting
 * by CVE id meant a new id against the same package re-broke the publish gate
 * with no push at all — which is what CVE-2026-102276 / -102278 did to
 * brace-expansion 5.0.7, taking production off new images for the day.
 *
 * So the runner stage now DELETES the global npm tree. The assertions below
 * gained a second half: the entrypoint must not invoke npm (unchanged), and
 * the image must not contain it. The first is what makes the second safe; the
 * second is what makes the CVE class finite.
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

describe('and the runtime image does not CONTAIN the npm CLI either', () => {
    const DOCKERFILE = path.join(ROOT, 'Dockerfile');

    /**
     * The runner stage only. The builder legitimately needs npm (`npm ci`,
     * `npm run build`), and Trivy scans the final image, so bounding the read
     * to the last `FROM` is what makes these assertions about the thing that
     * ships rather than about the whole file.
     */
    function runnerStage(): string {
        const src = fs.readFileSync(DOCKERFILE, 'utf8');
        const at = src.lastIndexOf('FROM node:');
        if (at < 0) throw new Error('no runner FROM found in Dockerfile');
        // Comments stripped, for the same reason `codeOf` exists for the
        // TypeScript guards — and here it is the mirror image of the usual
        // hazard. This stage's comment EXPLAINS what was removed and quotes
        // `npm install -g npm@<pin>` while doing so, which made the negative
        // assertion below match prose rather than an instruction. A guard that
        // reddens when you document the fix is one people delete.
        return src
            .slice(at)
            .split('\n')
            .filter((l) => !l.trimStart().startsWith('#'))
            .join('\n');
    }

    it('has a runner stage to check (positive control)', () => {
        // Without this, a renamed base image would make every assertion below
        // read an empty string — and `not.toMatch` passes on empty.
        const stage = runnerStage();
        expect(stage.length).toBeGreaterThan(200);
        expect(stage).toContain('ENTRYPOINT');
    });

    it('deletes the global npm tree', () => {
        expect(runnerStage()).toMatch(/rm -rf[\s\S]{0,200}\/usr\/local\/lib\/node_modules\/npm\b/);
    });

    it('removes the npm and npx shims, not just the library tree', () => {
        // Leaving the bin symlinks would make `command -v npm` succeed and
        // point at nothing — a worse state than either extreme.
        const stage = runnerStage();
        expect(stage).toContain('/usr/local/bin/npm');
        expect(stage).toContain('/usr/local/bin/npx');
    });

    it('fails the BUILD if npm survives the removal', () => {
        // The `rm -rf` is the action; this is the verification. A future base
        // image that relocates npm would otherwise leave it installed and the
        // publish gate would start failing again with no diff to explain it.
        const stage = runnerStage();
        expect(stage).toMatch(/!\s*command -v npm/);
        expect(stage).toMatch(/!\s*command -v npx/);
    });

    it('no longer installs a pinned global npm', () => {
        // The thing this replaced. Re-adding it would reintroduce the vendored
        // tree and, with it, the per-CVE exemption treadmill.
        expect(runnerStage()).not.toMatch(/npm\s+(install|i)\s+-g\s+npm@/);
    });

    it('detects a reintroduced global install (regression proof)', () => {
        // Teeth for the negative above, which an empty read would satisfy.
        const mutated = 'FROM node:24-alpine AS runner\nRUN npm install -g npm@12.0.1\nENTRYPOINT ["x"]';
        expect(/npm\s+(install|i)\s+-g\s+npm@/.test(mutated)).toBe(true);
    });
});
