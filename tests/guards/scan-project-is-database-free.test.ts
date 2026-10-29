/**
 * The `scan` jest project opens no database connection (#4395).
 *
 * That project exists to run the architectural guards, guardrails and API
 * contracts WITHOUT `globalSetup` — the hook that refuses to run when the
 * shared test database is behind the branch's migrations. The refusal is right
 * for anything that connects and was wrong for 809 suites that read files off
 * disk, at a cost of one human hand-off per session per migration.
 *
 * The exchange is that `scan`'s freedom from the hook is only safe while
 * nothing in it connects. One suite does — `tests/guardrails/rls-coverage`,
 * which queries `pg_policies` — and it is excluded from `scan` and runs in
 * `node`, where `globalSetup` provisions the per-worker databases. This keeps
 * that arrangement honest: a suite here that starts connecting fails with a
 * message naming it, rather than timing out against a database nobody set up.
 *
 * ── MEASURED BY IMPORT, NOT BY MENTION ──────────────────────────────────
 *
 * The naive version of this check asks whether the file contains
 * `@/lib/prisma`. That is wrong here in a way worth spelling out, because I
 * got it wrong twice while measuring this very population: dozens of these
 * guards contain that string as a PATTERN THEY GREP FOR — `no-usecase-imports-
 * in-client` is looking for exactly it — and two more `jest.mock` it, which is
 * the opposite of connecting. Counting mentions gave 40 suites and then 16;
 * counting imports gives one. Same mistake as #4356, which was a guard passing
 * on a mention rather than a mount.
 *
 * So the test below matches an IMPORT or REQUIRE of a connecting module, and
 * the `detector proof` block holds it to that: a file that merely names prisma
 * in a regex must NOT be flagged, or this guard would fail on the first
 * honest source scan it met.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface JestProject {
    displayName?: string;
    testMatch?: string[];
    testPathIgnorePatterns?: string[];
}
const jestProjects = (
    require('../../jest.config.js') as { projects: JestProject[] }
).projects;

const ROOT = path.resolve(__dirname, '../..');

/** The directories the `scan` project owns, mirroring its `testMatch`. */
const SCAN_DIRS = ['tests/guards', 'tests/guardrails', 'tests/contracts'];

/** Excluded from `scan` because it connects; runs in `node`. */
const DB_BACKED = 'rls-coverage.test.ts';

/**
 * An IMPORT of something that opens a connection — not a mention of one.
 *
 * `helpers/prisma-schema` is deliberately absent: it `readFileSync`s
 * `prisma/schema.prisma`, a file, and several guards import it.
 */
