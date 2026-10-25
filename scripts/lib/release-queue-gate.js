/**
 * Should this Release run cut a release now, or leave it to a later run?
 *
 * THE COST THIS AVOIDS
 * ────────────────────
 * semantic-release pushes its `chore(release)` commit straight to `main`
 * through the ruleset's bypass. The merge queue builds each candidate on top
 * of `main` as it was, so that push invalidates every candidate in flight and
 * the queue rebuilds them all. Measured over 2026-10-18..25: 171 of 397 queue
 * runs (43%) were cancelled, and 121 of those 171 were cancelled by a release
 * push. A PR whose candidate was rebuilt waited a median 61 minutes in the
 * queue, against 16 for one built once.
 *
 * THE RULE
 * ────────
 * A run triggered by a push to `main` releases only when no OTHER entry is
 * waiting in the merge queue. The merge that empties the queue then releases
 * everything merged since the last version, in one release. Scheduled and
 * manual runs release whatever the queue holds, which bounds how long a
 * release can be held to a day.
 *
 * "Other" matters: the entries this push is merging can still be listed for a
 * moment after the push lands. They will never build again, so they are not
 * waiting, and counting them would hold the very release that should go out.
 * Each squash commit names its PR as the last `(#N)` of its subject.
 *
 * A RELEASE THAT WOULD RAISE A FLOOR NEVER WAITS
 * ──────────────────────────────────────────────
 * The release is also the only thing that raises the coverage floors
 * (`scripts/raise-coverage-floors.mjs`, the prepare step). When this gate was
 * written, `tests/guards/rendered-coverage-floor.test.ts` failed every build
 * once more tests had merged since the last release than its slack allowed
 * (8 rendered tests, 4 E2E specs, 3 registered primitives), and rendered tests
 * reached main at 20 to 23 a day on 2026-10-24 and 25: a release held through
 * a busy afternoon would have turned every queue candidate and main red. So
 * whenever a release would raise any floor, it goes out now, whatever the
 * queue holds. Only a merge that added no test, spec or primitive can wait:
 * over 2026-10-18..25 that was 181 of 236 merges.
 *
 * The guard has since stopped failing on lag: it holds each change to its
 * base commit instead. The exception stays because the stored floor is still
 * the guard's only check where no base can be read, and a floor that lags the
 * live count by a day of merges is a weaker one. Dropping the exception would
 * let those merges wait too, at that cost.
 *
 * FAILING OPEN
 * ────────────
 * A queue that cannot be read is NOT an empty queue, but the answer to it is
 * still to release: that is what every push did before this gate existed, so
 * a broken read costs churn, never a missing release. The entry script warns
 * on the run when it happens. Floors that cannot be counted release too, for
 * the same reason and because a stale floor is the costlier mistake.
 *
 * A capped read is a fact held rather than guessed: an entry past the page
 * still counts as waiting, through `total`.
 *
 * CommonJS so Jest can load it; `scripts/release-queue-gate.mjs` is the entry
 * point the workflow runs.
 */
'use strict';

const PR_REFERENCE = /\(#(\d+)\)\s*$/;

/** The PR a squash commit's subject names, or null when it names none. */
function prNumberOfCommit(message) {
    const subject = String(message ?? '').split('\n', 1)[0];
    const match = PR_REFERENCE.exec(subject);
    return match ? Number(match[1]) : null;
}

/**
 * @param {{
 *   eventName: string,
 *   queue: { prNumbers: number[], total: number } | null,
 *   pushedCommitMessages: string[],
 *   floorsBehind: string[] | null,
 * }} input   `queue` is null when it could not be read; `floorsBehind` names
 *   each coverage floor a release would raise, and is null when the floors
 *   could not be counted.
 * @returns {{ release: boolean, waitingOn: number[], unlisted: number, reason: string }}
 */
function decideRelease({ eventName, queue, pushedCommitMessages, floorsBehind }) {
    if (eventName !== 'push') {
        return {
            release: true,
            waitingOn: [],
            unlisted: 0,
            reason: `a ${eventName} run releases whatever the merge queue holds`,
        };
    }
    if (!Array.isArray(floorsBehind)) {
        return {
            release: true,
            waitingOn: [],
            unlisted: 0,
            reason: 'the coverage floors could not be counted, so this run releases rather than risk leaving them behind',
        };
    }
    if (floorsBehind.length > 0) {
        return {
            release: true,
            waitingOn: [],
            unlisted: 0,
            reason: `main has more ${floorsBehind.join(', ')} coverage than its floors record, and only a release raises them, so this one does not wait for the merge queue`,
        };
    }
    if (queue === null) {
        return {
            release: true,
            waitingOn: [],
            unlisted: 0,
            reason: 'the merge queue could not be read, so this run releases, as every push did before the gate',
        };
    }
    const merging = new Set(
        (pushedCommitMessages ?? []).map(prNumberOfCommit).filter((n) => n !== null),
    );
    const waitingOn = queue.prNumbers.filter((n) => !merging.has(n));
    const unlisted = Math.max(0, queue.total - queue.prNumbers.length);
    if (waitingOn.length > 0 || unlisted > 0) {
        const named = waitingOn.map((n) => `#${n}`).join(', ');
        const more = unlisted > 0 ? `${named ? ' and ' : ''}${unlisted} more` : '';
        return {
            release: false,
            waitingOn,
            unlisted,
            reason: `held: the merge queue is still building ${named}${more}; the push that empties it, or the daily run, releases`,
        };
    }
    return {
        release: true,
        waitingOn: [],
        unlisted: 0,
        reason: 'the merge queue has nothing else waiting',
    };
}

module.exports = { prNumberOfCommit, decideRelease };
