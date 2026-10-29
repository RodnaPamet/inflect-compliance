/**
 * Zod schemas for the NIS2 Article 23 incident-response API surface.
 *
 * Kept as plain Zod (no `.openapi()` registration) — the incident
 * surface is not part of the published OpenAPI contract yet, so we
 * avoid the openapi:generate drift gate. Free-text fields
 * (description, entry, reportText) are sanitized + encrypted at the
 * usecase layer (Epic B/D); the schemas only bound length + shape.
 */
import { z } from 'zod';

export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export const INCIDENT_TYPES = [
    'RANSOMWARE',
    'DATA_BREACH',
    'DDOS',
    'UNAUTHORIZED_ACCESS',
    'OTHER',
] as const;

export const INCIDENT_PHASES = [
    'DETECTION',
    'CLASSIFICATION',
    'EARLY_WARNING',
    'CONTAINMENT',
    'INVESTIGATION',
    'DETAILED_REPORT',
    'RECOVERY',
    'CLOSED',
] as const;

export const INCIDENT_NOTIFICATION_KINDS = [
    'EARLY_WARNING_24H',
    'DETAILED_72H',
    'FINAL_1MONTH',
] as const;

export const CreateIncidentSchema = z.object({
    title: z.string().min(1, 'Title is required').max(300),
    description: z.string().max(20000).optional(),
    severity: z.enum(INCIDENT_SEVERITIES),
    incidentType: z.enum(INCIDENT_TYPES),
    // ISO datetime — the full instant, not a day; the clock that drives the
    // Article 23 deadlines. Defaults to now() server-side if omitted;
    // `createIncident` refuses one in the future.
    detectedAt: z.string().datetime().optional(),
    ownerUserId: z.string().optional().nullable(),
    linkedControlIds: z.array(z.string()).max(100).optional(),
});

export const UpdateIncidentSchema = z.object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(20000).optional(),
    severity: z.enum(INCIDENT_SEVERITIES).optional(),
    incidentType: z.enum(INCIDENT_TYPES).optional(),
    ownerUserId: z.string().optional().nullable(),
    containedAt: z.string().datetime().optional().nullable(),
    resolvedAt: z.string().datetime().optional().nullable(),
});

export const AdvancePhaseSchema = z.object({
    // Optional explicit target phase (the stepper can set any phase).
    // Omit to advance to the next phase in the canonical order.
    toPhase: z.enum(INCIDENT_PHASES).optional(),
    note: z.string().max(5000).optional(),
});

export const MarkReportableSchema = z.object({
    // Human confirmation of the reporting obligation. The default
    // heuristic (HIGH/CRITICAL → suggested) only SUGGESTS; this flag is
    // the explicit human decision. The tenant's DPO/legal owns the call.
    reportable: z.boolean(),
    note: z.string().max(5000).optional(),
});

export const SubmitNotificationSchema = z.object({
    kind: z.enum(INCIDENT_NOTIFICATION_KINDS),
    reportText: z.string().min(1, 'Report text is required').max(50000),
    submissionRef: z.string().max(300).optional().nullable(),
});

export const AddTimelineEntrySchema = z.object({
    entry: z.string().min(1, 'Entry is required').max(5000),
});

export const LinkControlsSchema = z.object({
    controlIds: z.array(z.string()).max(200),
});

export const ToggleContainmentStepSchema = z.object({
    // The stable step key from the incidentType's containment runbook
    // (src/data/incident-containment.ts), e.g. 'RANSOMWARE-1'.
    stepKey: z.string().min(1).max(64),
    completed: z.boolean(),
});

export const LinkEvidenceSchema = z.object({
    evidenceId: z.string().min(1),
    // Optional forensic-checklist category this evidence satisfies.
    forensicCategory: z.string().max(64).optional().nullable(),
});

export type CreateIncidentInput = z.infer<typeof CreateIncidentSchema>;
export type UpdateIncidentInput = z.infer<typeof UpdateIncidentSchema>;
export type AdvancePhaseInput = z.infer<typeof AdvancePhaseSchema>;
export type MarkReportableInput = z.infer<typeof MarkReportableSchema>;
export type SubmitNotificationInput = z.infer<typeof SubmitNotificationSchema>;
export type AddTimelineEntryInput = z.infer<typeof AddTimelineEntrySchema>;
export type LinkControlsInput = z.infer<typeof LinkControlsSchema>;
export type ToggleContainmentStepInput = z.infer<typeof ToggleContainmentStepSchema>;
export type LinkEvidenceInput = z.infer<typeof LinkEvidenceSchema>;
