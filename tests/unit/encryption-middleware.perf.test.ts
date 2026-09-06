/**
 * Epic B.1 — how much WORK the encryption middleware does per query
 * shape.
 *
 * The scenarios below (detail / list / list+includes / no-manifest-model
 * / nested write) are the shapes production actually issues. What is
 * asserted about each is a count of calls into `@/lib/security/encryption`,
 * derived from the manifest: one decryption per encrypted field present,
 * one encryption per encrypted field written, and nothing at all for a
 * model with no manifest fields. Those integers are a pure function of
 * the input shape — the same on any machine, under any load.
 *
 * ─── Removed 2026-09-06: eight wall-clock budgets ────────────────────
 *
 * This file used to assert seven latency ceilings from a `T` table plus
 * an `overheadPct` ratio of two wall-clock samples. Its own comment
 * named the target: "so the test catches a real regression (e.g. a 10x
 * degradation in the hot path) without flaking on a noisy runner". It
 * did neither reliably, and the two failures are the same milliseconds
 * seen from opposite ends.
 *
 * FALSE POSITIVES are recorded in this repo's history, not inferred.
 * Commit 2f4cfc41d ("stabilise flaky perf + auth-routes suites under
 * parallel jest") raised every ceiling in `T` — detail 5→10 ms, list
 * 50→75, list+includes 120→200, write-nested 80→120, walk 15→30 —
 * because contention tripped them on a HEALTHY build. 8ab09ce54 moved
 * the overhead ratio 200%→5000% for the same reason. The ceilings sat
 * where they sat in order to absorb a loaded runner.
 *
 * FALSE NEGATIVES: that absorbed slack is where the named target sits.
 * Measured against main's copy of this file, `--runInBand`, on an
 * 8-core box, with `decryptValue` mutated to decrypt each value ten
 * times and keep the last:
 *
 *   healthy       list+includes 15.0–22.1 ms      (ceiling 200)
 *   10x, idle     list+includes 84.0–90.7 ms      all eight PASSED, 3/3 runs
 *   10x, loaded   list+includes 168.4 / 193.9 / 196.9 / 207.7 ms
 *                 — one run of four FAILED, three passed
 *
 * ("loaded" = six busy-loop processes competing for the same 8 cores.
 * An independent 8-core measurement of the same mutation read 264.3 ms
 * and failed.) A third pass, taken while unrelated work held the same
 * box at load average ~3, read the two rows as 138.5 / 147.8 / 182.7 ms
 * (all eight still passed) and, under the same six busy loops,
 * 260.0 / 295.3 / 347.3 ms — failing every time. Every reading of the
 * "idle" row is therefore a property of that machine at that moment and
 * of nothing else. So the verdict on this file's own stated target is
 * decided by what else the runner is doing rather than by the code —
 * and a gate that returns a coin flip is worse than no gate, because it
 * teaches people to re-run.
 *
 * An earlier draft of this header reported "all eight passed" for the
 * 10x mutation as if that were a property of the code. It is the idle
 * row above and nothing more; the loaded row is the same mutation.
 *
 * Four further mutations, same box, `--runInBand`, each against a
 * healthy band re-read in the same session so the comparison is like
 * for like — list+includes 16.8–22.1 ms, walk 0.80–1.45 ms:
 *
 *   * **40x the decrypt work.** list+includes 351–492 ms, so that one
 *     fires. `list` straddled: 62.5 ms on one run, 91.8 ms on the next,
 *     against a 75 ms ceiling — the same coin flip one notch up. One to
 *     two of the eight fired. The first regression these budgets catch
 *     RELIABLY is therefore somewhere past 10x.
 *   * **A genuine O(n²) in the read walk** — a cycle guard written as an
 *     array scan rather than a Set, i.e. the exact shape the 5000%
 *     ratio names as its target. walk 0.9→5.1–5.8 ms (ceiling 30),
 *     list+includes 22→33–45 ms (ceiling 200). All eight passed.
 *   * **The `nodeHasAnyEncryptedFieldKey` fast path deleted** — the
 *     thing 'WALK skips nodes with no manifest fields' claims to guard.
 *     list+includes 18.2–21.1 ms, walk 0.91–1.04 ms: inside the healthy
 *     band. All eight passed.
 *   * **`nodeHasAnyEncryptedFieldKey` degraded from a Set lookup to a
 *     linear scan of the manifest.** walk 1.27–1.53 ms. All eight
 *     passed.
 *
 * Same defect and same remedy as tests/unit/framework-tree-builder.test.ts
 * and tests/unit/password-check.test.ts:183-197. `tests/stress/README.md`
 * carries this repo's earlier finding about this very file.
 *
 * Two of the eight had no work-shaped replacement and were deleted
 * outright rather than reshaped:
 *
 *   * The two BASELINE ceilings (bare `encryptField` / `decryptField`
 *     under 1500 µs against ~12–45 µs observed) measure the crypto
 *     primitive, not this middleware. The invariant they gesture at is
 *     the key-derivation cache, which is module-private
 *     (`getEncryptionKey` is not exported) and belongs to
 *     `tests/unit/encryption.test.ts`.
 *   * `COMPARISON — middleware read overhead vs raw decrypt` asked
 *     whether the walk spends more CPU on traversal than on
 *     cryptography. The count assertions answer that directly and
 *     without a clock: the walk performs exactly one decryption per
 *     encrypted field, so it can spend no crypto it does not need.
 *
 * ─── What this trade COSTS ───────────────────────────────────────────
 *
 * Not nothing. Call counts see REDUNDANT work: the 10x and 40x
 * mutations become 2000 and 8000 decryptions against a `toBe(200)`, so
 * they fail the moment the count moves at all — no 10x or 40x needed,
 * and no runner gets a say. They
 * are blind to work that is merely SLOWER PER CALL — the array-scan
 * cycle guard, the deleted fast path and the Set→linear degradation
 * each perform the identical number of crypto calls, so no count can
 * move.
 *
 * The ceilings missed those three too on an idle box (measured above),
 * but that is NOT the same as losing nothing, and saying so would be
 * the same over-claim this diff is here to remove. Detection power is a
 * function of the runner: measured on the same 8-core box, healthy
 * list+includes read 26.7 ms under six competing busy loops and 45.2 ms
 * under sixteen, putting the 200 ms ceiling 7.5x and 4.4x above healthy
 * rather than the idle 13x. A slower-per-call regression of roughly
 * that size — invisible to every count in this file — would have
 * crossed the old ceiling on a runner like that, and now will not.
 *
 * That is the trade, taken deliberately: a verdict that is the same
 * integer on every machine and never false-positive, bought with the
 * loss of per-call-cost detection on precisely the contended runners
 * where the ceiling had any bite left. Buying it back honestly means
 * instrumenting production code, which pins the mechanism and fails any
 * legitimate refactor (CLAUDE.md, "Epic-ratchet lifecycle"), or running
 * a benchmark whose numbers are RECORDED rather than asserted — which
 * is what `recordTrend()` in `tests/stress/` does with every timing it
 * takes. (That suite itself GATES — "No continue-on-error. This is the
 * gate." — and asserts one wall-clock bound, triaged in the
 * implementation note; it is the numbers, not the suite, that report.)
 */

