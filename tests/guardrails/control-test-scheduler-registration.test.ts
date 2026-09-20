/**
 * Epic G-2 guardrail — control-test-scheduler registration is intact.
 *
 * Locks the four wiring points the scheduler depends on. A future
 * "schedule cleanup" or "type pruning" PR cannot silently drop one
 * of these without bumping the floor in this same diff.
 *
 * Enforced:
 *   1. `control-test-scheduler` is in `SCHEDULED_JOBS` with the
 *      every-5-minutes cron pattern.
 *   2. `control-test-scheduler` AND `control-test-runner` are keys
 *      in `JobPayloadMap`. The runner is included even though its
 *      executor is registered later — the typed payload is what
 *      makes the scheduler's `enqueue('control-test-runner', ...)`
 *      call typecheck today.
 *   3. Both have `JOB_DEFAULTS` entries — without these, `enqueue()`
 *      crashes at runtime when it indexes `JOB_DEFAULTS[name]`.
 *   4. `control-test-scheduler` has an executor registration in
 *      `executor-registry.ts`. (The runner's executor is NOT yet
 *      registered — that comes in the next G-2 prompt; this guard
 *      asserts the scheduler is wired today, not the runner.)
 *
 * Detection is a structural source scan. The mutation regression
 * proof at the bottom confirms the detector is real.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCHEDULES_FILE = path.join(REPO_ROOT, 'src/app-layer/jobs/schedules.ts');
const TYPES_FILE = path.join(REPO_ROOT, 'src/app-layer/jobs/types.ts');
const REGISTRY_FILE = path.join(
    REPO_ROOT,
    'src/app-layer/jobs/executor-registry.ts',
);

function read(file: string): string {
    return codeOf(fs.readFileSync(file, 'utf8'));
}

describe('Epic G-2 — control-test-scheduler registration', () => {
    const schedulesText = read(SCHEDULES_FILE);
    const typesText = read(TYPES_FILE);
    const registryText = read(REGISTRY_FILE);

    test('SCHEDULED_JOBS includes control-test-scheduler with the every-5-min pattern', () => {
        // The relative ordering of fields inside the literal is
        // formatted-but-not-stable, so we look for both the name
        // and the pattern within a window of each other.
        expect(schedulesText).toMatch(/name:\s*'control-test-scheduler'/);
        // Match the pattern within ~200 chars after the name to keep
        // this scoped to the same SCHEDULED_JOBS entry.
        const after = schedulesText.split(/name:\s*'control-test-scheduler'/)[1] ?? '';
        expect(after.slice(0, 400)).toMatch(/pattern:\s*'\*\/5 \* \* \* \*'/);
    });

    test('JobPayloadMap has both control-test-scheduler and control-test-runner', () => {
        // The map is `interface JobPayloadMap { ... }` with one
        // line per entry. The forward-declared runner key is what
        // makes this prompt's typed `enqueue('control-test-runner')`
        // compile.
        expect(typesText).toMatch(
            /'control-test-scheduler':\s*ControlTestSchedulerPayload/,
        );
        expect(typesText).toMatch(
            /'control-test-runner':\s*ControlTestRunnerPayload/,
        );
    });

    test('JOB_DEFAULTS has entries for both scheduler and runner', () => {
        // Without JOB_DEFAULTS[name], enqueue() throws at runtime —
        // it indexes the map directly, no fallback. Both entries
        // must be present even though the runner's executor isn't
        // registered yet.
        expect(typesText).toMatch(/'control-test-scheduler':\s*\{/);
        expect(typesText).toMatch(/'control-test-runner':\s*\{/);
    });

    test('executor-registry.ts registers control-test-scheduler', () => {
        expect(registryText).toMatch(
            /executorRegistry\.register\(\s*'control-test-scheduler'/,
        );
    });

    test('executor-registry.ts registers control-test-runner', () => {
        // Prompt 3 wired the runner — the scheduler-runner pair is
        // now both operational. The assertion was inverted in the
        // prompt-3 diff (was: "NOT yet registered") so the hand-off
        // moment between prompts is durable in the test history.
        expect(registryText).toMatch(
            /executorRegistry\.register\(\s*'control-test-runner'/,
        );
    });

    // ─── Detector regression proofs ────────────────────────────────

    test('detector catches a missing schedule entry (mutation regression)', () => {
        const broken = schedulesText.replace(
            /\{\s*name:\s*'control-test-scheduler'[\s\S]*?\},?\s*\]/,
            ']',
        );
        expect(broken).not.toMatch(/name:\s*'control-test-scheduler'/);
    });

    test('detector catches a missing JobPayloadMap entry (mutation regression)', () => {
        const broken = typesText.replace(
            /'control-test-scheduler':\s*ControlTestSchedulerPayload;?/,
            '',
        );
        expect(broken).not.toMatch(
            /'control-test-scheduler':\s*ControlTestSchedulerPayload/,
        );
    });

    test('detector catches a missing executor registration (mutation regression)', () => {
        const broken = registryText.replace(
            /executorRegistry\.register\(\s*'control-test-scheduler'[\s\S]*?\}\);/,
            '// removed',
        );
        expect(broken).not.toMatch(
            /executorRegistry\.register\(\s*'control-test-scheduler'/,
        );
    });
});
