/**
 * Zod schemas for the agent register.
 *
 * The three exposure axes (`dataAccessScope`, `reversibility`, `provenance`)
 * are REQUIRED with no default on create. The least-exposing value is also the
 * lowest-scoring one, so a default would let a writer that forgot the field
 * silently under-state an agent's risk — an omitted axis has to fail, not score
 * zero.
 *
 * The THIRD_PARTY ⇒ vendor rule is expressed here AND as a CHECK constraint in
 * the migration. Two enforcements of one rule, on purpose: the schema gives the
 * caller a field-level error, the constraint means no other write path can get
 * around it.
 */
import { z } from 'zod';

import { ClassificationAnswersSchema } from './ai-system.schemas';

export const AGENT_DATA_ACCESS_SCOPES = [
    'NONE',
    'READ_METADATA',
    'READ_TENANT_DATA',
    'WRITE_TENANT_DATA',
    'EXTERNAL_EGRESS',
] as const;

export const AGENT_REVERSIBILITIES = ['REVERSIBLE', 'COMPENSABLE', 'TERMINAL'] as const;
export const AGENT_PROVENANCES = ['FIRST_PARTY', 'THIRD_PARTY'] as const;

/**
 * The autonomy ladder is 0-6 and it is an integer, never a boolean: the
 * register exists because "autonomous" is a spectrum, and the scorer does
 * arithmetic on this value.
 */
export const AGENT_AUTONOMY_MIN = 0;
export const AGENT_AUTONOMY_MAX = 6;

const autonomyLevel = z
    .number()
    .int('Autonomy level must be a whole number')
    .min(AGENT_AUTONOMY_MIN)
    .max(AGENT_AUTONOMY_MAX);

/**
 * The underlying model the agent runs on, as the operator DECLARES it.
 *
 * Optional and nullable on every schema here, and the two states are different:
 * omitting the key leaves the column alone, `null` clears the declaration.
 * `''` normalises to `null` at the usecase, because "declared as nothing" and
 * "never declared" are the same fact and the staleness comparison must not see
 * them as a model change.
 *
 * It exists because `MODEL_CHANGED` is one of the assessment's staleness
 * triggers, and a trigger whose input has no write path is a trigger that
 * cannot fire. It shipped without one — absent from both schemas, which are
 * strict objects, so a caller supplying `modelRef` had it silently STRIPPED and
 * the column stayed NULL for the life of every agent. Every test of the trigger
 * hand-built two values no product surface could produce, and they all passed.
 */
const modelRef = z.string().max(200).trim().optional().nullable();

/**
 * The one cross-field rule: a THIRD_PARTY agent must name its supplier.
 * Expressed as a predicate rather than a shared refinement callback so neither
 * schema has to name Zod's context type.
 */
function isUnattributedThirdParty(value: {
    provenance?: string;
    vendorId?: string | null;
}): boolean {
    return value.provenance === 'THIRD_PARTY' && !value.vendorId;
}

const THIRD_PARTY_VENDOR_MESSAGE = 'A THIRD_PARTY agent must name the vendor that supplies it';

export const CreateRegisteredAgentSchema = z
    .object({
        // The EU AI Act register entry this agent is covered by. Required —
        // every agent is an AI system in the Act's sense.
        aiSystemId: z.string().min(1, 'An AI-system register entry is required'),
        name: z.string().min(2, 'Name is required').max(200).trim(),
        description: z.string().max(4000).optional().nullable(),
        autonomyLevel,
        dataAccessScope: z.enum(AGENT_DATA_ACCESS_SCOPES),
        reversibility: z.enum(AGENT_REVERSIBILITIES),
        provenance: z.enum(AGENT_PROVENANCES),
        modelRef,
        // The accountable human. Required, so the two-person rule downstream
        // compares a value rather than guessing about a null.
        ownerUserId: z.string().min(1, 'An accountable owner is required'),
        vendorId: z.string().optional().nullable(),
    })
    .superRefine((value, ctx) => {
        if (!isUnattributedThirdParty(value)) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['vendorId'],
            message: THIRD_PARTY_VENDOR_MESSAGE,
        });
    });
export type CreateRegisteredAgentInput = z.infer<typeof CreateRegisteredAgentSchema>;

/**
 * Partial update. The THIRD_PARTY refinement applies to the PAYLOAD, not the
 * merged row: naming `provenance: 'THIRD_PARTY'` requires naming the vendor in
 * the same call, even when the stored row already has one. That is deliberate —
 * the alternative reads the current row to decide whether the payload is legal,
 * which is a check that passes or fails depending on a value the caller never
 * saw. The DB CHECK constraint remains the backstop either way.
 */