import * as encryption from '@/lib/security/encryption';
import { getEncryptedFields } from '@/lib/security/encrypted-fields';
import { _internals } from '@/lib/db/encryption-middleware';

const NO_DEKS = { primary: null, previous: null, reason: 'by-design' as const } as const;
const { walkReadResult, walkWriteArgument } = _internals;

// ─── Work tally ─────────────────────────────────────────────────────

interface CryptoTally {
    encryptField: number;
    decryptField: number;
    isEncryptedValue: number;
}

/**
 * Count the middleware's calls into the encryption module while `run`
 * executes. Spying the module namespace catches cross-module calls
 * only, which is exactly the question: how much crypto did the WALK
 * ask for? Intra-module calls inside `encryption.ts` bind locally and
 * are invisible here, so the counts do not move when that module is
 * refactored.
 */
function withCryptoTally<T>(run: () => T): { tally: CryptoTally; value: T } {
    const tally: CryptoTally = { encryptField: 0, decryptField: 0, isEncryptedValue: 0 };
    const realEncryptField = encryption.encryptField;
    const realDecryptField = encryption.decryptField;
    const realIsEncryptedValue = encryption.isEncryptedValue;

    const spies = [
        jest.spyOn(encryption, 'encryptField').mockImplementation((plaintext: string) => {
            tally.encryptField += 1;
            return realEncryptField(plaintext);
        }),
        jest.spyOn(encryption, 'decryptField').mockImplementation((ciphertext: string) => {
            tally.decryptField += 1;
            return realDecryptField(ciphertext);
        }),
        jest.spyOn(encryption, 'isEncryptedValue').mockImplementation((value: string | null | undefined) => {
            tally.isEncryptedValue += 1;
            return realIsEncryptedValue(value);
        }),
    ];

    try {
        return { tally, value: run() };
    } finally {
        for (const spy of spies) spy.mockRestore();
    }
}