const CONNECTS = [
    // ANCHORED at column zero. A real top-level import starts the line; every
    // false positive this guard met was import-shaped text INSIDE something:
    //
    //   ai-guard-coverage:225          `import { prisma } from '@/lib/prisma';`
    //                                   — a template-literal fixture fed to a regex
    //   identity-joiner-pass:74        the same, built with `${src}`
    //   audit-s6-vendor-risk:24        `require("@/lib/prisma")` in a describe NAME
    //   audit-immutability-guardrails  /\bprismaTestClient\s*\(/ — in its own regex
    //
    // All four are indented or mid-line, so column-zero anchoring excludes
    // them while still catching every real import. A bare `prismaTestClient(`
    // pattern is deliberately NOT here: you cannot call it without importing
    // it from `helpers/db`, which the second pattern catches, and matching the
    // call matched that guard's regex instead.
    /^(?:import|export)[^;\n]*?\bfrom\s*['"]@\/lib\/prisma['"]/m,
    /^(?:import|export)[^;\n]*?\bfrom\s*['"][^'"\n]*helpers\/db['"]/m,
    /^(?:import|export)[^;\n]*?\bfrom\s*['"]pg['"]/m,
    /^const\s+\w+\s*=\s*require\(\s*['"](?:@\/lib\/prisma|pg)['"]\s*\)/m,
];

function walk(dir: string): string[] {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const out: string[] = [];
    for (const e of fs.readdirSync(abs, { withFileTypes: true, recursive: true } as never) as fs.Dirent[]) {
        if (!e.isFile() || !e.name.endsWith('.test.ts')) continue;
        const parent = (e as unknown as { parentPath?: string; path?: string }).parentPath
            ?? (e as unknown as { path: string }).path;
        out.push(path.join(parent, e.name));
    }
    return out;
}

// This file necessarily contains the patterns it searches for — in the
// detector proof below — so it excludes itself. Everything else is fair game.
const SELF = 'scan-project-is-database-free.test.ts';
const scanFiles = SCAN_DIRS.flatMap(walk)
    .filter((f) => !f.endsWith(DB_BACKED) && !f.endsWith(SELF));

describe('the scan project opens no database connection', () => {
    it('finds the population it is about — otherwise every case below is vacuous', () => {
        // The denominator. A broken walk would report zero offenders and pass.
        expect(scanFiles.length).toBeGreaterThan(700);
    });

    it('no suite in it imports prisma, the db helpers or pg', () => {
        const offenders = scanFiles
            .filter((f) => {
                const src = fs.readFileSync(f, 'utf8');
                return CONNECTS.some((re) => re.test(src));
            })
            .map((f) => path.relative(ROOT, f));

        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} suite(s) in the \`scan\` jest project open a database ` +
                    `connection. That project carries no \`globalSetup\`, so nothing provisions ` +
                    `the per-worker databases they need and they will fail against whatever the ` +
                    `shared database happens to hold.\n\n` +
                    `Either move the suite to the \`node\` project (add it to \`scan\`'s ` +
                    `testPathIgnorePatterns in jest.config.js, as \`${DB_BACKED}\` is), or drop ` +
                    `the connection and read the source instead.\n\n  ` +
                    offenders.join('\n  '),
            );
        }
        expect(offenders).toEqual([]);
    });

    it('the one suite that DOES connect is excluded from scan', () => {
        const all = SCAN_DIRS.flatMap(walk).map((f) => path.basename(f));
        // Present in the directories…
        expect(all).toContain(DB_BACKED);
        // …and not in the project's population.
        expect(scanFiles.map((f) => path.basename(f))).not.toContain(DB_BACKED);
    });

    describe('detector proof', () => {
        const matches = (src: string) => CONNECTS.some((re) => re.test(src));

        it('flags a real import', () => {
            expect(matches("import prisma from '@/lib/prisma';")).toBe(true);
            expect(matches("import { prismaTestClient } from '../helpers/db';")).toBe(true);
        });

        it('does NOT flag a guard that greps for the string', () => {
            // The mistake this guard is written against, and the one I made
            // twice measuring this population.
            expect(matches("const BANNED = /@\\/lib\\/prisma/;")).toBe(false);
            expect(matches("expect(src).toContain('@/lib/prisma');")).toBe(false);
        });

        it('does NOT flag the schema READER, which reads a file', () => {
            expect(matches("import { readPrismaSchema } from '../helpers/prisma-schema';")).toBe(false);
        });

        it('does NOT flag import-shaped text inside a template-literal fixture', () => {
            // ai-guard-coverage:225 and identity-joiner-pass-stays-pure:74,
            // both real suites this guard flagged on its first run.
            expect(matches("        expect(re.test(`import { prisma } from '@/lib/prisma';`)).toBe(false);")).toBe(false);
            expect(matches("const withPrisma = `import { prisma } from '@/lib/prisma';\\n${src}`;")).toBe(false);
        });

        it('does NOT flag a require inside a describe name', () => {
            // audit-s6-vendor-risk:24.
            expect(matches('    describe(\'require("@/lib/prisma") escape retired\', () => {')).toBe(false);
        });

        it('does NOT flag another guard\'s own detector regex', () => {
            // audit-immutability-guardrails:350.
            expect(matches('const BUILDS_REAL_CLIENT = /\\bnew\\s+PrismaClient\\s*\\(|\\bprismaTestClient\\s*\\(/;')).toBe(false);
        });
    });
});

/**
 * ── A PIN BELONGS OUTSIDE THE LIST IT PINS (#4426) ──────────────────────
 *
 * `tests/guardrails/coverage-gate-population.test.ts` pins `scan`'s
 * `testPathIgnorePatterns` by exact equality. Right mechanism, one blind spot
 * it cannot cover from where it sits: a pattern excluding `tests/guardrails/`
 * removes that suite along with everything else in the directory, so the
 * assertion never runs. Measured by mutation while writing this — adding
 * `'tests/guardrails/.*'` to the list below took `scan` from 810 files to 585,
 * jest reported `0 matches` for the pinning suite, and the job stayed green.
 *
 * That is the same shape the docblock in that file records for the CLI flag
 * this list replaced; #4395 moved the lever, not the property.
 *
 * Excluding ALL THREE of scan's directories is caught for free: jest finds no
 * tests and exits 1. So the exposure is PARTIAL exclusion, and a second pin in
 * a different one of the three directories closes it — any single-directory
 * exclusion leaves at least one pin running. The residual case (a deliberate
 * two-directory exclusion) needs a check outside jest entirely, which is what
 * #4426 tracks; nothing here can reach it, because every pin lives inside the
 * population it protects.
 */
describe('the scan project does not exclude its own population', () => {
    const scanProject = jestProjects.find((p) => p.displayName === 'scan');

    it('excludes none of the directories it exists to run', () => {
        // The structural half, which needs no baseline to maintain and no
        // update when a directory is added: a pattern may name a FILE — today
        // `rls-coverage`, the one suite that connects — but never one of the
        // directories in `testMatch`.
        expect(scanProject).toBeDefined();
        const dirs = (scanProject!.testMatch ?? [])
            .map((m) => /tests\/[A-Za-z0-9_-]+/.exec(m)?.[0])
            .filter((d): d is string => typeof d === 'string');
        // Vacuity: testMatch really did yield the three directories.
        expect(dirs).toEqual(['tests/guards', 'tests/guardrails', 'tests/contracts']);

        const offenders = (scanProject!.testPathIgnorePatterns ?? []).filter((pat) =>
            dirs.some((d) => pat.includes(d)),
        );
        expect(offenders).toEqual([]);
    });

    it('carries exactly the allowlisted ignore patterns', () => {
        // The exact-equality half, duplicated here deliberately: this file is
        // in `tests/guards/`, so it still runs when a pattern excludes
        // `tests/guardrails/` and silences the primary pin. Keep the two in
        // step — a change to one that is not mirrored fails the other.
        expect([...(scanProject!.testPathIgnorePatterns ?? [])].sort()).toEqual(
            [
                '<rootDir>/.claude/',
                '<rootDir>/node_modules/',
                'rls-coverage\\.test\\.ts',
            ].sort(),
        );
    });
});
