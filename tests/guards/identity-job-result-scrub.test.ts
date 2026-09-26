/**
 * The identity job RESULT may not carry a directory identifier either.
 *
 * THE ASYMMETRY THIS SITS BESIDE, AND DOES NOT CONTRADICT.
 * `identity-log-identifier-scrub` states that thrown errors and the values
 * returned from the identity usecases keep their identifiers ON PURPOSE: a
 * `DirectoryWriteError`'s reason reaches an operator through a tenant-scoped,
 * access-controlled surface where naming the account is the whole point, and
 * that guard says explicitly it "must not be widened into banning it".
 *
 * That reasoning is about the OPERATOR surface. It does not transfer to the
 * value handed to BullMQ. `queue.ts` retains completed and failed jobs under
 * `removeOnComplete: 500` / `removeOnFail: 1000`, so the job result — including
 * `details.detail` and `errorMessage` — sits in REDIS, which has none of the
 * properties the asymmetry depends on: not tenant-scoped, not access-controlled,
 * and not something an auditor reads with a reason to see the account named.
 *
 * #2877 finding 22 closed every DURABLE sink: `safeRecordErroredPass` scrubs
 * before it writes the `IntegrationExecution` row, on both directions, and the
 * per-decision reasons are scrubbed on the way IN. The job-result copy was the
 * residue, and it was reachable on exactly the same failure — one provider error
 * scrubbed into the row and unscrubbed into Redis on the same pass.
 *
 * WHY IT COSTS THE OPERATOR NOTHING, which is the thing to verify before
 * narrowing a documented surface: the manual-run routes ENQUEUE and never read
 * this return value, and the passes pages read the `IntegrationExecution` row.
 * The only consumers of this copy are Redis and the metrics counters.
 *
 * WHY A SOURCE RATCHET. Same reason the sibling guard gives: a per-site unit
 * test cannot fail for a site nobody thought of, and the next direction added
 * to this registry is the next chance to hand BullMQ a raw provider message.
 *
 * @see tests/guards/identity-log-identifier-scrub.test.ts — the asymmetry
 * @see src/app-layer/jobs/queue.ts — the retention that makes Redis a sink
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const REGISTRY = path.resolve(
    __dirname,
    '../../src/app-layer/jobs/executor-registry.ts',
);

/** Comment-free, so the prose above and in the registry cannot satisfy anything. */
const SRC = codeOf(fs.readFileSync(REGISTRY, 'utf8'));

/** The directions that write to a customer directory. Both, named explicitly. */
const IDENTITY_EXECUTORS = ['identity-joiner-pass', 'identity-leaver-pass'] as const;

/**
 * A field handed over RAW — the exact shape this guard exists to refuse.
 *
 * The TERMINATOR is the whole subtlety. `${field}: r.${field}` alone also
 * matches `detail: r.detail ? redactDirectoryIdentifiers(r.detail, …) : r.detail`,
 * which is the CORRECT form for a field that may be undefined — so the first
 * draft of this guard reddened on the very code it was written to bless.
 * Requiring a comma or a closing brace pins "handed straight over" and lets the
 * guarded ternary through, because there the next token is `?`.
 */
const BARE = (field: string) => new RegExp(`${field}:\\s*r\\.${field}\\s*[,}]`);

/**
 * One executor's registration body.
 *
 * NOT `braceBlockAfter`, deliberately. That helper masks string literals before
 * searching, which is right for its usual anchors and fatal here: the only
 * thing identifying an executor IS a string literal, so the anchor could never
 * match and all four assertions failed with "block anchor not found" rather
 * than with a verdict. Splitting on the registration call keeps the read bound
 * to one executor without needing to match inside quotes.
 */
function registrationOf(job: string): string {
    const parts = SRC.split('executorRegistry.register(');
    const block = parts.find((p) => p.startsWith(`'${job}'`));
    if (block === undefined) throw new Error(`executor not registered: ${job}`);
    return block;
}

describe('identity job results are scrubbed before they reach BullMQ', () => {
    it.each(IDENTITY_EXECUTORS)('%s hands over no raw detail or errorMessage', (job) => {
        const block = registrationOf(job);

        expect(block).not.toMatch(BARE('detail'));
        expect(block).not.toMatch(BARE('errorMessage'));
        // ...and the scrubber is actually present, so deleting the fields
        // entirely would not be read as compliance.
        expect(block).toContain('redactDirectoryIdentifiers(');
    });

    it('the BARE matcher can fire — proven on a job that legitimately keeps it', () => {
        // THE POSITIVE CONTROL, and this guard is worthless without it. Every
        // assertion above is a `not.toMatch`, which an inert regex satisfies
        // perfectly. `hris-sync` is not a directory write path — it carries no
        // DN or UPN — so it still hands `errorMessage` over raw, and that makes
        // it the honest proof that the pattern matches the shape it claims to.
        //
        // If this one ever goes red because hris-sync was scrubbed too, replace
        // the control rather than deleting it: an all-green `not.toMatch` suite
        // with no control is indistinguishable from a broken regex.
        const block = registrationOf('hris-sync');
        expect(block).toMatch(BARE('errorMessage'));
    });

    it('both executors were actually found — an empty block passes everything', () => {
        for (const job of IDENTITY_EXECUTORS) {
            const block = registrationOf(job);
            expect(block.length).toBeGreaterThan(200);
            expect(block).toContain('makeResult(');
        }
    });
});
