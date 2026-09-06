/**
 * Only ONE Jest run at a time may hold a given (checkout, base database)
 * pair's test databases.
 *
 * ── The hazard ───────────────────────────────────────────────────────
 *
 * Per-worker databases are named `<base>_<checkoutTag>_w<id>`, and the tag
 * hashes the REPO ROOT. That keeps two CHECKOUTS apart, which is what it was
 * built for. It does nothing for two CONCURRENT RUNS in ONE checkout: both
 * derive the same tag, the same base, and therefore the same `_w1` / `_w2`
 * names. globalSetup DROPs those `WITH (FORCE)` and TEMPLATE-clones them;
 * `resetDatabase()` TRUNCATEs CASCADE in every `beforeEach`. The two runs
 * demolish each other mid-test, and neither is told — the wreckage arrives as
 * deadlocks, FK violations and vanished populations in suites that neither
 * run changed, i.e. as product bugs that are not there. Two agents sharing
 * one worktree lost a long time to exactly that.
 *
 * ── The invariant these tests hold ───────────────────────────────────
 *
 * A second concurrent run is REFUSED, with a message that names the run
 * holding the lock and says how to proceed. It is not made safe by a
 * per-run database name, because that answer only works while teardown is
 * reliable and a hard-killed run never reaches teardown — the orphaned
 * databases already on the shared cluster are the receipt. A session
 * advisory lock frees itself when the process dies.
 *
 * Each behavioural assertion below is paired with its vacuity companion: a
 * refusal that fires unconditionally would be indistinguishable from one
 * that fires correctly, so the "acquires when nothing holds it" and
 * "different key is not refused" cases are load-bearing, not padding.
 */
import { DB_AVAILABLE } from './db-helper';
import {
    acquireTestDbRunLock,
    currentTestDbRunLockKey,
    testDbRunLockKey,
    runLockConflictMessage,
    RUN_LOCK_LABEL_PREFIX,
} from '../helpers/db';
import type { TestDbRunLockKey } from '../helpers/db';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

/**
 * Keys used for the live-Postgres cases. Randomised per process so this file
 * can never contend with ITSELF — two worktrees are allowed to run it at the
 * same time, and a fixed synthetic key would make them flake each other.
 */
const SPEC_SCOPE = `/spec/${process.pid}/${Math.random().toString(36).slice(2)}`;
const KEY_A: TestDbRunLockKey = testDbRunLockKey(`${SPEC_SCOPE}/a`, 'inflect_test_spec');
const KEY_B: TestDbRunLockKey = testDbRunLockKey(`${SPEC_SCOPE}/b`, 'inflect_test_spec');
const LABEL_A = `${RUN_LOCK_LABEL_PREFIX}111111`;
const LABEL_B = `${RUN_LOCK_LABEL_PREFIX}222222`;

const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

