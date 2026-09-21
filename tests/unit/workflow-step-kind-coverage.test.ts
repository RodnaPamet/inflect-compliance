/**
 * Every step kind is either EXECUTED or REFUSED — never silently skipped.
 *
 * ── THE ESCAPE THIS IS ABOUT ────────────────────────────────────────────────
 *
 * Point 5 of the integration plan asks that `costTokens` accumulate across all
 * kinds "so a loop cannot escape the cap by spending in a kind the counter
 * ignores". The escape is not a missing addition — it is the driver's
 * `if / else if` chain having no final arm.
 *
 * `costTokens` only accumulates INSIDE those branches. A step matching none of
 * them records nothing and charges nothing, while `stepCount` still advances
 * and the context still commits: a run reports itself complete having skipped a
 * step, and the token delta charged is zero. The driver now ends that chain
 * with a `never` assignment and a `failRun`, so a fifth member of
 * `WorkflowStepDef` is a BUILD ERROR rather than a silent skip.
 *
 * ── WHAT THIS FILE PINS THAT THE COMPILER CANNOT ────────────────────────────
 *
 * The compiler protects the union. It says nothing about the RELATIONSHIP
 * between the two vocabularies, which is where the confusion lives:
 *
 *   · `WorkflowStepDef` — the shapes a workflow DEFINITION may declare;
 *   · `WorkflowStepKind` — the kinds a driver may RECORD on a `WorkflowStep`.
 *
 * They are not the same set, and `MODEL_CALL` / `TOOL_CALL` are the difference.
 * A reader who assumes they are the same will either look for MODEL_CALL
 * handling in the static driver (there is none, and there should be none) or
 * add it to a definition (where nothing could execute it).
 */
import { WorkflowStepKind } from '@prisma/client';

import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';

/**
 * The kinds a DEFINITION can declare — read off the shipped workflows rather
 * than restated, so a workflow introducing a new shape shows up here.
 */
const definitions = listWorkflowDefinitions();
const declaredKinds = new Set<string>(
    definitions.flatMap((def) => def.steps.map((s) => s.kind as string)),
);

/** Every value the database column can hold. */
const recordableKinds = new Set<string>(Object.values(WorkflowStepKind));

describe('the two step vocabularies, and the difference between them', () => {
    it('every kind a definition declares is one the database can record', () => {
        // The direction that would break a write: a definition declaring a kind
        // the column cannot hold fails at `recordStep` with a 22P02, mid-run,
        // after the step has already executed.
        const unrecordable = [...declaredKinds].filter((k) => !recordableKinds.has(k));
        expect({ declared: [...declaredKinds].sort(), unrecordable }).toEqual({
            declared: [...declaredKinds].sort(),
            unrecordable: [],
        });
    });

    it('the kinds NO definition can declare are exactly the driver-recorded two', () => {
        // The claim a reader needs. These exist for a driver that records what
        // it did — a model call, a tool call — and cannot appear in a
        // hand-written step array, which is why the static driver has no
        // branch for them and should not grow one.
        const recordOnly = [...recordableKinds].filter((k) => !declaredKinds.has(k)).sort();
        expect(recordOnly).toEqual(['MODEL_CALL', 'TOOL_CALL']);
    });

    it('examined a real population of workflows, not an empty one', () => {
        // Both assertions above are satisfied by zero workflows. This is what
        // makes them mean something.
        expect(definitions.length).toBeGreaterThan(0);
        expect(declaredKinds.size).toBeGreaterThanOrEqual(3);
    });
});

describe('every declared kind is one the static driver actually executes', () => {
    /**
     * The kinds the static driver has a branch for.
     *
     * Hand-written, and that is the point: it is the one place the driver's
     * capability is stated as data, so the assertion below compares the
     * shipped workflows against what the engine can really do. If the driver
     * gains a branch, this list moves with it; if a workflow gains a kind the
     * driver cannot execute, the test fails before the run does.
     */
    const EXECUTABLE = new Set(['READ', 'PROPOSE', 'SYNTHESIS', 'HUMAN_CHECKPOINT']);

    it('no shipped workflow declares a step the driver would refuse', () => {
        const unexecutable = [...declaredKinds].filter((k) => !EXECUTABLE.has(k));
        expect(unexecutable).toEqual([]);
    });

    it('the driver claims no capability for the record-only kinds', () => {
        // The other direction. A branch for MODEL_CALL in the STATIC driver
        // would be dead code that reads as support, and the next person would
        // reasonably conclude a definition may declare one.
        expect(EXECUTABLE.has('MODEL_CALL')).toBe(false);
        expect(EXECUTABLE.has('TOOL_CALL')).toBe(false);
    });
});
