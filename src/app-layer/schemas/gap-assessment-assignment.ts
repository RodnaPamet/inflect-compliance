import { z } from 'zod';

/**
 * NIS2 gap-assessment multi-respondent delegation — request validation.
 * Roles mirror the shared bank's `respondent` enum. Dispatch maps each role to
 * a tenant member id; submit carries the assignee's answers (authorised against
 * the assignment bucket in the usecase, not here).
 */
export const NIS2_RESPONDENT_ROLE = ['CEO', 'IT', 'HR', 'PROCUREMENT', 'ANYONE'] as const;
export const NIS2_ANSWER_VALUES = ['NA', 'NO', 'PARTIALLY', 'YES'] as const;

export const DispatchAssignmentsSchema = z.object({
    // role → tenant member id (a role may be left unassigned). Role validity +
    // partitioning are enforced in the usecase against NIS2_RESPONDENT_ROLES.
    roleToUserId: z.record(z.string(), z.string().min(1).max(64)).default({}),
});

export const SubmitAssignmentSchema = z.object({
    answers: z
        .array(
            z.object({
                questionId: z.string().min(1).max(64),
                answer: z.enum(NIS2_ANSWER_VALUES),
                note: z.string().max(4000).optional().nullable(),
            }),
        )
        .max(200),
    /**
     * `true` (the default, the old behaviour) submits: every question in the
     * bucket must then hold an answer, stored or in this request, and the
     * assignment becomes SUBMITTED. `false` saves: the answers are written and a
     * PENDING assignment becomes IN_PROGRESS (#4929).
     */
    final: z.boolean().optional().default(true),
});

export const FinalizeAssessmentSchema = z.object({
    force: z.boolean().optional().default(false),
});

export type DispatchAssignmentsInput = z.infer<typeof DispatchAssignmentsSchema>;
export type SubmitAssignmentInput = z.infer<typeof SubmitAssignmentSchema>;