export const UpdateRegisteredAgentSchema = z
    .object({
        name: z.string().min(2).max(200).trim().optional(),
        description: z.string().max(4000).optional().nullable(),
        autonomyLevel: autonomyLevel.optional(),
        dataAccessScope: z.enum(AGENT_DATA_ACCESS_SCOPES).optional(),
        reversibility: z.enum(AGENT_REVERSIBILITIES).optional(),
        provenance: z.enum(AGENT_PROVENANCES).optional(),
        modelRef,
        ownerUserId: z.string().min(1).optional(),
        vendorId: z.string().optional().nullable(),
    })
    .superRefine((value, ctx) => {
        if (!isUnattributedThirdParty(value)) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['vendorId'],
            message: THIRD_PARTY_VENDOR_MESSAGE,
        });
    });
export type UpdateRegisteredAgentInput = z.infer<typeof UpdateRegisteredAgentSchema>;

// ─── Registration: the agent AND its EU AI Act register entry ───────

export const AGENT_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED'] as const;

/**
 * The lifecycle moves an operator may make DIRECTLY.
 *
 * `RETIRED` is absent on purpose and its absence is load-bearing: retirement is
 * refused while the agent has proposals awaiting a human, so it needs its own
 * route that can carry that refusal rather than being one value in a status
 * dropdown. `DRAFT` is absent because it is where an agent arrives; going back
 * there would say the register had never seen it.
 */
export const AGENT_LIFECYCLE_MOVES = ['ACTIVE', 'SUSPENDED'] as const;

export const SetAgentLifecycleSchema = z.object({
    status: z.enum(AGENT_LIFECYCLE_MOVES),
});
export type SetAgentLifecycleInput = z.infer<typeof SetAgentLifecycleSchema>;

/**
 * Register an agent — one payload describing BOTH the agent and the EU AI Act
 * register entry that must cover it.
 *
 * There is no `aiSystemId` here, and that is the point. `CreateRegisteredAgentSchema`
 * above takes an existing entry (the seam the isolation suite and any future
 * "adopt an existing register row" flow use); this is the operator-facing path,
 * and it AUTHORS the entry by running the deterministic Act classifier over the
 * answers below. Letting the caller supply a tier would make the register a
 * field the client fills in, which is exactly the failure the classifier exists
 * to prevent — so `riskTier` is absent from this schema and unreachable from
 * the route.
 *
 * `name` serves both rows. An agent whose register entry is called something
 * else is two names for one thing, and the register is where an auditor looks
 * the agent up.
 */
export const RegisterAgentSchema = z
    .object({
        name: z.string().min(2, 'Name is required').max(200).trim(),
        description: z.string().max(4000).optional().nullable(),
        autonomyLevel,
        dataAccessScope: z.enum(AGENT_DATA_ACCESS_SCOPES),
        reversibility: z.enum(AGENT_REVERSIBILITIES),
        provenance: z.enum(AGENT_PROVENANCES),
        modelRef,
        ownerUserId: z.string().min(1, 'An accountable owner is required'),
        vendorId: z.string().optional().nullable(),

        // ── The EU AI Act register entry authored alongside the agent ──
        purpose: z.string().max(4000).optional().nullable(),
        useContext: z.string().max(4000).optional().nullable(),
        provider: z.string().max(200).optional().nullable(),
        deploymentRole: z.enum(['PROVIDER', 'DEPLOYER']).default('DEPLOYER'),
        /** Answers to the Art 5 / Annex III / Art 50 questionnaire. */
        classification: ClassificationAnswersSchema.default({}),
    })
    .superRefine((value, ctx) => {
        if (!isUnattributedThirdParty(value)) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['vendorId'],
            message: THIRD_PARTY_VENDOR_MESSAGE,
        });
    });
export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;

/**
 * Granting one MCP tool to a registered agent.
 *
 * The tool name is a plain bounded string here rather than a `z.enum` over the
 * catalogue: the catalogue is code that ships with a deploy, and the usecase
 * checks membership against the live list so the error message can name the tool
 * the caller asked for. A schema enum would give a less useful message and would
 * still need the usecase check for the case where the two lists disagree.
 */
export const AgentToolGrantSchema = z.object({
    toolName: z
        .string()
        .min(1, 'A tool name is required')
        .max(100)
        .trim(),
});
export type AgentToolGrantInput = z.infer<typeof AgentToolGrantSchema>;
