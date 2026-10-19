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
 *
 * EXPORTED because it answers the question at two different scopes, and only one
 * of them is a payload. Here it judges what the caller SENT; `updateRegisteredAgent`
 * applies the same predicate to the MERGED row — the payload laid over the
 * stored one — because that is what the DB's CHECK constraint judges. An edit
 * that only nulls `vendorId` names no provenance at all, so this call site
 * cannot see that the row it lands on is THIRD_PARTY, and without the second
 * application the first thing to notice would be Postgres.
 */
export function isUnattributedThirdParty(value: {
    provenance?: string | null;
    vendorId?: string | null;
}): boolean {
    return value.provenance === 'THIRD_PARTY' && !value.vendorId;
}

/** One wording for one rule, wherever it is applied. */
export const THIRD_PARTY_VENDOR_MESSAGE =
    'A THIRD_PARTY agent must name the vendor that supplies it';

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
 * Why an amend cannot move the owner (#3698): the accountable owner moves only by
 * a TWO-STEP transfer — proposed by one holder of `admin.agent_ownership`
 * (#3699; `admin.tenant_lifecycle` until then),
 * accepted by the person it names — at `…/admin/agents/:id/ownership-transfer`.
 * The register's PATCH takes `admin.agent_registry`, which ADMIN holds, so a
 * one-step owner change here would be a bypass of that rule by the role the owner
 * is accountable to.
 */
export const OWNER_MOVES_BY_TRANSFER_MESSAGE =
    "An agent's owner cannot be changed by amending it. Ownership moves only by a " +
    'two-step transfer: propose it at /admin/agents/{agentId}/ownership-transfer, and ' +
    'the person it names accepts it.';

/**
 * Partial update. The THIRD_PARTY refinement applies to the PAYLOAD, not the
 * merged row: naming `provenance: 'THIRD_PARTY'` requires naming the vendor in
 * the same call, even when the stored row already has one. That is deliberate —
 * the alternative reads the current row to decide whether the payload is legal,
 * which is a check that passes or fails depending on a value the caller never
 * saw. The DB CHECK constraint remains the backstop either way.
 *
 * `ownerUserId` is ACCEPTED as a key only to be REFUSED by name. The object is
 * not `.strict()`, so simply deleting the field would strip it silently: a client
 * that sent an owner change would get a 200 and an unchanged owner, and believe
 * the change had been made. An explicit 400 naming the transfer is the honest
 * answer. See `OWNER_MOVES_BY_TRANSFER_MESSAGE`.
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
        ownerUserId: z.unknown().optional(),
        vendorId: z.string().optional().nullable(),
        /**
         * Mark or unmark the agent as an AUDITOR (#3675). Setting it asks the
         * auditor independence check of the agent's CURRENT owner, and is
         * refused unless they are an ACTIVE second-line member who owns none of
         * the agents it audits; removing it is never refused, and leaves every
         * workpaper the agent wrote attributed to it.
         */
        isAuditor: z.boolean().optional(),
    })
    .superRefine((value, ctx) => {
        if (value.ownerUserId !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['ownerUserId'],
                message: OWNER_MOVES_BY_TRANSFER_MESSAGE,
            });
        }
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
 * The lifecycle moves an operator may make DIRECTLY — the two REVERSIBLE ones.
 *
 * `RETIRED` is absent on purpose and its absence is load-bearing: retirement is
 * a permanent act with a cascade (#3698) — it revokes the agent's credentials,
 * drops its tool grants, expires its open proposals and freezes its policy card
 * — so it lives on its own route (`DELETE /admin/agents/:id`), behind a typed
 * confirmation, rather than as one value in a status dropdown. Neither move here
 * applies to a retired agent: retirement is terminal. `DRAFT` is absent because
 * it is where an agent arrives; going back there would say the register had
 * never seen it.
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
        /**
         * Register the agent as an AUDITOR (#3675): it will re-perform audit
         * procedures and write workpapers. Refused unless `ownerUserId` is an
         * ACTIVE member whose line of defence an OWNER has declared SECOND, and
         * who owns none of the agents it would audit. Absent means false.
         */
        isAuditor: z.boolean().optional(),

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
        // 100 fitted the built-in catalogue, whose longest name is under 30. An
        // EXTERNAL tool's grantable name is qualified — `mcp__<cuid>__<name>`,
        // about 32 characters before the server's own name — so the old cap
        // could refuse at grant a tool the catalogue had already offered as
        // available. A name is not user prose and does not need room to grow;
        // this is sized to make available and grantable the same set.
        .max(200)
        .trim(),
});
export type AgentToolGrantInput = z.infer<typeof AgentToolGrantSchema>;

