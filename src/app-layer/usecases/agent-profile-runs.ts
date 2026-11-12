/**
 * WHICH DEFINITION A RUN EXECUTES — a registered workflow, or an agent profile
 * version compiled into one (Step 1a of `docs/claude-agent-sdk-design.md`,
 * #4143; the Test run and the Tool Runner, Step 2c, #4150).
 *
 * `startWorkflowRun` asks `resolveRunDefinition` instead of reading the
 * registry directly, so admission, caps, budget, concurrency, the ledger and
 * the runs tab apply to a profile without a parallel path.
 *
 *   • Any key that does not ask for a profile behaves exactly as before: the
 *     registry's definition, or `Unknown workflow`.
 *   • `agent-profile:<profileId>@v<n>` is read INSIDE THE CALLER'S TENANT (the
 *     tenant filter and RLS both), and only an APPROVED version that is the
 *     profile's version in force resolves.
 *   • A profile key resolves only for a caller that names the TRIGGER starting
 *     it (#5367), and only when the version allows that trigger: `ASK` from
 *     `startInteractiveRun`, `AUTOMATION` from the `agent-invoke` dispatcher,
 *     `TEST_RUN` from the Test-run usecase. A start that names none — the
 *     generic `POST /agent-runs`, a person or a key alike — is refused
 *     `PROFILE_TRIGGER_REQUIRED`: it is none of the triggers a version can
 *     allow, so `allowedTriggers` could not decide it.
 *   • `agent-profile:<profileId>@v<n>:test-run` is a TEST RUN, admitted only
 *     when the caller says so (`trigger: 'TEST_RUN'`, which only the Test-run
 *     usecase passes). It may name the SUBMITTED version too, so a reviewer can
 *     try what they are asked to approve; the version must allow the
 *     `TEST_RUN` trigger; and the definition is READ-ONLY whatever the
 *     profile's output kind.
 *
 * Anything else is refused with a named reason, so a key naming another
 * tenant's profile is indistinguishable from one naming no profile at all.
 *
 * A resolved profile asks for the Tool Runner engine, the one engine that runs
 * a profile (`runsProfiles`). Admission refuses it on any other engine before
 * the run row exists.
 *
 * A version carrying a FLOW (Phase 1 of `docs/ai-architecture/langflow.md`) is
 * compiled with it: the content hash recomputed covers the flow, a stored flow
 * this build cannot read or whose tools disagree with `toolNames` resolves to
 * nothing, and a flow with no propose node makes the definition read-only. It
 * RESOLVES but does not RUN: admission refuses it on every engine
 * (`PROFILE_FLOW_NOT_RUNNABLE`, `runsFlows`) until Phase 5 gives an engine a
 * way to perform every step a flow can draw, a `subagent` step included.
 *
 * THE WORKER does not resolve by approval: it executes what admission PINNED.
 * `resolvePinnedRunDefinition` rebuilds the definition from the run's own
 * `profileVersionId` and checks the instructions still hash to
 * `profileInstructionsHash`, so a version approved, rejected or superseded
 * after the run started changes nothing about the run.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { AppError, ValidationError, badRequest } from '@/lib/errors/types';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import type { ProfileRunSpec, WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { AGENT_DRIVERS, isReasoningEngine, type AgentDriver } from '@/lib/agentic/agent-driver';
import {
    isProfileRunKey,
    parseProfileRunKey,
    profileRunKey,
    PROFILE_EFFORTS,
    PROFILE_MODEL_TIERS,
    PROFILE_OUTPUT_KINDS,
    PROFILE_TRIGGERS,
    runsFlows,
    runsProfiles,
    type ProfileSkillRef,
    type ProfileTrigger,
} from '@/lib/agentic/agent-profile';
import { compileFlow, flowToolsAgree, parseStoredAgentFlow, type CompiledFlow } from '@/lib/agentic/agent-flow';
import { runMessage } from '@/lib/agentic/flue/run-message';
import { agentProfilesOn, assertMayManageProfiles, profileContentHash } from './agent-profiles';

export type ProfileRunRefusal =
    | 'PROFILES_DISABLED'
    | 'PROFILE_KEY_INVALID'
    | 'PROFILE_NOT_FOUND'
    | 'PROFILE_VERSION_NOT_APPROVED'
    | 'PROFILE_AGENT_MISMATCH'
    | 'PROFILE_HASH_MISMATCH'
    | 'PROFILE_NEEDS_REASONING_ENGINE'
    | 'PROFILE_ENGINE_CANNOT_RUN_PROFILES'
    | 'PROFILE_FLOW_NOT_RUNNABLE'
    | 'PROFILE_TEST_RUN_KEY'
    | 'PROFILE_TRIGGER_REQUIRED'
    | 'PROFILE_TRIGGER_NOT_ALLOWED';

function refuse(reason: ProfileRunRefusal, message: string): AppError {
    if (reason === 'PROFILE_AGENT_MISMATCH') {
        return new AppError(`${reason}: ${message}`, 'FORBIDDEN', 403, true, { reason });
    }
    return new ValidationError(`${reason}: ${message}`, { reason });
}

/**
 * The definition's description, which the engine shows the model as the run's
 * task. The operator's instructions travel separately, in their own fenced
 * block, so this stays one fixed sentence.
 */
