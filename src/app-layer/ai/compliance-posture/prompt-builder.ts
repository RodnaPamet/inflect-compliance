/**
 * AI Compliance-Posture Summary — Prompt Builder.
 *
 * Builds a system + user prompt from the AGGREGATE signals. Unlike the
 * risk-assessment prompt, there is no tenant-supplied free text here — every
 * field is a number or a catalog-derived framework label — so there is no
 * prompt-injection surface to fence. The prompt asks for STRICT JSON matching
 * PostureSummaryResult.
 */
import type { PostureSummaryInput } from './types';
import { POSTURE_LABELS } from './types';

export interface PromptPair {
    system: string;
    user: string;
    /** JSON-schema string appended to the user turn to pin the output shape. */
    responseSchema: string;
}

export function buildPosturePrompt(input: PostureSummaryInput): PromptPair {
    const system = [
        'You are a senior GRC (Governance, Risk, Compliance) analyst.',
        'You are given an AGGREGATE, anonymised snapshot of one organization\'s',
        'compliance posture (counts and percentages only — no entity names).',
        '',
        '## Your task',
        '- Summarise the overall posture in 1-3 plain-English sentences.',
        `- Assign a postureLabel — exactly one of: ${POSTURE_LABELS.join(', ')}.`,
        '- Assign a maturityScore from 0 to 100 (higher = stronger).',
        '- Give 2-3 POINTED, PRIORITIZED, EFFICIENT next actions that would most',
        '  improve the posture, ordered by impact. Each action has a short title,',
        '  a one-sentence detail, and a priority of high/medium/low.',
        '',
        '## Rules',
        '- Base every statement ONLY on the numbers provided. Do not invent facts.',
        '- Be concrete and specific (reference the actual gap, e.g. overdue evidence,',
        '  lowest-coverage framework, unmitigated high risks).',
        '- Output ONLY valid JSON matching the schema. No markdown, no commentary.',
    ].join('\n');

    const signals = {
        controlCoveragePercent: input.controls.coveragePercent,
        controlsImplemented: input.controls.implemented,
        controlsApplicable: input.controls.applicable,
        controlsInProgress: input.controls.inProgress,
        controlsNotStarted: input.controls.notStarted,
        // `requirementsMappedPercent`, NOT `coveragePercent`. The key beside it
        // — `controlCoveragePercent` — is implementation, and when both were
        // called coverage the model had no way to tell a link count from an
        // implemented control.
        frameworks: input.frameworks.map((f) => ({
            name: f.name,
            requirementsMappedPercent: f.requirementsMappedPercent,
            requirementsImplementedPercent: f.requirementsImplementedPercent,
            requirementsMapped: f.mapped,
            requirementsImplemented: f.implemented,
            requirementsTotal: f.total,
        })),
        openRisks: input.risks,
        evidence: input.evidence,
        openFindings: input.findings.open,
        tasks: input.tasks,
        policies: input.policies,
        vendorsOverdueReview: input.vendors.overdueReview,
        selfAssessedMaturityAverage0to5: input.maturityAverage,
    };

    const user = [
        'Here is the aggregate compliance-posture snapshot as JSON:',
        JSON.stringify(signals, null, 2),
        '',
        'Produce the posture summary now.',
    ].join('\n');

    const responseSchema = JSON.stringify(
        {
            type: 'object',
            properties: {
                postureLabel: { type: 'string', enum: [...POSTURE_LABELS] },
                maturityScore: { type: 'integer', minimum: 0, maximum: 100 },
                summaryText: { type: 'string' },
                advice: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 3,
                    items: {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            detail: { type: 'string' },
                            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                        },
                        required: ['title', 'detail', 'priority'],
                    },
                },
            },
            required: ['postureLabel', 'maturityScore', 'summaryText', 'advice'],
        },
        null,
        2,
    );

    return { system, user, responseSchema };
}
