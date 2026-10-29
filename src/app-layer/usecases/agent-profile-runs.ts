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
import { isReasoningEngine, type AgentDriver } from '@/lib/agentic/agent-driver';
import {
    isProfileRunKey,
    parseProfileRunKey,
    PROFILE_EFFORTS,
    PROFILE_MODEL_TIERS,
    PROFILE_OUTPUT_KINDS,
    PROFILE_TRIGGERS,
    runsProfiles,
    type ProfileSkillRef,
    type ProfileTrigger,
} from '@/lib/agentic/agent-profile';
import { agentProfilesOn, profileInstructionsHash } from './agent-profiles';

export type ProfileRunRefusal =
    | 'PROFILES_DISABLED'
    | 'PROFILE_KEY_INVALID'
    | 'PROFILE_NOT_FOUND'
    | 'PROFILE_VERSION_NOT_APPROVED'
    | 'PROFILE_AGENT_MISMATCH'
    | 'PROFILE_HASH_MISMATCH'
    | 'PROFILE_NEEDS_REASONING_ENGINE'
    | 'PROFILE_ENGINE_CANNOT_RUN_PROFILES'
    | 'PROFILE_TEST_RUN_KEY'
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
        ...(opts.testRun || outputKind === 'ANSWER_ONLY' ? { readOnly: true as const } : {}),
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

    if (!agentProfilesOn(ctx.tenantSlug)) {
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
    if (profileInstructionsHash(row.instructions) !== row.instructionsHash) {
        throw refuse(
            'PROFILE_HASH_MISMATCH',
            'The stored instructions no longer match the hash their approval pinned. The version cannot run.',
        );
    }
    if (opts.trigger && !row.allowedTriggers.includes(opts.trigger)) {
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
    if (profileInstructionsHash(row.instructions) !== run.profileInstructionsHash) return undefined;
    return compileProfileDefinition(run.workflowKey, row, { testRun: parsed.testRun }) ?? undefined;
}

/**
 * Admission's check that the chosen engine can run a profile. Called after the
 * engine is chosen and before the run row exists, so a refusal leaves nothing
 * behind.
 */
export function assertEngineRunsProfiles(driver: AgentDriver): void {
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
    }
}