const PROFILE_RUN_DESCRIPTION =
    'Run an agent profile: follow the operator instructions pinned to this run, using only the tools ' +
    'the profile names and the agent is granted.';

export interface ResolvedRunDefinition {
    readonly def: WorkflowDefinition;
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | null {
    return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function readSkillRefs(raw: unknown): ProfileSkillRef[] | null {
    if (!Array.isArray(raw)) return null;
    const out: ProfileSkillRef[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') return null;
        const { origin, name } = r as { origin?: unknown; name?: unknown };
        if ((origin !== 'repository' && origin !== 'tenant') || typeof name !== 'string') return null;
        out.push({ origin, name });
    }
    return out;
}

/** The columns both resolvers read, and nothing else. */
const VERSION_SELECT = {
    id: true,
    version: true,
    status: true,
    instructions: true,
    instructionsHash: true,
    toolNames: true,
    flowJson: true,
    skillRefs: true,
    modelTier: true,
    effort: true,
    maxTurns: true,
    outputKind: true,
    allowedTriggers: true,
    profile: { select: { id: true, agentId: true, currentApprovedVersion: true } },
} as const;

interface VersionRow {
    id: string;
    version: number;
    status: string;
    instructions: string;
    instructionsHash: string;
    toolNames: string[];
    flowJson: string | null;
    skillRefs: unknown;
    modelTier: string;
    effort: string;
    maxTurns: number;
    outputKind: string;
    allowedTriggers: string[];
    profile: { id: string; agentId: string; currentApprovedVersion: number | null };
}

/**
 * Compile a version into the definition a run executes. `null` for a row
 * carrying a setting this build does not recognise: the CHECKs hold every one
 * of them, so such a row was written by a build whose vocabulary this one does
 * not share, and a run must execute what was approved or nothing.
 */
function compileProfileDefinition(
    workflowKey: string,
    row: VersionRow,
    opts: { testRun: boolean },
): WorkflowDefinition | null {
    const modelTier = oneOf(row.modelTier, PROFILE_MODEL_TIERS);
    const effort = oneOf(row.effort, PROFILE_EFFORTS);
    const outputKind = oneOf(row.outputKind, PROFILE_OUTPUT_KINDS);
    const triggers = row.allowedTriggers.map((t) => oneOf(t, PROFILE_TRIGGERS));
    const skillRefs = readSkillRefs(row.skillRefs);
    if (!modelTier || !effort || !outputKind || triggers.some((t) => t === null) || !skillRefs) return null;
    // A stored flow is read back strictly: one this build cannot read, or whose
    // tools are not the version's tools, runs nothing rather than running as a
    // version with no flow.
    let flow: CompiledFlow | undefined;
    if (row.flowJson !== null) {
        const parsed = parseStoredAgentFlow(row.flowJson);
        if (!parsed || !flowToolsAgree(parsed, row.toolNames)) return null;
        flow = compileFlow(parsed);
    }

    const profile: ProfileRunSpec = {
        profileId: row.profile.id,
        agentId: row.profile.agentId,
        versionId: row.id,
        version: row.version,
        instructions: row.instructions,
        instructionsHash: row.instructionsHash,
        toolNames: row.toolNames,
        skillRefs,
        modelTier,
        effort,
        maxTurns: row.maxTurns,
        outputKind,
        allowedTriggers: triggers.filter((t): t is NonNullable<typeof t> => t !== null),
        ...(flow ? { flow } : {}),
    };

    return {
        key: workflowKey,
        name: opts.testRun
            ? `Agent profile, version ${row.version} (Test run)`
            : `Agent profile, version ${row.version}`,
        description: PROFILE_RUN_DESCRIPTION,
        // A REQUEST for the Tool Runner engine, the one engine that runs a
        // profile (Step 2c), intersected by `selectRunDriver` with what the
        // deployment and the tenant permit, as for any definition.
        driver: 'tool-runner',
        // A Test run is read-only whatever the profile would do in force: it
        // is how a person tries a version, and a try must not queue proposals.
        // So is a flow with no propose node: what the person drew proposes
        // nothing, so the run is offered the read surface only.
        ...(opts.testRun || outputKind === 'ANSWER_ONLY' || flow?.readOnly ? { readOnly: true as const } : {}),
        steps: [
            {
                kind: 'SYNTHESIS',
                label: 'answer',
                // Never reached: admission refuses a profile on the static
                // engine before the run row exists. Kept honest anyway, the way
                // `ad-hoc-question` says what the static engine cannot do.
                synthesize: () => ({
                    text: 'No answer was produced: an agent profile runs on a reasoning engine.',
                    data: { answered: false, reason: 'PROFILE_NEEDS_REASONING_ENGINE' },
                }),
            },
        ],
        profile,
    };
}

export async function resolveRunDefinition(
    ctx: RequestContext,
    workflowKey: string,
    opts: { trigger?: ProfileTrigger } = {},
): Promise<ResolvedRunDefinition> {
    if (!isProfileRunKey(workflowKey)) {
        const def = getWorkflowDefinition(workflowKey);
        if (!def) throw badRequest(`Unknown workflow: ${workflowKey}`);
        return { def };
    }

    if (!(await agentProfilesOn(ctx.tenantSlug))) {
        throw refuse('PROFILES_DISABLED', 'Agent profiles are not enabled for this workspace.');
    }
    const parsed = parseProfileRunKey(workflowKey);
    if (!parsed) {
        throw refuse('PROFILE_KEY_INVALID', 'An agent profile run key reads agent-profile:<profileId>@v<version>.');
    }
    // A Test-run key is accepted only from the Test-run usecase, and that
    // usecase only ever starts one: the two must agree.
    const testRun = opts.trigger === 'TEST_RUN';
    if (parsed.testRun !== testRun) {
        throw refuse(
            'PROFILE_TEST_RUN_KEY',
            'A Test run of an agent profile starts from the agent\'s Behaviour tab, and only a Test run uses its key.',
        );
    }
    // A PROFILE KEY NAMES ITS TRIGGER (#5367). `allowedTriggers` is the
    // version's own statement of what may start it, and it can only be held
    // where the start says which trigger it is. A start that names none was
    // admitted unchecked, so a version allowing only TEST_RUN ran from an
    // automation rule or the generic start route. Before the version read:
    // the refusal is about the request, and costs nothing.
    if (!opts.trigger) {
        throw refuse(
            'PROFILE_TRIGGER_REQUIRED',
            'An agent profile runs from the Ask page, an automation rule or the Behaviour tab\'s Test run, as ' +
                'its version allows. This start is none of them.',
        );
    }

    const row = await runInTenantContext(ctx, (db) =>
        db.agentProfileVersion.findFirst({
            where: { tenantId: ctx.tenantId, profileId: parsed.profileId, version: parsed.version },
            select: VERSION_SELECT,
        }),
    );
    if (!row) throw refuse('PROFILE_NOT_FOUND', 'No agent profile version answers to this key in this workspace.');
    const inForce = row.status === 'APPROVED' && row.profile.currentApprovedVersion === row.version;
    if (!inForce && !(testRun && row.status === 'SUBMITTED')) {
        throw refuse(
            'PROFILE_VERSION_NOT_APPROVED',
            testRun
                ? 'A Test run tries the approved version in force or the version submitted for review.'
                : 'Only the approved version in force of an agent profile runs. Approve a version, then start it.',
        );
    }
    if (ctx.agentId && ctx.agentId !== row.profile.agentId) {
        throw refuse('PROFILE_AGENT_MISMATCH', "A profile runs as its own agent, and this caller speaks for another.");
    }
    if (profileContentHash(row.instructions, row.flowJson) !== row.instructionsHash) {
        throw refuse(
            'PROFILE_HASH_MISMATCH',
            'The stored instructions or flow no longer match the hash their approval pinned. The version cannot run.',
        );
    }
    if (!row.allowedTriggers.includes(opts.trigger)) {
        throw refuse(
            'PROFILE_TRIGGER_NOT_ALLOWED',
            `This version does not allow the ${opts.trigger} trigger. Edit the profile to allow it.`,
        );
    }

    const def = compileProfileDefinition(workflowKey, row, { testRun });
    if (!def) {
        throw refuse('PROFILE_VERSION_NOT_APPROVED', 'This version carries a setting this build does not recognise.');
    }
    return { def };
}

/**
 * The definition a STARTED run executes, rebuilt from what admission pinned.
 *
 * Read by the worker and by resume. A registered workflow key resolves from the
 * registry, as it always has. A profile key resolves from the run's own
 * `profileVersionId`, whatever that version's status is now, and only while
 * its instructions still hash to the run's `profileInstructionsHash`: the run
 * executes what it was admitted with, or nothing. `undefined` means the run
 * cannot continue, and the caller fails it.
 */
export async function resolvePinnedRunDefinition(
    ctx: RequestContext,
    run: { workflowKey: string; profileVersionId: string | null; profileInstructionsHash: string | null },
): Promise<WorkflowDefinition | undefined> {
    if (!isProfileRunKey(run.workflowKey)) return getWorkflowDefinition(run.workflowKey);
    const parsed = parseProfileRunKey(run.workflowKey);
    if (!parsed || !run.profileVersionId || !run.profileInstructionsHash) return undefined;
    const row = await runInTenantContext(ctx, (db) =>
        db.agentProfileVersion.findFirst({
            where: { id: run.profileVersionId!, tenantId: ctx.tenantId },
            select: VERSION_SELECT,
        }),
    );
    if (!row || row.profile.id !== parsed.profileId || row.version !== parsed.version) return undefined;
    if (profileContentHash(row.instructions, row.flowJson) !== run.profileInstructionsHash) return undefined;
    const def = compileProfileDefinition(run.workflowKey, row, { testRun: parsed.testRun });
    // Admission refuses a flow version on every engine; a run carrying one was
    // not admitted by this build, so it continues as nothing.
    if (!def || (def.profile?.flow && !runsFlows(def.driver ?? 'static'))) return undefined;
    return def;
}

/**
 * Admission's check that the chosen engine can run THIS profile version. Called
 * after the engine is chosen and before the run row exists, so a refusal leaves
 * nothing behind. It takes the profile, not only the engine, so a caller cannot
 * ask whether an engine runs profiles and forget to ask whether it runs the
 * version's flow.
 */
export function assertEngineRunsProfiles(driver: AgentDriver, profile: ProfileRunSpec): void {
    if (!isReasoningEngine(driver)) {
        throw refuse(
            'PROFILE_NEEDS_REASONING_ENGINE',
            'An agent profile runs on a reasoning engine, and this workspace runs the built-in engine.',
        );
    }
    if (!runsProfiles(driver)) {
        throw refuse(
            'PROFILE_ENGINE_CANNOT_RUN_PROFILES',
            `The ${driver} engine does not run agent profiles. A profile runs once an engine that renders its ` +
                'instructions is available.',
        );
    }    // A drawn flow runs only on an engine that performs every step it can
    // draw. None does before Phase 5: a `subagent` step would be a line the
    // model cannot act on, recorded as drawn and never performed.
    if (profile.flow && !runsFlows(driver)) {
        throw refuse(
            'PROFILE_FLOW_NOT_RUNNABLE',
            'This version carries a drawn flow, and no engine performs a drawn flow yet. Write a version ' +
                'without a flow to run this profile.',
        );
    }
}

// ─── The preview (Phase 4 of `docs/ai-architecture/langflow.md`) ────

/** What an engine would be handed for one stored version, as the approver reads it. */
export type ProfileRunPreview =
    | {
          readonly state: 'SHOWN';
          readonly version: number;
          /** The run this version can have: itself in force, a Test run under review, or none. */
          readonly runAs: 'RUN' | 'TEST_RUN' | null;
          /**
           * Set when admission would refuse this version on EVERY engine, so no
           * run — whatever `runAs` says it would be — receives the message.
           * `PROFILE_FLOW_NOT_RUNNABLE` for any flow version until Phase 5.
           */
          readonly runRefused: 'PROFILE_FLOW_NOT_RUNNABLE' | 'PROFILE_ENGINE_CANNOT_RUN_PROFILES' | null;
          /** The run message, from `runMessage`, the function the engines call. */
          readonly message: string;
          /** The run is offered the read surface only. */
          readonly readOnly: boolean;
      }
    /** No such version on this agent's profile. */
    | { readonly state: 'NOT_FOUND' }
    /** The stored content no longer verifies, or carries a setting this build cannot read: no run has a message. */
    | { readonly state: 'UNRUNNABLE' };

/**
 * THE EXACT RUN MESSAGE a stored version would give an engine (Phase 4.1).
 *
 * Built by the run path's own two functions and nothing else:
 * `compileProfileDefinition`, which the resolver and the worker call, and
 * `runMessage`, which the Tool Runner and Flue call, at the first step with no
 * declared input (a profile declares none). So the panel cannot show a message
 * the engine would not send. The content hash is recomputed first, as the
 * resolver does: a version whose content no longer verifies has no message.
 *
 * Read under the profile surface's own gate (`admin.agent_registry`, 404 when
 * profiles are off). Writes nothing.
 */
export async function previewProfileRunMessage(
    ctx: RequestContext,
    agentId: string,
    version: number,
): Promise<ProfileRunPreview> {
    await assertMayManageProfiles(ctx);
    const row = await runInTenantContext(ctx, (db) =>
        db.agentProfileVersion.findFirst({
            where: { tenantId: ctx.tenantId, version, profile: { agentId } },
            select: VERSION_SELECT,
        }),
    );
    if (!row || row.profile.agentId !== agentId) return { state: 'NOT_FOUND' };
    if (profileContentHash(row.instructions, row.flowJson) !== row.instructionsHash) return { state: 'UNRUNNABLE' };
    const inForce = row.status === 'APPROVED' && row.profile.currentApprovedVersion === row.version;
    const runAs = inForce ? 'RUN' : row.status === 'SUBMITTED' ? 'TEST_RUN' : null;
    const testRun = runAs === 'TEST_RUN';
    const def = compileProfileDefinition(profileRunKey(row.profile.id, row.version, { testRun }), row, { testRun });
    if (!def || !def.profile) return { state: 'UNRUNNABLE' };
    return {
        state: 'SHOWN',
        version: row.version,
        runAs,
        runRefused: refusedOnEveryEngine(def.profile),
        message: runMessage(def, 0),
        readOnly: def.readOnly === true,
    };
}

/**
 * Would admission refuse this version on every engine there is? Asked through
 * `assertEngineRunsProfiles` itself, once per driver, so the panel cannot say
 * "a run receives this message" for a version admission refuses — which,
 * before Phase 5, is every version carrying a flow.
 */
function refusedOnEveryEngine(
    profile: ProfileRunSpec,
): 'PROFILE_FLOW_NOT_RUNNABLE' | 'PROFILE_ENGINE_CANNOT_RUN_PROFILES' | null {
    const someEngineRuns = AGENT_DRIVERS.some((driver) => {
        try {
            assertEngineRunsProfiles(driver, profile);
            return true;
        } catch (err) {
            if (err instanceof AppError) return false;
            throw err;
        }
    });
    if (someEngineRuns) return null;
    return profile.flow ? 'PROFILE_FLOW_NOT_RUNNABLE' : 'PROFILE_ENGINE_CANNOT_RUN_PROFILES';
}
