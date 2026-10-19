/**
 * Request bodies for tenant-authored skills (#3680, step 4c).
 *
 * The limits are the loader's own (`src/lib/agentic/flue/skills/index.ts`), so a
 * body that passes here is refused, if at all, by the same rules a repository
 * skill meets: the schema is the first, cheap refusal, and
 * `validateSkillFields` is the authority. Every string is sanitised at the
 * write seam (`usecases/tenant-skills.ts`) before it is checked or stored.
 *
 * Client-safe: no server import.
 */
import { z } from 'zod';

/** The loader's ceilings, restated for a form that has no server import. */
export const TENANT_SKILL_LIMITS = {
    nameChars: 64,
    descriptionChars: 1_024,
    instructionsBytes: 8_192,
    licenseChars: 200,
    sourceRefChars: 500,
    metadataChars: 500,
    workflows: 32,
    /** A record carries at most 200 cases of up to 8 KiB each, twice over. */
    recordBytes: 4 * 1024 * 1024,
} as const;

const optionalMeta = z.string().max(TENANT_SKILL_LIMITS.metadataChars).nullable().optional();

/** The fields of one version: what an edit supplies in full. */
export const TenantSkillTextSchema = z
    .object({
        description: z.string().min(1).max(TENANT_SKILL_LIMITS.descriptionChars),
        // Characters here; the loader then holds the stored text to its BYTE budget.
        instructions: z.string().min(1).max(TENANT_SKILL_LIMITS.instructionsBytes),
        license: z.string().min(1).max(TENANT_SKILL_LIMITS.licenseChars),
        sourceRef: z.string().min(1).max(TENANT_SKILL_LIMITS.sourceRefChars),
        requiredInput: optionalMeta,
        output: z.enum(['proposal', 'report']).nullable().optional(),
        controls: optionalMeta,
        tools: optionalMeta,
        workflowKeys: z.array(z.string().min(1).max(100)).max(TENANT_SKILL_LIMITS.workflows),
    })
    .strict();

export const CreateTenantSkillSchema = TenantSkillTextSchema.extend({
    name: z.string().min(1).max(TENANT_SKILL_LIMITS.nameChars),
}).strict();

/**
 * The evaluation record, in the repository's own format
 * (`SkillEvaluationRecordSchema` in `evaluation-record.ts`): the set, the model
 * that answered and the answers. Parsed strictly by the usecase; this schema
 * only bounds the envelope.
 */
export const AttachTenantSkillEvaluationSchema = z
    .object({
        record: z.record(z.string(), z.unknown()),
    })
    .strict();

/** The approver names the hash they reviewed, as the version read returned it. */
export const ApproveTenantSkillSchema = z
    .object({
        contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    })
    .strict();

export type TenantSkillTextInput = z.infer<typeof TenantSkillTextSchema>;
export type CreateTenantSkillInput = z.infer<typeof CreateTenantSkillSchema>;
