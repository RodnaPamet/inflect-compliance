/**
 * Zod schemas for the agent risk assessment.
 *
 * The tier is ABSENT from every schema here, and its absence is the point: the
 * tier is produced by `scoreAgentRisk` from the agent's own axes plus the
 * answers, and a field the client could fill in would make the assessment a
 * form rather than a judgement. Same posture as `RegisterAgentSchema`, which
 * has no `riskTier` for the EU AI Act classifier's sake.
 */
import { z } from 'zod';

import { AGENT_ANSWER_VALUES } from '@/lib/agentic/agent-risk-scoring';

/** NA | NO | PARTIALLY | YES — mirrors the AI-governance answer vocabulary. */
export const AgentAnswerValueSchema = z.enum(AGENT_ANSWER_VALUES);

/**
 * Lifecycle of one assessment run.
 *
 * There is no `SUPERSEDED`, deliberately. A completed run is never reopened —
 * the tier it produced is the record of a judgement made at a moment, and
 * editing it would rewrite that moment — so a re-score opens a NEW run and the
 * previous one simply stops being the latest. A fourth value that nothing ever
 * writes would read, to anybody browsing the table, as a state the system can
 * be in.
 */
export const AGENT_ASSESSMENT_STATUSES = ['DRAFT', 'IN_PROGRESS', 'COMPLETED'] as const;
export type AgentAssessmentStatus = (typeof AGENT_ASSESSMENT_STATUSES)[number];

/** A run in one of these states is the tenant's ACTIVE run for that agent. */
export const AGENT_ASSESSMENT_OPEN_STATUSES = ['DRAFT', 'IN_PROGRESS'] as const;

export const SaveAgentAssessmentAnswerSchema = z.object({
    questionId: z.string().min(1, 'A question id is required').max(100),
    answer: AgentAnswerValueSchema,
    /**
     * Free-text rationale. Sanitised at the usecase seam and encrypted at rest —
     * bounded here so a paste of an entire log file cannot become one row.
     */
    note: z.string().max(4000).optional().nullable(),
});
export type SaveAgentAssessmentAnswerInput = z.infer<typeof SaveAgentAssessmentAnswerSchema>;
