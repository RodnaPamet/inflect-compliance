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
    PROFILE_EFFORTS,
    PROFILE_INSTRUCTIONS_MAX_CHARS,
    PROFILE_REJECTION_REASON_MAX_CHARS,
    PROFILE_MAX_SKILLS,
    PROFILE_MAX_TOOLS,
    PROFILE_MAX_TURNS,
    PROFILE_MODEL_TIERS,
    PROFILE_OUTPUT_KINDS,
    PROFILE_TRIGGERS,
} from '@/lib/agentic/agent-profile';

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
        toolNames: z.array(z.string().min(1).max(100)).min(1).max(PROFILE_MAX_TOOLS),
        skillRefs: z
            .array(
                z
                    .object({
                        origin: z.enum(['repository', 'tenant']),
                        name: z.string().min(1).max(64),
                    })
                    .strict(),
            )
            .max(PROFILE_MAX_SKILLS),
        modelTier: z.enum(PROFILE_MODEL_TIERS),
        effort: z.enum(PROFILE_EFFORTS),
        maxTurns: z.number().int().min(1).max(PROFILE_MAX_TURNS),
        outputKind: z.enum(PROFILE_OUTPUT_KINDS),
        allowedTriggers: z.array(z.enum(PROFILE_TRIGGERS)).min(1).max(PROFILE_TRIGGERS.length),
    })
    .strict();

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
