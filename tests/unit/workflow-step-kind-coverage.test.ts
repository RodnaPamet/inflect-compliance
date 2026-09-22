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
import { readFileSync } from 'fs';
import path from 'path';

import { WorkflowStepKind } from '@prisma/client';

import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';

import { codeOf, functionBodyOf } from '../helpers/source-blocks';

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

/**
 * Read a source file as CODE, comments masked.
 *
 * `ROOT` is computed LOCALLY rather than imported, and that is the part that
 * makes assertions through this helper analysable.
 * `tests/helpers/assertion-reach.ts` constant-folds a path expression "given
 * known string constants" — a local `path.resolve(__dirname, …)` is one, and
 * an identifier imported from another module is not. With the imported
 * `REPO_ROOT` the folder gives up, every assertion on the result lands in the
 * un-analysable set, and the Class D ratchet counts three new blind spots.
 *
 * That was measured, not reasoned: hoisting the helper to module scope and
 * switching to literal needles each left the count at 1463, and only swapping
 * the root binding cleared it. Two plausible causes were wrong first.
 *
 * Masking matters for its own reason. This file's subject is two enum members
 * that several modules name in prose; a detector that cannot tell a mention
 * from a write would be satisfied by the documentation.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(readFileSync(path.join(ROOT, rel), 'utf8'));

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

describe('the record-only kinds finally have a writer, and it is the Flue engine', () => {
    const FLUE_RUN = 'src/lib/agentic/flue/execute.ts';

    /**
     * NARROWED to the two functions that own the claims.
     *
     * Not merely to satisfy a ratchet, though it does: `recordStep(` occurs
     * three times in that file and `costTokens` eight, so a whole-file needle
     * for either is satisfied by any one site — including the one you did not
     * mean. Bound to the function, each assertion says which code does the
     * thing.
     */
    const dispatchBody = functionBodyOf(read(FLUE_RUN), 'executeFlueRun');
    const toolWrapper = functionBodyOf(read(FLUE_RUN), 'wrapForLedger');

    it('records the model call, and the tool calls', () => {
        // Until the Flue driver landed, `MODEL_CALL` and `TOOL_CALL` had been
        // in the enum since the provenance migration with NO writer at all —
        // recorded in `docs/implementation-notes/2026-09-21-step-kind-
        // exhaustiveness.md` as a deliberate gap, not an oversight. This is
        // the assertion that the gap is closed, and it is here rather than in
        // a Flue-specific file so the two vocabularies and their writers are
        // described in one place.
        expect(dispatchBody).toContain("'MODEL_CALL'");
        expect(toolWrapper).toContain("'TOOL_CALL'");
    });

    it('records them THROUGH the single write seam, not directly', () => {
        // `tests/guards/workflow-step-single-write-seam.test.ts` enforces this
        // across all of src/; naming it here too keeps the claim legible next
        // to the vocabulary it is about. A driver writing the ledger its own
        // way would skip the hash-chained audit row that makes a step
        // reviewable.
        expect(dispatchBody).toContain('recordStep(');
        expect(toolWrapper).toContain('recordStep(');
        // A LITERAL needle, not a `\s*`-carrying regex: a span-carrying
        // needle is one the analyser skips outright, which would put this
        // site in the blind-spot set it also ratchets. The spaced variants
        // (`workflowStep . create`) are covered by the single-write-seam
        // guard's own scan across all of src/, which does mask and tokenise.
        expect(read(FLUE_RUN)).not.toContain('workflowStep.create');
    });

    it('charges tokens for the model call, which is the obligation the note named', () => {
        // The static driver's exhaustiveness note put it plainly: point 5 is
        // already satisfied for a definition-walking engine, and "the real
        // exposure is a future driver recording those kinds without charging".
        // This is that driver, so this is that check.
        expect(dispatchBody).toMatch(/tokens:\s*usage\.totalTokens/);
        expect(dispatchBody).toContain('costTokens += usage.totalTokens');
    });

    it('the static driver still claims neither — the two engines have not blurred', () => {
        // The other half, and the reason this describe sits in THIS file. Now
        // that a writer exists, the tempting next edit is a MODEL_CALL branch
        // in the static driver "for symmetry", which would be dead code that
        // reads as support.
        //
        // Whole-file on purpose: the claim is that no branch exists ANYWHERE
        // in that engine, which a narrowed read could not make.
        // Read INLINE at each assertion rather than bound to a local first:
        // the analyser resolves a read it can see at the assertion, and a
        // local binding is one more hop it declines to follow
        // (`binding-not-resolvable`). Two reads of the same cached file cost
        // nothing and keep both sites analysed.
        expect(read('src/lib/agentic/drivers/static-driver.ts')).not.toContain("'MODEL_CALL'");
        expect(read('src/lib/agentic/drivers/static-driver.ts')).not.toContain("'TOOL_CALL'");
    });
});
