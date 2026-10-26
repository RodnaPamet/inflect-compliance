/**
 * WHICH DEFINITION A RUN EXECUTES — a registered workflow, or an approved agent
 * profile version compiled into one (Step 1a of
 * `docs/claude-agent-sdk-design.md`, #4143).
 *
 * `startWorkflowRun` asks `resolveRunDefinition` instead of reading the
 * registry directly, so admission, caps, budget, concurrency, the ledger and
 * the runs tab apply to a profile without a parallel path.
 *
 *   • Any key that does not ask for a profile behaves exactly as before: the
 *     registry's definition, or `Unknown workflow`.
 *   • `agent-profile:<profileId>@v<n>` is read INSIDE THE CALLER'S TENANT (the
 *     tenant filter and RLS both), and only an APPROVED version that is the
 *     profile's version in force resolves. Anything else is refused with a
 *     named reason, so a key naming another tenant's profile is
 *     indistinguishable from one naming no profile at all.
 *
 * A resolved profile asks for a reasoning engine. Admission then refuses it on
 * any engine that cannot run a profile (`assertEngineRunsProfiles`), before the
 * run row exists. Today that is every engine (owner decision, 2026-10-26):
 * nothing runs a profile until Phase 2's Tool Runner engine.
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
    | 'PROFILE_ENGINE_CANNOT_RUN_PROFILES';

/**
 * A refusal a caller can act on, carrying its reason as `details.reason`.
 * Every one is a 400 except the agent mismatch, which is about who asked.
 */
function refuse(reason: ProfileRunRefusal, message: string): AppError {
    if (reason === 'PROFILE_AGENT_MISMATCH') {
        return new AppError(`${reason}: ${message}`, 'FORBIDDEN', 403, true, { reason });
    }
    return new ValidationError(`${reason}: ${message}`, { reason });
}

/** The description a profile run's definition carries. Platform text, never the tenant's. */
const PROFILE_RUN_DESCRIPTION =
    'Run an agent profile: follow the operator instructions pinned to this run, using only the tools ' +
    'the profile names and the agent is granted.';

export interface ResolvedRunDefinition {
    readonly def: WorkflowDefinition;
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | null {
    return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** The stored skill refs, read back strictly. Anything else is not a profile this build wrote. */
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

/** The definition a run of `workflowKey` executes, or a refusal with a named reason. */
export async function resolveRunDefinition(ctx: RequestContext, workflowKey: string): Promise<ResolvedRunDefinition> {
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

    const row = await runInTenantContext(ctx, (db) =>
        db.agentProfileVersion.findFirst({
            where: { tenantId: ctx.tenantId, profileId: parsed.profileId, version: parsed.version },
            select: {
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
            },
        }),
    );
    if (!row) throw refuse('PROFILE_NOT_FOUND', 'No agent profile version answers to this key in this workspace.');
    if (row.status !== 'APPROVED' || row.profile.currentApprovedVersion !== row.version) {
        throw refuse(
            'PROFILE_VERSION_NOT_APPROVED',
            'Only the approved version in force of an agent profile runs. Approve a version, then start it.',
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

    const modelTier = oneOf(row.modelTier, PROFILE_MODEL_TIERS);
    const effort = oneOf(row.effort, PROFILE_EFFORTS);
    const outputKind = oneOf(row.outputKind, PROFILE_OUTPUT_KINDS);
    const triggers = row.allowedTriggers.map((t) => oneOf(t, PROFILE_TRIGGERS));
    const skillRefs = readSkillRefs(row.skillRefs);
    if (!modelTier || !effort || !outputKind || triggers.some((t) => t === null) || !skillRefs) {
        // The CHECKs hold every one of these, so this is a row written by a
        // build whose vocabulary this one does not share. Refused rather than
        // coerced: a run must execute what was approved or nothing.
        throw refuse('PROFILE_VERSION_NOT_APPROVED', 'This version carries a setting this build does not recognise.');
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
    };

    const def: WorkflowDefinition = {
        key: workflowKey,
        name: `Agent profile, version ${row.version}`,
        description: PROFILE_RUN_DESCRIPTION,
        // A REQUEST for a reasoning engine, intersected by `selectRunDriver`
        // with what the deployment and the tenant permit, as for any
        // definition. Flue is the only reasoning engine this build has.
        driver: 'flue',
        ...(outputKind === 'ANSWER_ONLY' ? { readOnly: true as const } : {}),
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
    return { def };
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
