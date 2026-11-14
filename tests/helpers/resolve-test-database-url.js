/**
 * Which database a Jest worker talks to, as one pure decision (#5567).
 *
 * ═══ THE FAILURE THIS EXISTS TO FIX ═══
 *
 * `jest.setup.js` resolves `DATABASE_URL` from the shell, then `.env`, then
 * `.env.test`, then a placeholder on port 5432 that exists so env validation
 * passes for unit tests that mock Prisma. Both env files are gitignored, so NO
 * fresh clone or git worktree has one.
 *
 * In a PARALLEL run that does not matter: `globalSetup` provisions one database
 * per worker and the marker repoints each worker at its own clone, overwriting
 * the placeholder on the way. In a SERIAL run — `--runInBand`, which is how the
 * CI `Test` shards and any local batch of integration suites execute — the
 * marker says `perWorker: false` and nothing repointed anything, so the
 * placeholder survived and every suite that drives a usecase failed with
 *
 *     Can't reach database server at 127.0.0.1:5432
 *
 * while `tests/helpers/db.ts` resolved the TEST client correctly to the 5434
 * container. Two URLs in one process, one of them a placeholder: a suite that
 * only reads through `prismaTestClient()` passed and one that went through
 * `runInTenantContext` did not. Measured on ten integration suites: 131 of 131
 * tests passed one at a time, 120 of 131 failed batched, and the first failures
 * in the run reported a BARE `PrismaClientKnownRequestError` with no message at
 * all — the port only appeared further down.
 *
 * It never bit CI, which exports `DATABASE_URL`, so the whole cost landed on
 * whoever was verifying a change locally — and it reads as "my branch is
 * broken", which is the expensive way to be wrong.
 *
 * ═══ WHY THIS IS A MODULE AND NOT TEN LINES IN `jest.setup.js` ═══
 *
 * That file is `setupFiles` for every project, runs before any test, and cannot
 * be imported by one: anything decided inside it is unobservable. The decision
 * is therefore here, pure, and `tests/unit/resolve-test-database-url.test.ts`
 * drives every branch — including the two that must NOT fire.
 *
 * Plain CommonJS `.js` on purpose: `jest.setup.js` is plain JS and cannot
 * import a TS helper, which is the same reason `test-db-checkout.js` beside it
 * is JS.
 */

/**
 * The dummy that lets `src/env.ts` validate for suites that mock Prisma.
 *
 * Named rather than inline so the resolution can RECOGNISE it. That is the
 * whole mechanism: a real URL — exported by CI, or by a developer who has an
 * env file — must never be overridden, and the only value safe to replace is
 * the one this file invented.
 */
const PLACEHOLDER_DATABASE_URL = 'postgres://user:password@localhost:5432/testdb';

/**
 * @param {object} input
 * @param {string} input.current           DATABASE_URL as the env-file chain left it.
 * @param {object|null} input.marker       This run's marker, or null when globalSetup did not run.
 * @param {string} input.workerId          JEST_WORKER_ID, '1' when unset.
 * @param {boolean} input.markerNamed      Whether a marker PATH was named for this run.
 * @returns {{url: string|null, reason: string}} `url` null means leave it alone.
 */
function resolveTestDatabaseUrl({ current, marker, workerId, markerNamed }) {
    // No marker named: the `scan` or `jsdom` project on its own, or a bare node
    // script. These mock Prisma and the placeholder is correct for them, so
    // this must stay silent rather than demand a database nobody provisioned.
    if (!markerNamed) return { url: null, reason: 'no-marker-shared-db' };

    if (marker && marker.perWorker) {
        const recorded = Array.isArray(marker.workerDbs)
            ? marker.workerDbs[Number(workerId) - 1]
            : null;
        const u = new URL(marker.baseUrl);
        // The RECORDED name, inline in the assignment on purpose. Re-derivation
        // is how this site drifted before — it spelled `baseName + '_w' + wid`
        // while the helper that creates the databases moved on — and
        // `per-worker-db-naming` pins the ASSIGNMENT rather than a mention,
        // because an earlier version of that test survived a mutation which
        // kept the lookup and dropped it from the pathname. Holding `recorded`
        // behind a local would put it back out of that assertion's reach.
        u.pathname = '/' + (recorded || `${marker.baseName}_w${workerId}`);
        return { url: u.toString(), reason: 'per-worker-clone' };
    }

    // SERIAL RUN. The marker knows the real base URL — globalSetup put it there
    // whether or not it made per-worker clones — and the only reason this did
    // not use it was that nothing asked.
    //
    // ONLY the placeholder is replaced. An exported URL is somebody's
    // deliberate choice about which database this run touches, and overriding
    // it from a marker would be this helper deciding that for them.
    if (marker && marker.baseUrl && current === PLACEHOLDER_DATABASE_URL) {
        return { url: marker.baseUrl, reason: 'serial-run-from-marker' };
    }

    if (current === PLACEHOLDER_DATABASE_URL) {
        // globalSetup ran, so a real database exists, and we are still holding
        // the dummy. Failing here costs one legible error instead of a hundred
        // connection refusals whose first few carry no message at all.
        throw new Error(
            [
                'DATABASE_URL is still the placeholder while globalSetup has provisioned a test database.',
                '',
                `  placeholder: ${PLACEHOLDER_DATABASE_URL}`,
                `  marker says: ${marker ? JSON.stringify({ perWorker: marker.perWorker, baseUrl: marker.baseUrl }) : '(unreadable)'}`,
                '',
                'Every suite that drives a usecase would fail with "Can\'t reach database server',
                'at 127.0.0.1:5432" while the test client reads the real database correctly, which',
                'reads as a broken branch rather than an unset variable (#5567).',
                '',
                'Export DATABASE_URL, or create .env.test with the test container\'s URL.',
            ].join('\n'),
        );
    }

    return { url: null, reason: 'shell-or-env-file' };
}

module.exports = { resolveTestDatabaseUrl, PLACEHOLDER_DATABASE_URL };
