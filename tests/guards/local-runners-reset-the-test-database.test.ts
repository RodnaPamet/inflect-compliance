/**
 * #5641 — the two local runners must agree about which database they reset,
 * and must not pass a Prisma flag the installed CLI rejects.
 *
 * `scripts/ci-local.mjs` and `scripts/e2e-local.mjs` both run
 * `prisma migrate reset --force` against "the test database". That URL is
 * resolved by `prisma.config.ts` from `DIRECT_DATABASE_URL ?? DATABASE_URL`,
 * and `ci-local.mjs` set `DATABASE_URL` and `DATABASE_URL_TEST` but NOT
 * `DIRECT_DATABASE_URL` — so with one exported in the developer's shell (and
 * `.env.example` ships one pointing at the dev database) `--force` dropped it
 * without a prompt.
 *
 * It was invisible because the step died first on `--skip-seed`, removed in
 * Prisma 7. Fixing that alone would have made the command work against the
 * wrong database, which is why both halves and this guard are one change.
 *
 * Assertions are exact equalities over parsed lists rather than substring
 * searches, so a failure names the offending flag or variable and the
 * assertion's reach is the list rather than a whole file.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf-8');

const RUNNERS = ['scripts/ci-local.mjs', 'scripts/e2e-local.mjs'] as const;

/** The DB variables a runner's `env = { … }` block assigns to TEST_DB_URL. */
function dbEnvAssignments(src: string): string[] {
    const block = /const env = \{([\s\S]*?)\n\};/.exec(src);
    if (!block) throw new Error('no `const env = {…}` block found');
    return [...block[1].matchAll(/^\s*([A-Z_]+):\s*TEST_DB_URL,/gm)].map((m) => m[1]).sort();
}

/** Every `--flag` a runner passes to `prisma migrate reset`. */
function migrateResetFlags(src: string): string[] {
    const calls = [...codeOf(src).matchAll(/prisma migrate reset([^'"`]*)/g)].map((m) => m[1]);
    return [...new Set(calls.flatMap((c) => [...c.matchAll(/--[a-z-]+/g)].map((m) => m[0])))].sort();
}

describe('#5641 — both local runners reset the TEST database', () => {
    const EXPECTED_DB_VARS = ['DATABASE_URL', 'DATABASE_URL_TEST', 'DIRECT_DATABASE_URL'];

    it.each(RUNNERS)('%s points all three DB variables at the test database', (rel) => {
        // Exact set, not a membership check: an extra or missing variable is
        // as much a finding as the one that was absent, and the failure names
        // which.
        expect(dbEnvAssignments(read(rel))).toEqual(EXPECTED_DB_VARS);
    });

    it('the two runners assign the SAME set', () => {
        // They reset the same database. One of them doing it through a
        // different URL is the whole defect.
        const [ciLocal, e2eLocal] = RUNNERS.map((rel) => dbEnvAssignments(read(rel)));
        expect(ciLocal).toEqual(e2eLocal);
    });

    it('neither runner trusts an inherited DIRECT_DATABASE_URL', () => {
        // `...process.env` is spread first in both, so the assignment must
        // come AFTER it to win. A reorder would silently restore the bug and
        // is invisible to the set comparison above.
        const wrongOrder = RUNNERS.filter((rel) => {
            const block = /const env = \{([\s\S]*?)\n\};/.exec(read(rel))![1];
            return block.indexOf('...process.env') > block.indexOf('DIRECT_DATABASE_URL:');
        });
        expect(wrongOrder).toEqual([]);
    });
});

describe('#5641 — no runner passes a flag the installed Prisma rejects', () => {
    // Checked against the INSTALLED CLI rather than a hand-maintained list, so
    // this keeps working across a Prisma upgrade instead of going stale the way
    // `--skip-seed` did. `--help` only; nothing here resets anything.
    const help = execFileSync('npx', ['prisma', 'migrate', 'reset', '--help'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120_000,
    });
    const helpFlags = [...new Set([...help.matchAll(/--[a-z-]+/g)].map((m) => m[0]))].sort();

    it('the help text was actually read (positive control)', () => {
        // Without this, an empty or failed help read would make every case
        // below pass vacuously — a set difference against nothing is empty.
        //
        // `--force` is asserted present rather than the whole set pinned: the
        // set is Prisma's and would make this brittle across an upgrade, which
        // is the staleness this guard exists to avoid. (Measured on 7.10.1:
        // --config, --force, --help, --schema. The first draft of this case
        // asserted only --force and failed, which is the control working.)
        expect(helpFlags.filter((f) => f === '--force')).toEqual(['--force']);
        expect(helpFlags.length).toBeGreaterThan(1);
    });

    it.each(RUNNERS)('every migrate-reset flag in %s is one that CLI accepts', (rel) => {
        const used = migrateResetFlags(read(rel));
        expect(used.length).toBeGreaterThan(0);
        // The difference, so a failure names the rejected flag rather than
        // just going red.
        expect(used.filter((f) => !helpFlags.includes(f))).toEqual([]);
    });

    it('--skip-seed specifically is gone, and stays gone', () => {
        // Named rather than left to the general rule: it is the flag that
        // broke, and the one a copy-paste from an older project restores.
        //
        // Comments MASKED at the read seam — the first run of this case failed
        // on the comment in ci-local.mjs explaining the removal. A comment
        // naming a pattern is usually evidence it was taken OUT, so an
        // unmasked absence check reads the scar as the wound.
        expect(helpFlags.includes('--skip-seed')).toBe(false);
        expect(RUNNERS.filter((rel) => codeOf(read(rel)).includes('--skip-seed'))).toEqual([]);
    });
});
