/**
 * Agentic workflow engine — the declarative workflow contract (Epic Agentic 1A).
 *
 * A workflow is a DECLARATIVE sequence of steps the engine runs. It composes the
 * EXISTING MCP read/propose tools — it adds orchestration + checkpoints, NOT new
 * authority. Every PROPOSE step routes through the propose-not-commit approval
 * queue; a HUMAN_CHECKPOINT pauses the run for a human. The engine can commit
 * nothing a single MCP tool couldn't.
 *
 * Step kinds:
 *   - READ            — call an MCP read tool to gather context.
 *   - PROPOSE         — call an MCP propose tool (queues a proposal, never commits).
 *   - HUMAN_CHECKPOINT— pause the run to AWAITING_APPROVAL until a human acts.
 *   - SYNTHESIS       — reason over accumulated context to produce a summary.
 */

import type {
    ProfileEffort,
    ProfileModelTier,
    ProfileOutputKind,
    ProfileSkillRef,
    ProfileTrigger,
} from './agent-profile';
import type { AgentDriver } from './agent-driver';
import type { ApprovalWindow } from './approval-window';

/** Accumulated run state. `outputs` is keyed by each step's `label`. */
export interface WorkflowContext {
    input: Record<string, unknown>;
    outputs: Record<string, unknown>;
}

export interface ReadStepDef {
    kind: 'READ';
    label: string;
    /** The MCP read tool name (e.g. 'get_compliance_posture'). */
    tool: string;
    /** Build the tool arguments from the accumulated context. */
    args?: (ctx: WorkflowContext) => Record<string, unknown>;
    /**
     * May this step FAIL WITHOUT ENDING THE RUN?
     *
     * Default `false`, which is the engine's original behaviour to the letter:
     * a throw marks the run FAILED and the run is over — every step that had
     * already succeeded is stranded in a terminal state `resumeWorkflowRun`
     * refuses. Opting in says this step gathers something the later steps can
     * do without (an optional enrichment read, a best-effort proposal), so its
     * failure is recorded against the STEP and the run carries on.
     *
     * It is NOT a way to make a run quiet. An isolated failure still writes a
     * `FAILED` WorkflowStep row carrying the reason, still emits a metric, and
     * still counts into the `stepFailures` the run's own result reports. A run
     * that completes with `stepFailures > 0` reasoned over less than it meant
     * to, and its caller is handed the number rather than left to query for it.
     *
     * It is also NOT a way past a HALT. A `ContextIntegrityError`, or any error
     * carrying the `agenticFatal` brand (an operator kill, a budget breach),
     * ends the run whatever this flag says — see `isAgenticFatal` in
     * `@/lib/agentic/failure-isolation`. A per-step flag that could override a
     * kill would be the cascade it exists to prevent.
     */
    continueOnFailure?: boolean;
}

export interface ProposeStepDef {
    kind: 'PROPOSE';
    label: string;
    /** The MCP propose tool name (e.g. 'propose_controls'). */
    tool: string;
    /** Build the candidate items from the accumulated context. Empty ⇒ step skipped. */
    buildItems: (ctx: WorkflowContext) => Array<Record<string, unknown>>;
    rationale?: (ctx: WorkflowContext) => string;
    /** See `ReadStepDef.continueOnFailure` — isolate this step's failure, never a halt. */
    continueOnFailure?: boolean;
}

export interface CheckpointStepDef {
    kind: 'HUMAN_CHECKPOINT';
    label: string;
    /**
     * How long the human has, from the moment the run parks here.
     *
     * REQUIRED, with no default. Until this existed the wait was bounded by
     * `ENGINE_CAPS.WALL_CLOCK_MS`, whose own comment reads "max wall-clock a
     * run may span (across resumes)" — so spanning resumes was INTENDED. What
     * was never decided is that a HUMAN would be spending that span: sixty
     * minutes is a sensible ceiling on unattended execution and an absurd one
     * on deliberation. An approval that took longer left the run unresumable
     * while the runs list went on offering a Resume button, and the failure
     * arrived as a RUNTIME_MS halt naming a cap no reviewer has heard of.
     * See `approval-window.ts`.
     *
     * A default would be a fourth way to answer this implicitly, and an
     * implicit answer is the defect. A pack review and a policy sign-off do
     * not deserve the same window, and an author who cannot say which this is
     * has not finished designing the step.
     */
    approvalWindow: ApprovalWindow;
    /**
     * A checkpoint CANNOT opt into failure isolation, and `never` is how that is
     * said to the compiler rather than to a reader.
     *
     * Declaring it (as an always-`undefined` optional) keeps the property
     * readable across the `WorkflowStepDef` union — the executor asks every step
     * the same question — while making `continueOnFailure: true` on a checkpoint
     * a type error. The reason is that a checkpoint's failure is not a step
     * failing at its work: the only things it does are record a PENDING row and
     * park the run, so a throw there means the run could not be parked. Carrying
     * on past that would run the steps a human was supposed to gate.
     */
    continueOnFailure?: never;
}

