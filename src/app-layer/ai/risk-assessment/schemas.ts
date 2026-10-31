/**
 * AI Risk Assessment — Zod Schemas
 *
 * Validates both API input and AI model output to ensure
 * structured, safe data flows through the system.
 */
import { z } from 'zod';

// ─── API Input Schema ───

export const RiskAssessmentAssetSchema = z.object({
    id: z.string(),
    name: z.string().min(1),
    type: z.string(),
    criticality: z.string().nullish(),
    classification: z.string().nullish(),
    confidentiality: z.number().int().min(1).max(5).nullish(),
    integrity: z.number().int().min(1).max(5).nullish(),
    availability: z.number().int().min(1).max(5).nullish(),
});

export const RiskAssessmentInputSchema = z.object({
    frameworks: z.array(z.string()).default([]),
    assetIds: z.array(z.string()).default([]),
    context: z.string().max(2000).optional(),
}).strip();

export type RiskAssessmentApiInput = z.output<typeof RiskAssessmentInputSchema>;

// ─── Confidence & Explainability Schemas ───

export const ConfidenceLevelSchema = z.enum(['high', 'medium', 'low']);

export const StructuredRationaleSchema = z.object({
    whyThisRisk: z.string().max(1000),
    affectedAssetCharacteristics: z.array(z.string().max(200)).max(10).default([]),
    suggestedControlThemes: z.array(z.string().max(200)).max(10).default([]),
});

// ─── AI Model Output Schema (validates structured JSON from LLM) ───

export const RiskSuggestionSchema = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(2000),
    category: z.string().max(100).optional(),
    threat: z.string().max(500).optional(),
    vulnerability: z.string().max(1000).optional(),
    likelihood: z.number().int().min(1).max(5),
    impact: z.number().int().min(1).max(5),
    rationale: z.string().max(2000),
    suggestedControls: z.array(z.string().max(300)).max(10).default([]),
    relatedAssetName: z.string().max(300).optional(),
    confidence: ConfidenceLevelSchema.default('medium'),
    structuredRationale: StructuredRationaleSchema.default({
        whyThisRisk: '',
        affectedAssetCharacteristics: [],
        suggestedControlThemes: [],
    }),
    isFallback: z.boolean().optional(),
});

export const RiskSuggestionOutputSchema = z.object({
    suggestions: z.array(RiskSuggestionSchema).min(1).max(25),
});

export type ValidatedRiskSuggestionOutput = z.infer<typeof RiskSuggestionOutputSchema>;

// ─── Session Apply Schema ───

/**
 * A reviewer's correction to one suggestion, applied with it (#4776).
 *
 * The review screen lets a person edit a suggestion's title, description,
 * likelihood and impact before accepting it. The edit used to stay in the
 * browser: this schema carried only the accepted ids, so the risk was
 * created with the model's original text. The scale bounds here are the
 * widest any matrix allows; `applySession` checks them against the
 * workspace's own scale.
 */
export const SuggestionEditSchema = z.object({
    itemId: z.string().min(1),
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(5000).nullable().optional(),
    likelihood: z.number().int().min(1).max(10).optional(),
    impact: z.number().int().min(1).max(10).optional(),
}).strip();

export type SuggestionEdit = z.infer<typeof SuggestionEditSchema>;

export const ApplySessionSchema = z.object({
    acceptedItemIds: z.array(z.string()).min(1),
    edits: z.array(SuggestionEditSchema).max(25).optional(),
}).strip();

export type ApplySessionInput = z.infer<typeof ApplySessionSchema>;

// ─── Session Dismiss Schema ───

export const DismissSessionSchema = z.object({
    reason: z.string().max(500).optional(),
}).strip();

export type DismissSessionInput = z.infer<typeof DismissSessionSchema>;
