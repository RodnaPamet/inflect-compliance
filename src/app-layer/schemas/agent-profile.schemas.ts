/**
 * Request bodies for agent profiles (Step 1a of `docs/claude-agent-sdk-design.md`, #4143).
 *
 * The schema is the first, cheap refusal. The usecase
 * (`usecases/agent-profiles.ts`) is the authority: it sanitises the
 * instructions, holds them to the size cap and the skill text scan, and checks
 * every tool against the agent's current grants. The closed vocabularies come
 * from `src/lib/agentic/agent-profile.ts`, which the database's CHECKs pin.
 *
 * Client-safe: no server import.
 */
import { z } from 'zod';

import {
    PROFILE_COMPACTION_THRESHOLD_MAX,
    PROFILE_EFFORTS,
    PROFILE_INSTRUCTIONS_MAX_CHARS,
    PROFILE_REJECTION_REASON_MAX_CHARS,
    PROFILE_MAX_SKILLS,
    PROFILE_MAX_SUBAGENTS,
    PROFILE_MAX_TOOLS,
    PROFILE_MAX_TURNS,
    PROFILE_MODEL_TIERS,
    PROFILE_OUTPUT_KINDS,
    PROFILE_TRIGGERS,
} from '@/lib/agentic/agent-profile';

const SkillRefSchema = z
    .object({
        origin: z.enum(['repository', 'tenant']),
        name: z.string().min(1).max(64),
    })
    .strict();

/**
 * One inline sub-agent (Step 2e, #4594). No description (owner decision 2,
 * 2026-11-13): a field it does not have is a 400. Its name pattern, its
 * subsets of the version's tools and skills and its turn limit are the
 * usecase's checks, each refused by name (`SUBAGENT_*`); here they are only
 * bounded.
 */
export const AgentProfileSubagentSchema = z
    .object({
        name: z.string().min(1).max(64),
        instructions: z.string().min(1).max(PROFILE_INSTRUCTIONS_MAX_CHARS),
        toolNames: z.array(z.string().min(1).max(100)).max(PROFILE_MAX_TOOLS),
        skillRefs: z.array(SkillRefSchema).max(PROFILE_MAX_SKILLS),
        maxTurns: z.number().int().min(1).max(PROFILE_MAX_TURNS),
    })
    .strict();

/**
 * One version, in full: an edit supplies every field, because a version is
 * immutable and the next one is written whole. `.strict()`, so a field the
 * profile does not have (a model id, a scope, a ceiling) is a 400 rather than
 * something silently dropped.
 */
export const AgentProfileVersionSchema = z
    .object({
        // Characters before sanitising; the usecase holds the sanitised text to
        // the same cap.
        instructions: z.string().min(1).max(PROFILE_INSTRUCTIONS_MAX_CHARS),
        // Entered for a version with no flow. With a `flow` the tools are
        // DERIVED from its nodes and never entered beside it (Phase 1 of
        // `docs/ai-architecture/langflow.md`), so naming both is a 400.
        toolNames: z.array(z.string().min(1).max(100)).min(1).max(PROFILE_MAX_TOOLS).optional(),
        // The drawn flow, as data. Its SHAPE is checked by the usecase with
        // `checkAgentFlow`, which names each refusal (a cycle, a checkpoint, a
        // tool of the wrong kind); here it is only bounded.
        flow: z.unknown().optional(),
        skillRefs: z.array(SkillRefSchema).max(PROFILE_MAX_SKILLS),
        // The version's inline sub-agents (Step 2e). Bounded here only to keep
        // a body small: the cap of PROFILE_MAX_SUBAGENTS is the usecase's, so a
        // fifth sub-agent is refused BY NAME (`SUBAGENTS_TOO_MANY`), with the
        // cap in `details`, rather than as an anonymous schema error.
        subagents: z.array(AgentProfileSubagentSchema).max(PROFILE_MAX_SUBAGENTS * 4).optional(),
        modelTier: z.enum(PROFILE_MODEL_TIERS),
        effort: z.enum(PROFILE_EFFORTS),
        maxTurns: z.number().int().min(1).max(PROFILE_MAX_TURNS),
        // The version's compaction threshold (Step 2g): absent or null takes the
        // engine's, 0 turns compaction off. Bounded loosely here: the usecase
        // refuses a value below the minimum or above the tier's engine
        // threshold BY NAME (`COMPACTION_THRESHOLD_*`), with the bound in
        // `details`, rather than as an anonymous schema error.
        compactionThresholdTokens: z.number().int().min(0).max(PROFILE_COMPACTION_THRESHOLD_MAX * 10).nullable().optional(),
        // The propose tools whose calls WAIT FOR A PERSON (Step 2f). Bounded
        // here only: the usecase refuses a tool the version lacks, a tool that
        // is not a propose tool, a list beside a flow and a tool a sub-agent
        // names BY NAME (`DEFERRED_TOOL_*`, `DEFERRED_TOOLS_WITH_FLOW`,
        // `SUBAGENT_TOOL_DEFERRED`), never as an anonymous schema error.
        deferredToolNames: z.array(z.string().min(1).max(100)).max(PROFILE_MAX_TOOLS).optional(),
        outputKind: z.enum(PROFILE_OUTPUT_KINDS),
        allowedTriggers: z.array(z.enum(PROFILE_TRIGGERS)).min(1).max(PROFILE_TRIGGERS.length),
    })
    .strict()
    .superRefine((v, issue) => {
        const hasFlow = v.flow !== undefined && v.flow !== null;
        if (hasFlow && v.toolNames !== undefined) {
            issue.addIssue({
                code: 'custom',
                path: ['toolNames'],
                message: 'FLOW_TOOLS_ARE_DERIVED: a version with a flow takes its tools from the flow; do not list them.',
            });
        }
        // A version carries a flow or sub-agents, never both (owner decision 1,
        // 2026-11-13). The usecase refuses it again, by name.
        if (hasFlow && v.subagents !== undefined && v.subagents.length > 0) {
            issue.addIssue({
                code: 'custom',
                path: ['subagents'],
                message: 'SUBAGENTS_WITH_FLOW: a version carries a drawn flow or sub-agents, never both.',
            });
        }
        if (!hasFlow && v.toolNames === undefined) {
            issue.addIssue({ code: 'custom', path: ['toolNames'], message: 'A version with no flow lists its tools.' });
        }
    });

export type AgentProfileVersionInput = z.infer<typeof AgentProfileVersionSchema>;

/** Approval names the instructions hash the approver read. */
export const ApproveAgentProfileVersionSchema = z
    .object({
        instructionsHash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict();

/** The `[version]` route segment: a positive integer, or a 400. */
export const AgentProfileVersionParamSchema = z.coerce.number().int().min(1).max(999_999_999);

/** Rejection says why, in the reviewer's words. */
export const RejectAgentProfileVersionSchema = z
    .object({
        reason: z.string().min(1).max(PROFILE_REJECTION_REASON_MAX_CHARS),
    })
    .strict();