describe('the run-lock key identifies a (checkout, base database) pair', () => {
    it('is stable, so two workers of ONE run derive the same key', () => {
        // The key deliberately ignores JEST_WORKER_ID. The lock is per RUN;
        // keying it per worker would let a run contend with itself and refuse
        // its own second worker.
        expect(testDbRunLockKey('/x/inflect-compliance', 'inflect_test')).toStrictEqual(
            testDbRunLockKey('/x/inflect-compliance', 'inflect_test'),
        );
    });

    it('differs for two checkouts, which are the runs that must NOT be refused', () => {
        // Separate worktrees already get separate databases, so refusing them
        // would forbid the parallel-agent workflow this repo runs on.
        expect(testDbRunLockKey('/a/inflect-compliance', 'inflect_test')).not.toStrictEqual(
            testDbRunLockKey('/b/inflect-compliance', 'inflect_test'),
        );
    });

    it('differs when a run is pointed at another base database', () => {
        // The refusal message offers DATABASE_URL_TEST=<other db> as the way
        // out. Keying on the tag alone would refuse that too, and the advice
        // would be a lie.
        expect(testDbRunLockKey('/a/inflect-compliance', 'inflect_test')).not.toStrictEqual(
            testDbRunLockKey('/a/inflect-compliance', 'inflect_test_scratch'),
        );
    });

    it('is not a constant (vacuity companion for the two tests above)', () => {
        // A key derivation that returned [0, 0] would satisfy "stable" and
        // fail "differs" — but a subtler no-op that hashed only the base
        // would pass one of them. Sixty-four distinct roots, sixty-four
        // distinct keys, or the extractor is not extracting.
        const keys = Array.from({ length: 64 }, (_, i) =>
            testDbRunLockKey(`/root/${i}/inflect-compliance`, 'inflect_test'),
        );
        expect(new Set(keys.map((k) => `${k[0]}/${k[1]}`)).size).toBe(keys.length);
    });

    it('stays inside the int4 range pg_try_advisory_lock accepts', () => {
        // A key outside int4 makes every acquisition throw, and the throw is
        // swallowed as 'unchecked' — a lock that never runs, reported as a
        // lock that found nothing. That is the exact shape this whole task is
        // about, so it is asserted rather than assumed.
        for (let i = 0; i < 250; i++) {
            const [hi, lo] = testDbRunLockKey(`/root/${i}`, `base_${i}`);
            expect(Number.isInteger(hi)).toBe(true);
            expect(Number.isInteger(lo)).toBe(true);
            expect(hi).toBeGreaterThanOrEqual(INT4_MIN);
            expect(hi).toBeLessThanOrEqual(INT4_MAX);
            expect(lo).toBeGreaterThanOrEqual(INT4_MIN);
            expect(lo).toBeLessThanOrEqual(INT4_MAX);
        }
    });
});

describe('a run that cannot CHECK does not report that it checked', () => {
    it('reports unchecked (not acquired) when Postgres is unreachable', async () => {
        // "Did not check" and "checked, found nothing" are the same silence
        // unless they are separate states. If this returned 'acquired', a
        // broken connection string would look exactly like an uncontended
        // lock and the guarantee would evaporate without a single red test.
        const outcome = await acquireTestDbRunLock({
            key: KEY_A,
            adminUrl: 'postgresql://test:test@127.0.0.1:1/postgres',
            label: LABEL_A,
        });
        expect(outcome.status).toBe('unchecked');
        if (outcome.status !== 'unchecked') return;
        expect(outcome.reason).toContain('cannot reach Postgres');
    });
});

describe('the refusal text names the other run and says what to do', () => {
    it('carries the holder, the key, the consequence and the ways out', () => {
        const message = runLockConflictMessage(
            [123, -456],
            {
                applicationName: `${RUN_LOCK_LABEL_PREFIX}4242`,
                backendPid: 987,
                backendStart: '2026-09-06T05:00:00.000Z',
                clientAddr: '127.0.0.1',
            },
            'checkout deadbeef, base "inflect_test"',
        );
        // Who: the OTHER run's process id travels in application_name, which
        // is the only field we control. pg_stat_activity.pid is the server
        // backend, and reporting that as "the other run" would send whoever
        // reads this to `ps` for a process that does not exist locally.
        expect(message).toContain(`${RUN_LOCK_LABEL_PREFIX}4242`);
        expect(message).toContain('987');
        expect(message).toContain('2026-09-06T05:00:00.000Z');
        // Which lock, and over what.
        expect(message).toContain('123/-456');
        expect(message).toContain('checkout deadbeef, base "inflect_test"');
        // Why it matters — the failures this prevents are the ones that look
        // like product bugs, so the message says so.
        expect(message).toContain('TRUNCATE');
        // How to proceed.
        expect(message).toContain('DATABASE_URL_TEST=');
        expect(message).toContain('worktree');
    });

    it('still refuses legibly when pg_stat_activity cannot name the holder', () => {
        // Naming the holder is a nicety; refusing is the guarantee. A null
        // holder must not produce "undefined" in an operator-facing message.
        const message = runLockConflictMessage([1, 2], null, 'checkout deadbeef, base "b"');
        expect(message).toContain('Refusing to start');
        expect(message).not.toContain('undefined');
    });
});