// ─── Fixtures ───────────────────────────────────────────────────────

// Deterministic plaintext — same content every run.
const PLAINTEXT_SAMPLES = [
    'Remediation plan: isolate affected service, rotate credentials, audit logs.',
    'Root cause: missing input validation on the /v1/checkout endpoint.',
    'Threat: sophisticated attacker with internal network foothold.',
    'Vulnerability: stored XSS in admin console.',
    'Treatment: patch vendor library, add WAF rule, schedule re-test.',
];
const SAMPLE = (i: number): string => PLAINTEXT_SAMPLES[i % PLAINTEXT_SAMPLES.length];

const CIPHERTEXT_SAMPLES = PLAINTEXT_SAMPLES.map((p) => encryption.encryptField(p));
const CIPHER = (i: number): string => CIPHERTEXT_SAMPLES[i % CIPHERTEXT_SAMPLES.length];

const RISK_FIELDS = getEncryptedFields('Risk') ?? [];
const TASK_FIELDS = getEncryptedFields('Task') ?? [];
const TASK_COMMENT_FIELDS = getEncryptedFields('TaskComment') ?? [];

const LIST_ROWS = 100;
const NESTED_COMMENTS = 10;
const WRITE_COMMENTS = 50;

function taskRows(count: number): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `t-${i}`,
        title: `Task ${i}`,
        description: CIPHER(i),
        resolution: CIPHER(i + 1),
        createdAt: '2026-04-22',
        assigneeUserId: `u-${i}`,
    }));
}

// ─── The manifest is the premise every count below rests on ─────────

describe('encryption middleware — manifest premise', () => {
    it('the benchmarked models carry the field counts the expectations assume', () => {
        // If a field is added to one of these models the counts below
        // move, and they should — but they must move because the
        // manifest moved, not because somebody adjusted a number.
        expect(RISK_FIELDS).toHaveLength(3);
        expect(TASK_FIELDS).toHaveLength(2);
        expect(TASK_COMMENT_FIELDS).toStrictEqual(['body']);
        // Framework is the no-manifest-fields control.
        expect(getEncryptedFields('Framework')).toBeUndefined();
    });
});

// ─── Read path ──────────────────────────────────────────────────────

