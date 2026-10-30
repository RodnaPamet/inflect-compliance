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
 * ─── Why the name also carries the RUN (#4610) ──────────────────────
 *
 * Per checkout was not enough. Two runs in ONE checkout still shared the
 * file. The concurrent-run lock refuses the second of two runs on the same
 * base database, but it admits a second run pointed at another base through
 * DATABASE_URL_TEST, and its own refusal message suggests exactly that. The
 * second run's globalSetup then overwrote the marker, and the first run's
 * test files read the second run's database names from it.
 *
 * So each run now has a marker of its own. globalSetup names it
 * (`newRunMarkerPath`), writes it, and puts its path in the environment
 * (`publishRunMarker`, under `RUN_MARKER_ENV`). Jest starts its workers after
 * globalSetup, so they inherit that environment; the in-band runner and
 * globalTeardown run in the process that set it. Every reader takes the path
 * from there (`currentRunMarker`) and derives nothing, so two runs cannot
 * reach one file however they were started.
 *
 * Outside a run that globalSetup started (the `scan` and `jsdom` projects run
 * on their own, a bare `node` script), there is no marker, and the readers
 * fall back to the shared base database, which is what such a run uses.
 *
 * A run killed before its teardown leaves its marker behind. The name carries
 * the pid of the process that ran globalSetup, so the next globalSetup in this
 * checkout deletes the markers of runs that are no longer alive
 * (`reapDeadRunMarkers`), and the one-per-checkout marker this file used to
 * write.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
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
 * The environment variable that names THIS RUN's marker. globalSetup sets it;
 * Jest's workers inherit it, because Jest spawns them after globalSetup.
 */
const RUN_MARKER_ENV = 'INFLECT_TEST_RUN_MARKER';

/** Where the checkout at `repoRoot` keeps its markers. */
function markerDir(repoRoot) {
    return path.join(repoRoot, 'node_modules', '.cache');
}

/** The marker-name prefix for the checkout at `repoRoot`. */
function markerPrefix(repoRoot) {
    return `inflect-test-perworker-${tagForRoot(repoRoot)}`;
}

/**
 * A marker path for one run of the checkout at `repoRoot`. The checkout tag
 * is in the FILE NAME, not only in the directory, because the directory may
 * be shared through a symlinked `node_modules` (see the header). `runId`
 * keeps two runs of one checkout apart.
 *
 * @param {string} repoRoot absolute path of a checkout
 * @param {string} runId `<pid>-<hex>`, as `newRunId` makes it
 * @returns {string}
 */
function runMarkerPath(repoRoot, runId) {
    return path.join(markerDir(repoRoot), `${markerPrefix(repoRoot)}-${runId}.json`);
}

/**
 * A fresh run id: the pid of the process running globalSetup, which is the
 * process the run lives in, and random bytes, so a reused pid still gets a
 * name of its own.
 *
 * @returns {string}
 */
function newRunId() {
    return `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * A marker path for a new run of THIS checkout.
 *
 * @returns {string}
 */
function newRunMarkerPath() {
    return runMarkerPath(CHECKOUT_ROOT, newRunId());
}

/**
 * Name `markerPath` as this run's marker, for this process and every process
 * it starts from now on, the Jest workers included.
 *
 * @param {string} markerPath
 */
function publishRunMarker(markerPath) {
    process.env[RUN_MARKER_ENV] = markerPath;
}

/**
 * This run's marker, as globalSetup named it, or `null` when no globalSetup
 * named one (see the header for which runs those are).
 *
 * @returns {string | null}
 */
function currentRunMarker() {
    return process.env[RUN_MARKER_ENV] || null;
}

/**
 * Whether the process `pid` is alive. EPERM means it exists under another
 * user, which is alive.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return Boolean(err && err.code === 'EPERM');
    }
}

/**
 * Delete the markers in the checkout at `repoRoot` that no live run owns: one
 * whose name carries a pid that is not alive, and the one-per-checkout marker
 * this checkout used to write. Another checkout's markers are never touched,
 * even in a shared directory, because only names carrying this checkout's tag
 * are considered.
 *
 * Best-effort: a marker it cannot read or delete is left where it is.
 *
 * @param {string} repoRoot absolute path of a checkout
 * @param {(pid: number) => boolean} [isAlive] for tests
 * @returns {string[]} the file names it deleted
 */
function reapDeadRunMarkers(repoRoot, isAlive = pidAlive) {
    const dir = markerDir(repoRoot);
    const prefix = markerPrefix(repoRoot);
    const runMarker = new RegExp(`^${prefix}-(\\d+)-[0-9a-f]+\\.json$`);
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const reaped = [];
    for (const name of names) {
        const legacy = name === `${prefix}.json`;
        const match = runMarker.exec(name);
        if (!legacy && !(match && !isAlive(Number(match[1])))) continue;
        try {
            fs.unlinkSync(path.join(dir, name));
            reaped.push(name);
        } catch {
            /* already gone, or not ours to delete */
        }
    }
    return reaped;
}

module.exports = {
    CHECKOUT_ROOT,
    tagForRoot,
    checkoutTag,
    RUN_MARKER_ENV,
    runMarkerPath,
    newRunMarkerPath,
    publishRunMarker,
    currentRunMarker,
    reapDeadRunMarkers,
};
