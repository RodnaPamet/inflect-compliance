/**
 * The in-band shard's heap ceiling is really set — the guard `jest.config.js`
 * already cites.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * `jest.config.js` says, beside `workerIdleMemoryLimit`, that
 * `tests/guards/in-band-shard-heap-bound.test.ts` asserts the ceiling its
 * comment points at "so the claim cannot rot into prose". It had rotted: the
 * file did not exist. A citation to a non-existent test reads as assurance,
 * and `npx jest <missing-path>` prints nothing and exits 0, so running it
 * looks like a pass.
 *
 * ═══ EVERY ASSERTION IS ON A PARSED FIELD ═══
 *
 * Nothing here matches workflow text, and that is not a style choice — it is
 * this guard's own history. Its first version matched `--runInBand` against the
 * job's text block and PASSED when the flag was deleted, because `ci.yml`
 * discusses `--runInBand` in three comments and the regex found the prose. The
 * mutation proof caught it.
 *
 * So the workflow is parsed with `js-yaml` and the assertions read
 * `step.env.NODE_OPTIONS` and the step's `run` string. A YAML comment cannot
 * satisfy a parsed field, which is the property `raw-source-assertion-ratchet`
 * exists to require and which this file was failing.
 *
 * The citation itself is NOT asserted here. `cited-test-paths-exist` already
 * holds that a cited test path resolves, so duplicating it would be a second
 * detector for one property.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');

/** The value `jest.config.js`'s comment names. A drift here is the rot. */
const DOCUMENTED_SHARD_HEAP_MB = 12288;

interface Step {
    run?: string;
    env?: Record<string, string>;
}
interface Workflow {
    jobs: Record<string, { steps?: Step[] }>;
}

const workflow = yaml.load(
    fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
) as Workflow;

/** The one step that runs the sharded jest invocation, found by its own fields. */
function shardStep(): Step {
    const steps = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .filter((s) => typeof s.run === 'string' && /npx\s+jest/.test(s.run) && /--shard=/.test(s.run));
    // Exactly one, so a second sharded invocation appearing elsewhere has to
    // come through here rather than silently splitting the property in two.
    expect(steps).toHaveLength(1);
    return steps[0];
}

describe('the in-band shard carries an explicit heap ceiling', () => {
    it('the shard step sets NODE_OPTIONS itself rather than inheriting the job default', () => {
        // Inheriting is the failure this catches: the shard is the heaviest
        // in-band consumer in the workflow and the one the ceiling is for.
        expect(shardStep().env?.NODE_OPTIONS).toMatch(/--max-old-space-size=\d+/);
    });

    it('and sets it to the value jest.config.js documents', () => {
        expect(shardStep().env?.NODE_OPTIONS).toContain(
            `--max-old-space-size=${DOCUMENTED_SHARD_HEAP_MB}`,
        );
    });
});

describe('the premise that makes workerIdleMemoryLimit inert still holds', () => {
    it('the shard still runs --runInBand', () => {
        // THE load-bearing assertion, and the one whose first version was
        // satisfied by a comment. Read from the parsed `run` string, so the
        // three places ci.yml *discusses* this flag cannot stand in for it.
        expect(shardStep().run).toMatch(/--runInBand/);
    });

    it('workerIdleMemoryLimit is configured, so the comment has a subject', () => {
        // Read as a VALUE off the loaded config, not as text: the point is that
        // jest is really given the option, not that the file mentions it.
        const config = require('../../jest.config.js') as {
            projects?: Array<{ workerIdleMemoryLimit?: string }>;
            workerIdleMemoryLimit?: string;
        };
        const limits = [
            config.workerIdleMemoryLimit,
            ...(config.projects ?? []).map((p) => p.workerIdleMemoryLimit),
        ].filter((v): v is string => typeof v === 'string' && v.length > 0);
        expect(limits.length).toBeGreaterThan(0);
    });
});
