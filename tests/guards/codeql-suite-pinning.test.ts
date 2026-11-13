/**
 * CodeQL query-suite pinning — structural ratchet.
 *
 * The CodeQL workflow runs whatever suite `codeql-config.yml`'s
 * `queries:` declares. The two practical choices today:
 *
 *   - `security-extended`      — security-only queries.
 *   - `security-and-quality`   — strict superset: every security
 *                                query AND the maintainability suite
 *                                (`js/unused-local-variable`,
 *                                `js/useless-assignment-to-local`,
 *                                …). Populates GitHub's "Code quality
 *                                / Standard findings" tab.
 *
 * The repo committed to `security-and-quality` because the quality
 * findings get the same triage rigour as the security ones (fix, or
 * `dismissed_reason` + substantive comment). A future "shrink the
 * suite to speed CI" revert would silently re-hide every quality
 * alert — including the ones we've already fixed and the ones a
 * future contributor would otherwise have caught.
 *
 * This guard fails CI if `queries:` drops below
 * `security-and-quality` — the ratchet that holds the suite choice
 * structurally rather than by convention.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const CONFIG_PATH = path.resolve(
    __dirname,
    '../../.github/codeql/codeql-config.yml',
);

/**
 * Suites that satisfy the bar. `security-and-quality` is the current
 * commitment. A future broader bundled suite (e.g. a hypothetical
 * `security-and-quality-extended`) would be acceptable — add it
 * here in the same PR that switches the config.
 */
const ACCEPTED_SUITES: ReadonlyArray<string> = ['security-and-quality'];

/**
 * Suites that are explicitly NOT enough. Listed so the failure
 * message can name the regression precisely.
 */
const REJECTED_SUITES: ReadonlyArray<string> = [
    'security-extended',
    'security',
    'code-scanning',
    'default',
];

describe('CodeQL query-suite pinning', () => {
    it('codeql-config.yml exists', () => {
        expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    });

    it('declares a `queries:` block', () => {
        const src = fs.readFileSync(CONFIG_PATH, 'utf8');
        expect(src).toMatch(/^queries:/m);
    });

    it('uses an accepted query suite (security-and-quality)', () => {
        const src = fs.readFileSync(CONFIG_PATH, 'utf8');

        // The `uses:` line under `queries:` carries the suite name.
        const usesMatches = Array.from(
            src.matchAll(/^\s*-\s*uses:\s*([A-Za-z0-9_-]+)\s*$/gm),
        ).map((m) => m[1]);

        expect(usesMatches.length).toBeGreaterThan(0);

        for (const suite of usesMatches) {
            const accepted = ACCEPTED_SUITES.includes(suite);
            const rejected = REJECTED_SUITES.includes(suite);

            if (!accepted) {
                throw new Error(
                    rejected
                        ? `codeql-config.yml uses '${suite}' — that suite is a regression from '${ACCEPTED_SUITES[0]}'. ` +
                          `Switching back to a narrower suite silently re-hides every quality finding the broader suite populates. ` +
                          `If this is intentional (e.g. a documented CI-time tradeoff), update ACCEPTED_SUITES in tests/guards/codeql-suite-pinning.test.ts in the same PR.`
                        : `codeql-config.yml uses '${suite}' — unknown suite; add it to ACCEPTED_SUITES or REJECTED_SUITES so this ratchet can reason about it.`,
                );
            }
        }
    });

    it('config name reflects the suite (helps GH match runs to config)', () => {
        const src = fs.readFileSync(CONFIG_PATH, 'utf8');
        // The header `name:` is shown in the Code Scanning UI. Keep
        // it in sync with the suite so the UI label tells the truth.
        const nameMatch = src.match(/^name:\s*"([^"]+)"/m);
        expect(nameMatch).not.toBeNull();
        expect(nameMatch![1]).toContain('security-and-quality');
    });
});

/**
 * Every workspace package is in the scan (#5086).
 *
 * `paths:` listed `src`, `tests` and `scripts`, so nothing under `packages/`
 * was analysed: the agent-harness scanner (which runs in a client's estate
 * with a signing key) and the shared UI package carried no alerts because
 * they were never read, and the merge-queue SAST gate passed them. The
 * population is the package directories git tracks, not a list kept here.
 */
describe('CodeQL scans every workspace package (#5086)', () => {
    const scanned = (): string[] => {
        const src = fs.readFileSync(CONFIG_PATH, 'utf8');
        const block = /^paths:\n((?:[ \t]+(?:-.*|#.*)\n)+)/m.exec(src)?.[1] ?? '';
        return block
            .split('\n')
            .map((l) => /^\s+-\s+"?([^"#\s]+)"?/.exec(l)?.[1])
            .filter((p): p is string => Boolean(p));
    };
    const packages = (): string[] => {
        const root = path.resolve(__dirname, '../..');
        return fs
            .readdirSync(path.join(root, 'packages'), { withFileTypes: true })
            .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, 'packages', d.name, 'package.json')))
            .map((d) => `packages/${d.name}`);
    };

    it('reads the paths block and finds the packages (positive control)', () => {
        expect(scanned()).toEqual(expect.arrayContaining(['src', 'tests', 'scripts']));
        expect(packages().length).toBeGreaterThanOrEqual(3);
    });

    it('every package directory sits under a scanned path', () => {
        const paths = scanned();
        const unscanned = packages().filter((pkg) => !paths.some((p) => pkg === p || pkg.startsWith(`${p}/`)));
        expect(unscanned).toEqual([]);
    });
});