describeFn('a second concurrent run is refused, not silently allowed', () => {
    const held: Array<() => Promise<void>> = [];

    afterEach(async () => {
        while (held.length) {
            const release = held.pop();
            if (release) await release();
        }
    });

    it('acquires when nothing holds the key (vacuity companion)', async () => {
        // Without this, "the second call is refused" would also pass against
        // a lock that refuses everything, which protects nothing and blocks
        // every run.
        const first = await acquireTestDbRunLock({ key: KEY_A, label: LABEL_A });
        expect(first.status).toBe('acquired');
        if (first.status === 'acquired') held.push(first.release);
    });

    it('refuses the second acquisition and names the run already holding it', async () => {
        const first = await acquireTestDbRunLock({ key: KEY_A, label: LABEL_A });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired') return;
        held.push(first.release);

        const second = await acquireTestDbRunLock({ key: KEY_A, label: LABEL_B });
        expect(second.status).toBe('conflict');
        if (second.status !== 'conflict') return;

        expect(second.holder?.applicationName).toBe(LABEL_A);
        expect(second.holder?.backendPid).toBeGreaterThan(0);
        expect(second.message).toContain(LABEL_A);
        expect(second.message).toContain(String(second.holder?.backendPid));
    });

    it('does not refuse a DIFFERENT pair while one is held', async () => {
        // The lock is keyed, not global. A global one would forbid two
        // worktrees running at once — the workflow that makes parallel agents
        // possible — and would be indistinguishable from a correct lock in
        // every other test here.
        const a = await acquireTestDbRunLock({ key: KEY_A, label: LABEL_A });
        expect(a.status).toBe('acquired');
        if (a.status === 'acquired') held.push(a.release);

        const b = await acquireTestDbRunLock({ key: KEY_B, label: LABEL_B });
        expect(b.status).toBe('acquired');
        if (b.status === 'acquired') held.push(b.release);
    });

    it('releases on release(), so the next run is not locked out', async () => {
        // globalTeardown calls this. If it did not actually free the lock,
        // the FIRST run would be fine and every run after it would be refused
        // — a wedge that arrives one run later than the change that caused it.
        const first = await acquireTestDbRunLock({ key: KEY_A, label: LABEL_A });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired') return;
        await first.release();

        const second = await acquireTestDbRunLock({ key: KEY_A, label: LABEL_B });
        expect(second.status).toBe('acquired');
        if (second.status === 'acquired') held.push(second.release);
    });
});

describeFn('globalSetup holds the lock for the run in progress', () => {
    it("refuses a second acquisition of THIS run's real key", async () => {
        // Everything above proves the helper works. None of it would notice
        // globalSetup no longer CALLING it — the helper would keep passing its
        // own tests while every run went unprotected. This is the wiring
        // assertion: the run executing this very line already holds its own
        // key, so asking for it again must be refused.
        const outcome = await acquireTestDbRunLock({
            key: currentTestDbRunLockKey(),
            label: `${RUN_LOCK_LABEL_PREFIX}wiring`,
        });
        // Release immediately if it was (wrongly) granted, so a failure here
        // does not also leave the real key held for the rest of the run.
        if (outcome.status === 'acquired') await outcome.release();

        expect(outcome.status).toBe('conflict');
        if (outcome.status !== 'conflict') return;
        // A literal regex, not `new RegExp(RUN_LOCK_LABEL_PREFIX + ...)`: a
        // dynamic pattern is unanalysable to the Class C assertion-reach
        // ratchet, which caps its own skipped population with zero drift
        // allowance. Hiding a pattern from the analyser is not free here.
        expect(outcome.holder?.applicationName).toMatch(/^inflect-jest-run:\d+$/);
        expect(RUN_LOCK_LABEL_PREFIX).toBe('inflect-jest-run:');
    });
});
