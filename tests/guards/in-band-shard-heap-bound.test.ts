/**
 * The in-band shard's heap ceiling is really set — the guard `jest.config.js`
 * already cites.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * `jest.config.js` says, beside `workerIdleMemoryLimit`:
 *
 *     `tests/guards/in-band-shard-heap-bound.test.ts` asserts the ceiling this
 *     comment points at is really there, so the claim cannot rot into prose.
 *
 * It had rotted. The file did not exist — not on `main`, not on any branch —
 * so the sentence promising the claim was guarded was itself unguarded prose.
 * Found while diagnosing a shard OOM (#3977), and worth more than the
 * diagnosis: a citation to a non-existent test reads as assurance, and the
 * reader has no way to tell the difference without looking.
 *
 * ═══ WHAT IT PINS, AND WHY EACH ONE ═══
 *
 * Three facts, because the comment depends on all three and any one of them
 * going false makes it wrong in a different way:
 *
 *   1. the shard step sets an explicit `--max-old-space-size`. Without it the
 *      shard inherits the job-level default and the "legible V8 OOM rather
 *      than a kernel kill" property the comment claims is gone;
 *   2. it is set to the documented value. A drift here is the specific rot the
 *      citation was meant to prevent;
 *   3. the shard still runs `--runInBand`. This is the load-bearing one:
 *      `jest.config.js` explains that `workerIdleMemoryLimit` is INERT for the
 *      shard *because* the run is in-band. Drop `--runInBand` and the limit
 *      becomes live, the comment becomes false, and nothing else would notice.
 *
 * So this is not a value check with extra steps. It is the relationship
 * between a config value and a workflow flag, which is exactly the kind of
 * claim that cannot be held by either file alone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const CI_YML = path.join(ROOT, '.github/workflows/ci.yml');
const JEST_CONFIG = path.join(ROOT, 'jest.config.js');

/** The value `jest.config.js`'s comment names, pinned here so a drift fails. */
const DOCUMENTED_SHARD_HEAP_MB = 12288;

const ci = fs.readFileSync(CI_YML, 'utf8');
const jestConfig = fs.readFileSync(JEST_CONFIG, 'utf8');

/**
 * The `Test (shard …)` job's block, with COMMENT LINES STRIPPED.
 *
 * Stripping them is not tidiness. The first version of this guard matched the
 * window as-is, and its most important assertion — that the shard still runs
 * `--runInBand` — passed when the flag was deleted, because `ci.yml` discusses
 * `--runInBand` in three comments and the regex found the prose. A guard that
 * matches a file's description of a flag instead of the flag is green forever.
 */
function shardJobBlock(): string {
    const lines = ci.split('\n');
    const start = lines.findIndex((l) => /--shard=\$\{\{\s*matrix\.shard\s*\}\}/.test(l));
    expect(start).toBeGreaterThan(-1);
    const from = Math.max(0, start - 120);
    return lines
        .slice(from, start + 5)
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
}

/**
 * The shard's actual jest command, as one line. `--runInBand` has to be asserted
 * against THIS and not against the surrounding block, because a `run: |` script
 * and a comment are both just text in YAML.
 */
function shardJestCommand(): string {
    const lines = ci.split('\n');
    const end = lines.findIndex((l) => /--shard=\$\{\{\s*matrix\.shard\s*\}\}/.test(l));
    expect(end).toBeGreaterThan(-1);
    // Walk back to the `npx jest` that this `--shard` belongs to, skipping
    // comments and taking only continuation lines.
    const parts: string[] = [];
    for (let i = end; i >= 0 && i > end - 20; i -= 1) {
        const l = lines[i];
        if (/^\s*#/.test(l)) continue;
        parts.unshift(l.trim().replace(/\\$/, ''));
        if (/npx\s+jest/.test(l)) break;
    }
    return parts.join(' ');
}

describe('the in-band shard carries an explicit heap ceiling', () => {
    it('the shard step sets --max-old-space-size at all', () => {
        // Inheriting the job default is the failure this catches: the shard is
        // the heaviest in-band consumer in the workflow and the one the
        // ceiling exists for.
        expect(shardJobBlock()).toMatch(/--max-old-space-size=\d+/);
    });

    it('it is the value jest.config.js documents', () => {
        const found = [...shardJobBlock().matchAll(/--max-old-space-size=(\d+)/g)].map((m) =>
            Number(m[1]),
        );
        expect(found).toContain(DOCUMENTED_SHARD_HEAP_MB);
    });

    it('jest.config.js names the same number, so the two cannot drift apart', () => {
        // The comment is the thing a reader trusts. If someone raises the
        // workflow and not the prose, the prose becomes the lie.
        expect(jestConfig).toContain(String(DOCUMENTED_SHARD_HEAP_MB));
    });
});

describe('the premise that makes workerIdleMemoryLimit inert still holds', () => {
    it('the shard runs --runInBand — asserted on the COMMAND, not the prose', () => {
        // THE load-bearing assertion. `jest.config.js` keeps
        // `workerIdleMemoryLimit` while stating it cannot act here, and the
        // reason is that the shard is in-band. Drop the flag and that comment
        // silently becomes false — the limit would start recycling workers and
        // the explanation for keeping it would be wrong.
        expect(shardJestCommand()).toMatch(/npx\s+jest/);
        expect(shardJestCommand()).toMatch(/--runInBand/);
    });

    it('workerIdleMemoryLimit is still configured, so the comment has a subject', () => {
        expect(jestConfig).toMatch(/workerIdleMemoryLimit:\s*'[^']+'/);
    });

    it('the citation in jest.config.js points at THIS file', () => {
        // The reason this guard exists. If the path in that comment is edited
        // or this file is renamed, the citation stops resolving and the claim
        // goes back to being prose — which is the state it was in when this
        // was written.
        const cited = 'tests/guards/in-band-shard-heap-bound.test.ts';
        expect(jestConfig).toContain(cited);
        expect(fs.existsSync(path.join(ROOT, cited))).toBe(true);
    });
});