describe('encryption middleware — decryption work per read shape', () => {
    it('DETAIL — a single row costs one decryption per encrypted field, and no more', () => {
        const row: Record<string, unknown> = {
            id: 'r-1',
            title: 'plaintext title',
            treatmentNotes: CIPHER(0),
            threat: CIPHER(1),
            vulnerability: CIPHER(2),
            createdAt: '2026-04-22',
        };

        const { tally } = withCryptoTally(() => walkReadResult(row, 'Risk', NO_DEKS));

        expect(tally.decryptField).toBe(RISK_FIELDS.length);
        // Values were really decrypted, and the plaintext columns were
        // left alone.
        expect(row.treatmentNotes).toBe(PLAINTEXT_SAMPLES[0]);
        expect(row.title).toBe('plaintext title');
        // Traversal bound: the walk inspects each manifest-named value
        // once. A walk that revisits a node decrypts nothing extra (the
        // value is already plaintext) but does re-inspect it, so this is
        // the assertion that sees a double traversal.
        expect(tally.isEncryptedValue).toBeLessThanOrEqual(RISK_FIELDS.length);
    });

    it('LIST — 100 rows x 2 encrypted fields costs exactly 200 decryptions', () => {
        const rows = taskRows(LIST_ROWS);
        const expected = LIST_ROWS * TASK_FIELDS.length;

        const { tally } = withCryptoTally(() => walkReadResult(rows, 'Task', NO_DEKS));

        expect(tally.decryptField).toBe(expected);
        expect(tally.isEncryptedValue).toBeLessThanOrEqual(expected);
        expect(rows[0].description).toBe(PLAINTEXT_SAMPLES[0]);
    });

    it('LIST — decryption count is LINEAR in row count, not quadratic', () => {
        const small = withCryptoTally(() => walkReadResult(taskRows(50), 'Task', NO_DEKS));
        const large = withCryptoTally(() => walkReadResult(taskRows(200), 'Task', NO_DEKS));

        // 4x the rows, 4x the work — exactly, because the count is
        // fixed by the data rather than measured off a clock.
        expect(large.tally.decryptField).toBe(small.tally.decryptField * 4);
        expect(large.tally.isEncryptedValue).toBe(small.tally.isEncryptedValue * 4);
    });

    it('LIST + INCLUDES — nested relations add their own fields and nothing else', () => {
        const rows = Array.from({ length: LIST_ROWS }, (_, i) => ({
            id: `t-${i}`,
            title: `Task ${i}`,
            description: CIPHER(i),
            resolution: CIPHER(i + 1),
            createdAt: '2026-04-22',
            comments: Array.from({ length: NESTED_COMMENTS }, (_, j) => ({
                id: `c-${i}-${j}`,
                body: CIPHER(i + j),
                createdByUserId: `u-${j}`,
                createdAt: '2026-04-22',
                // A nested relation with NO manifest fields — the
                // included `User`. It must cost zero decryptions.
                createdBy: { id: `u-${j}`, name: 'plaintext', emailVerified: '2026-04-22' },
            })),
        }));

        const expected =
            LIST_ROWS * TASK_FIELDS.length +
            LIST_ROWS * NESTED_COMMENTS * TASK_COMMENT_FIELDS.length;

        const { tally } = withCryptoTally(() => walkReadResult(rows, 'Task', NO_DEKS));

        expect(tally.decryptField).toBe(expected);
        expect(tally.isEncryptedValue).toBeLessThanOrEqual(expected);
        // The 1000 included User nodes contributed nothing.
        expect(rows[0].comments[0].createdBy.name).toBe('plaintext');
    });

    it('NO MANIFEST FIELDS — a Framework tree costs zero crypto and comes back unchanged', () => {
        const rows = Array.from({ length: LIST_ROWS }, (_, i) => ({
            id: `f-${i}`,
            key: 'ISO27001',
            name: 'ISO 27001',
            version: '2022',
            createdAt: '2026-04-22',
            description: 'global library entry — zero manifest fields for this model',
            requirements: [
                { id: 'r1', code: 'A.5.1', title: 'policy' },
                { id: 'r2', code: 'A.5.2', title: 'another clause' },
            ],
        }));
        const before = JSON.parse(JSON.stringify(rows));

        const { tally } = withCryptoTally(() => walkReadResult(rows, 'Framework', NO_DEKS));

        expect(tally.decryptField).toBe(0);
        expect(tally.isEncryptedValue).toBe(0);
        // `description` IS a manifest field name on OTHER models, so
        // this also pins that the walk resolves fields per model rather
        // than by name alone — mangling this row would be a data bug,
        // not a perf one.
        expect(rows).toStrictEqual(before);
    });
});

// ─── Write path ─────────────────────────────────────────────────────

describe('encryption middleware — encryption work per write shape', () => {
    it('WRITE — a nested createMany encrypts each manifest field exactly once', () => {
        const data = {
            title: 'Parent',
            description: SAMPLE(0),
            resolution: SAMPLE(1),
            comments: {
                createMany: {
                    data: Array.from({ length: WRITE_COMMENTS }, (_, i) => ({
                        body: SAMPLE(i),
                        createdByUserId: 'u-1',
                    })),
                },
            },
        };
        const expected =
            TASK_FIELDS.length + WRITE_COMMENTS * TASK_COMMENT_FIELDS.length;

        const { tally } = withCryptoTally(() => walkWriteArgument(data, 'Task', null));

        expect(tally.encryptField).toBe(expected);
        expect(encryption.isEncryptedValue(data.description)).toBe(true);
        expect(encryption.isEncryptedValue(data.comments.createMany.data[0].body)).toBe(true);
        // Non-manifest columns are untouched.
        expect(data.title).toBe('Parent');
        expect(data.comments.createMany.data[0].createdByUserId).toBe('u-1');
    });

    it('WRITE — re-walking an already-encrypted payload encrypts nothing (idempotent)', () => {
        const data = { description: SAMPLE(0), resolution: SAMPLE(1) };
        walkWriteArgument(data, 'Task', null);

        const { tally } = withCryptoTally(() => walkWriteArgument(data, 'Task', null));

        expect(tally.encryptField).toBe(0);
    });
});