export interface SynthesisStepDef {
    kind: 'SYNTHESIS';
    label: string;
    /** Produce a summary (and optional structured data) from the context. */
    synthesize: (ctx: WorkflowContext) => { text: string; data?: Record<string, unknown> };
    /** See `ReadStepDef.continueOnFailure` — isolate this step's failure, never a halt. */
    continueOnFailure?: boolean;
}

export type WorkflowStepDef =
    | ReadStepDef
    | ProposeStepDef
    | CheckpointStepDef
    | SynthesisStepDef;

export interface WorkflowDefinition {
    /**
     * WHICH ENGINE this workflow asks to be executed by. Absent means `static`,
     * which is what every workflow shipped today wants and gets.
     *
     * A REQUEST, never a grant. `selectRunDriver` intersects it with what the
     * deployment permits — the operator's `AGENT_DRIVER_FLUE`, the tenant's
     * toggle and whether this build implements the driver at all — and any
     * disagreement resolves to `static`. A workflow definition is a piece of
     * configuration, so it must not be able to widen its own authority.
     *
     * `tool-runner` is a request no build can grant yet (Step 2b): its
     * `DRIVER_IMPLEMENTED` flag is false.
     */
    driver?: AgentDriver;

    /**
     * WHICH SKILLS this workflow's agent loads (#3470), by Agent Skills name.
     *
     * A DECLARATION, like `driver` above, and bounded the same way: the driver
     * resolves these names against the shipped corpus and refuses an unknown
     * one, so a definition cannot conjure expertise that is not on disk and
     * reviewed. Absent means none, which is what every static workflow wants.
     *
     * Skills are progressively disclosed — each one mounted costs a catalog
     * line in EVERY system prompt — so this list is a per-turn cost, not just a
     * capability. `assertCatalogWithinBudget` bounds it.
     */
    skills?: readonly string[];

    /**
     * WHICH `input` KEYS THIS WORKFLOW CANNOT RUN WITHOUT (#3600).
     *
     * Checked at admission by `startWorkflowRun`, before the run row exists,
     * and a missing or blank one is a `badRequest` naming the key.
     *
     * ── WHY THIS IS A DECLARATION AND NOT A DEFAULT ────────────────────────
     *
     * Both workflows that take a `frameworkKey` used to read it as
     * `typeof ctx.input.frameworkKey === 'string' ? ctx.input.frameworkKey : ''`.
     * That fallback satisfies the declared `string` and is the whole bug: it
     * converts "the caller did not say which framework" into a value, and the
     * two tools downstream disagree about what that value means.
     * `find_coverage_gaps` declares `z.string().min(1)` and rejects it;
     * `get_framework_status` declares `.optional()` and treats falsy as a
     * SUPPORTED mode, returning the installable-framework catalogue instead of
     * the per-framework readout. So the first step succeeded with the wrong
     * semantics and was recorded DONE, and only the second step's validator
     * stopped the run — 7 production failures between 2026-07-02 and
     * 2026-09-19, all of them this.
     *
     * The crash was the lucky part. Had both tools been `.optional()` the run
     * would have COMPLETED and produced an audit-readiness pack computed
     * against the wrong scope, with nothing in its record looking wrong.
     *
     * So the value must never be produced. A required input is refused at the
     * door, which is also where this function's other pre-flights live and for
     * the reason stated there: a refusal after the row exists is "a refusal
     * wearing the costume of an outage".
     *
     * Absent means the workflow needs nothing, which is what `posture-review`
     * and `access-posture` want — they read no `ctx.input` key at all.
     */
    requiredInput?: readonly string[];

    /**
     * THIS WORKFLOW PROPOSES NOTHING (#3749), by construction rather than by
     * its description.
     *
     * Leaving out a PROPOSE step is not enough on the Flue engine: a Flue run
     * is offered every propose tool its agent is granted (`flueToolsFor`), and
     * the model chooses its own calls. With this set the run is offered the
     * read surface alone, whatever the agent holds, and each propose tool it
     * would otherwise have had is listed in the run's omissions as
     * `READ_ONLY_WORKFLOW`. A definition carrying it declares no PROPOSE step
     * either (`tests/unit/agentic/audit-narrative-workflow.test.ts`).
     *
     * Only ever NARROWS. Absent means the engine's usual offer.
     */
    readOnly?: true;