// ─── Registration intake: a SHADOW_AGENT finding → a DRAFT register row ─────

/**
 * The registration intake (#3669, step 2a) — register a shadow agent a harness
 * scan found, through a PROVISIONAL AI-system entry at UNCLASSIFIED.
 *
 * The same agent fields as `RegisterAgentSchema`, and like it the three
 * exposure axes are REQUIRED with no default: a scan says what an agent is
 * called and where it was seen, never how far into tenant data it reaches, so a
 * person declares those here. There is NO classification questionnaire and no
 * `riskTier`: the entry is created unclassified on purpose, and classifying it
 * is its own act (`POST /ai-systems/:id/classification`). `.strict()`, so a
 * `riskTier` (or any other undeclared key) in the body is a 400 rather than
 * silently stripped.
 *
 * THE OWNER IS A PERSON'S EXPLICIT CHOICE. `ownerUserId` names them and
 * `confirmOwner: true` confirms it. Both are optional in the SHAPE only so the
 * usecase can refuse their absence with its own named reason
 * (`OWNER_NOT_CONFIRMED`) instead of a generic validation error. `attribution`
 * is the attribution skill's answer, if one was produced; the usecase parses it
 * through 1d's contract and keeps it as provenance. It never supplies the
 * owner.
 */
export const RegistrationIntakeSchema = z
    .object({
        findingId: z.string().min(1, 'The SHADOW_AGENT finding to register from is required'),
        ownerUserId: z.string().min(1).optional(),
        confirmOwner: z.boolean().optional(),
        name: z.string().min(2, 'Name is required').max(200).trim(),
        description: z.string().max(4000).optional().nullable(),
        autonomyLevel,
        dataAccessScope: z.enum(AGENT_DATA_ACCESS_SCOPES),
        reversibility: z.enum(AGENT_REVERSIBILITIES),
        provenance: z.enum(AGENT_PROVENANCES),
        modelRef,
        vendorId: z.string().optional().nullable(),

        // ── The provisional EU AI Act register entry ──
        purpose: z.string().max(4000).optional().nullable(),
        useContext: z.string().max(4000).optional().nullable(),
        provider: z.string().max(200).optional().nullable(),
        deploymentRole: z.enum(['PROVIDER', 'DEPLOYER']).default('DEPLOYER'),

        /**
         * The `nhi-ownership-attribution` answer — provenance, never the owner.
         * Either the answer itself (parsed through the skill's contract), or
         * `{ runId }` naming the review run whose answer the server STORED
         * (`StoredSuggestionRefSchema`, #3728) — the form the harness tab's
         * dialog sends, since it never holds the person the answer named.
         */
        attribution: z.unknown().optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (!isUnattributedThirdParty(value)) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['vendorId'],
            message: THIRD_PARTY_VENDOR_MESSAGE,
        });
    });
export type RegistrationIntakeInput = z.infer<typeof RegistrationIntakeSchema>;

/**
 * A reference to a STORED owner suggestion (#3728): the review run whose parsed
 * answer `DiscoveredAgentAttribution` holds for the agent being registered.
 * Strict, so an answer the request carries — which always has a `status` — can
 * never be read as one.
 */
export const StoredSuggestionRefSchema = z.object({ runId: z.string().trim().min(1).max(64) }).strict();
