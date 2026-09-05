/**
 * Zod schemas for the agent policy card.
 *
 * Every enumerated field is `z.enum(<the ladder>)` rather than a hand-written
 * union, so the schema cannot drift from the ordering the boundary enforces.
 * That is the same fix `identity-write-policy`'s route made when its PUT body
 * still accepted a rung the ladder no longer had: a value the schema admits and
 * the ladder does not rank is a write that succeeds and then refuses every call.
 *
 * `maxAutonomyLevel` is bounded 0-6 and NOT allowed to be `DENY_CEILING` (-1).
 * The seeder can produce -1 — it is what an unscored agent resolves to — but the
 * usecase refuses to create a card for an unscored agent at all, so -1 can only
 * ever arrive from a hand edit, and admitting it here would let one be typed in
 * as though it were a rung.
 */
import { z } from 'zod';

import {
    ACTION_CAP_LADDER,
    APPROVAL_LADDER,
    AUTONOMY_LADDER,
    DATA_SCOPE_LADDER,
    POLICY_CARD_RULES,
    isActionCap,
    type ActionCap,
} from '@/lib/agentic/policy-card';

/**
 * The declarations an operator may set. Every field required: a PUT that omits
 * a dimension is a PUT whose author did not say what that dimension should be,
 * and defaulting it silently is how a card ends up widened by an edit nobody
 * read as a widening.
 */
export const PolicyCardVersionSchema = z
    .object({
        permittedTools: z.array(z.string().min(1)).max(100),
        maxDataScope: z.enum(DATA_SCOPE_LADDER),
        maxAutonomyLevel: z
            .number()
            .int()
            .refine((n) => (AUTONOMY_LADDER as readonly number[]).includes(n), {
                message: 'maxAutonomyLevel must be a rung of the 0-6 autonomy ladder',
            }),
        maxActionsPerRun: z
            .number()
            .int()
            .refine((n): n is ActionCap => isActionCap(n), {
                message: `maxActionsPerRun must be one of ${ACTION_CAP_LADDER.join(', ')}`,
            }),
        maxActionsPerDay: z
            .number()
            .int()
            .refine((n): n is ActionCap => isActionCap(n), {
                message: `maxActionsPerDay must be one of ${ACTION_CAP_LADDER.join(', ')}`,
            }),
        escalationTriggers: z.array(z.enum(POLICY_CARD_RULES)),
        approvalRung: z.enum(APPROVAL_LADDER),
    })
    .strict();

export type PolicyCardVersionInput = z.infer<typeof PolicyCardVersionSchema>;

/**
 * An edit carries the version it was composed against.
 *
 * Not decoration: two operators editing the same card would otherwise both
 * write version N+1, and the second would silently overwrite a widening the
 * first had just made — including, in the worst ordering, laddering past the
 * one-rung rule by comparing against a base that had already moved. The
 * repository's conditional pointer move is what enforces it; this is where the
 * caller states what it read.
 */
export const PolicyCardUpdateSchema = z
    .object({
        expectedVersion: z.number().int().min(1),
        card: PolicyCardVersionSchema,
    })
    .strict();