    /**
     * THE PUBLIC A2A SKILL this workflow is advertised as, on the host-consumer
     * agent card (#3862) — or ABSENT, which means it is never advertised.
     * Absent is the default and the safe one: a workflow reaches the public
     * card only by someone writing copy for it in a reviewed diff.
     *
     * NOT `skills` above. That field names AGENT SKILLS — prompt material
     * mounted on the Flue engine, internal to a run. This one is the A2A
     * protocol's `AgentSkill`, read by a host that has never talked to us. The
     * two have nothing to do with each other and the collision is the
     * protocol's, not ours.
     *
     * WRITTEN, NEVER GENERATED. Deriving this from step tool names would
     * publish exactly what R19 withholds — `tool: 'get_compliance_posture'` is
     * a tool name, and the card is fetched by anyone. So the copy is prose
     * aimed at a stranger, and a reviewer can read what it discloses.
     *
     * `tags` is REQUIRED by the A2A v0.3.0 schema (`AgentSkill.required` is
     * `["description","id","name","tags"]`), which is why it is not optional
     * here even though nothing of ours reads it.
     *
     * NO `id` HERE ON PURPOSE. The card's skill id must be the workflow key,
     * because that is what a host sends back as `workflowKey`. An authored id
     * could disagree with the key and the card would then advertise a skill
     * nobody can invoke, so the id is not authored at all —
     * `advertisedA2aSkills` takes it from `key`.
     */
    a2aSkill?: A2aPublicSkillCopy;

    /**
     * THE AGENT PROFILE VERSION this definition was compiled from (Step 1a of
     * `docs/claude-agent-sdk-design.md`, #4143), or ABSENT for every
     * registered workflow.
     *
     * Present only on a definition `resolveRunDefinition` compiled from an
     * APPROVED version inside the caller's tenant; no registered definition
     * carries it. Admission refuses a definition carrying it on an engine that
     * cannot run a profile (`runsProfiles`), before the run row exists, and a
     * run that is admitted pins `versionId` and `instructionsHash`.
     */
    profile?: ProfileRunSpec;

    key: string;
    name: string;
    description: string;
    steps: WorkflowStepDef[];
}

/**
 * One approved agent profile version, as an engine that runs profiles reads it.
 * `instructions` is the decrypted text, whose hash `resolveRunDefinition` has
 * just recomputed and compared with `instructionsHash`; it is the operator's
 * own block in the prompt and never a grant. `toolNames` only narrows: an
 * engine intersects it with the agent's current grants (`offerToolSet`'s
 * `profileTools`).
 */
export interface ProfileRunSpec {
    readonly profileId: string;
    readonly agentId: string;
    readonly versionId: string;
    readonly version: number;
    readonly instructions: string;
    readonly instructionsHash: string;
    readonly toolNames: readonly string[];
    readonly skillRefs: readonly ProfileSkillRef[];
    readonly modelTier: ProfileModelTier;
    readonly effort: ProfileEffort;
    readonly maxTurns: number;
    readonly outputKind: ProfileOutputKind;
    readonly allowedTriggers: readonly ProfileTrigger[];
}

/**
 * One entry of the host-consumer card's `skills`, in the A2A v0.3.0 shape.
 *
 * `id` is the workflow key: it is what a host sends back as `workflowKey`, so
 * the card's own identifier has to be the thing the call names. Anything else
 * would make the card describe a skill the caller cannot then invoke.
 */
export interface A2aPublicSkill {
    /** The workflow key. What the host names when it calls. */
    readonly id: string;
    readonly name: string;
    /** Prose for a stranger. No tool names, no tenant names. */
    readonly description: string;
    /** Keywords. Required by the A2A schema. */
    readonly tags: readonly string[];
    /** Example prompts, a hint to the client. Optional in the A2A schema. */
    readonly examples?: readonly string[];
}

/**
 * What an author writes on a definition: the copy, without the id. The id is
 * the workflow key and is supplied by `advertisedA2aSkills`, so the two cannot
 * drift apart.
 */
export type A2aPublicSkillCopy = Omit<A2aPublicSkill, 'id'>;

/**
 * Hard per-run guardrails for an autonomous multi-step agent. A run that
 * breaches any of these is FAILED (never a half-applied mess — writes are
 * proposals, so nothing is half-committed by design).
 */
export const ENGINE_CAPS = {
    /** Max steps a single run may execute. */
    MAX_STEPS: 50,
    /** Max estimated token/cost budget per run. */
    MAX_TOKENS: 200_000,
    /** Max wall-clock a run may span (across resumes), in ms. */
    WALL_CLOCK_MS: 60 * 60 * 1000,
} as const;

/** Cheap token estimate for a step's output (≈4 chars/token). */
export function estimateTokens(value: unknown): number {
    try {
        return Math.ceil(JSON.stringify(value ?? '').length / 4);
    } catch {
        return 0;
    }
}
