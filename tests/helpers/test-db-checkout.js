/**
 * Which checkout a test run belongs to, and where that checkout keeps its
 * per-worker database marker.
 *
 * ─── Why this is its own CommonJS module ─────────────────────────────
 *
 * Two kinds of reader need these values, and they must agree byte for byte:
 *
 *   - `tests/helpers/db.ts`, which re-exports everything here. globalSetup
 *     (writes the marker), globalTeardown (reads and deletes it), the test
 *     client (`getTestDatabaseUrl`) and `scripts/reap-test-databases.ts` all
 *     reach these values through it.
 *   - `jest.setup.js`, a Jest `setupFile` that runs before every test file.
 *     It repoints the APP's DATABASE_URL at the worker's database, and it
 *     must not load the TypeScript helper to do it: that would drag Prisma,
 *     `pg` and the PII middleware into every test file of every project.
 *
 * Plain CommonJS with only Node built-ins is the one form all of them can
 * load: Jest (through either project's transform), tsx, and bare `node`.
 * jest.setup.js used to spell the marker path as a literal of its own, which
 * is how a second definition starts. Keep this file dependency-free.
 *
 * ─── Why the marker's NAME carries the checkout tag (2026-10-30) ─────
 *
 * The marker lives in `node_modules/.cache/`, and it was named
 * `inflect-test-perworker.json` in every checkout. That was safe only while
 * each checkout had a `node_modules` of its own. Git worktrees on the dev
 * machine SYMLINK `node_modules` to the main checkout's, so every worktree
 * read and wrote ONE file. When two worktrees ran Jest at once, the later
 * globalSetup overwrote the earlier run's marker, and from then on:
 *
 *   - the earlier run's test files read the other checkout's database names,
 *     and its integration tests ran against the other worktree's databases;
 *   - the earlier run's teardown read the same record and dropped the OTHER
 *     run's databases `WITH (FORCE)`, in the middle of that run, and left its
 *     own behind;
 *   - whichever teardown ran first deleted the file, and every test file
 *     started after that fell back to the shared base database.
 *
 * The checkout tag in each DATABASE name existed to stop exactly this, and it
 * did nothing while the record carrying those names was shared. So the tag is
 * now in the marker's FILE NAME too. Two checkouts that share the directory
 * no longer share the file. `node_modules/.cache` is still the right
 * directory: gitignored, never crawled by Jest's watcher, and not
 * `os.tmpdir()`, where a predictable file name is a symlink-race vector
 * (CodeQL js/insecure-temporary-file).
 *
 * RESIDUAL, on purpose: the marker is per CHECKOUT, not per run. Two runs in
 * ONE checkout still share it. The concurrent-run lock refuses the second of
 * two runs on the same base database, but it admits a second run pointed at
 * another base through DATABASE_URL_TEST, and those two runs share this
 * file. See the lock's section in `tests/helpers/db.ts`.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');

/** This checkout's root: two levels above `tests/helpers/`. */
const CHECKOUT_ROOT = path.resolve(__dirname, '../..');

/**
 * A short, stable tag for a checkout root. It is folded into every per-worker
 * database name and into the marker's file name, so two checkouts on one
 * machine never derive the same database or the same marker.
 *
 * Derived from the repo ROOT, and deliberately not from the connection URL:
 * two checkouts can reach the same database by different routes (one through
 * `.env.test`, another through `tests/helpers/db.ts`'s own default), so any
 * scheme keyed on the connection string can agree by accident. The root
 * cannot, because the root is what makes them two checkouts.
 *
 * Pure, so the property that matters (two different roots never collide) is
 * directly testable.
 *
 * @param {string} repoRoot absolute path of a checkout
 * @returns {string} eight lowercase hex characters
 */
function tagForRoot(repoRoot) {
    return crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
}

/**
 * `tagForRoot` for THIS checkout.
 *
 * @returns {string}
 */
function checkoutTag() {
    return tagForRoot(CHECKOUT_ROOT);
}

/**
 * Where the checkout at `repoRoot` keeps its per-worker marker. The tag is in
 * the FILE NAME, not only in the directory, because the directory may be
 * shared through a symlinked `node_modules` (see the header).
 *
 * @param {string} repoRoot absolute path of a checkout
 * @returns {string}
 */
function perWorkerMarkerPath(repoRoot) {
    return path.join(
        repoRoot,
        'node_modules',
        '.cache',
        `inflect-test-perworker-${tagForRoot(repoRoot)}.json`,
    );
}

/**
 * The marker globalSetup writes for THIS checkout, describing the database
 * mode and the exact per-worker database names it created.
 */
const PER_WORKER_MARKER = perWorkerMarkerPath(CHECKOUT_ROOT);

module.exports = {
    CHECKOUT_ROOT,
    tagForRoot,
    checkoutTag,
    perWorkerMarkerPath,
    PER_WORKER_MARKER,
};
