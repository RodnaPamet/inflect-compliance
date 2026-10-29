/**
 * English display labels for the incident enums, for the text the SERVER
 * writes where a person reads it: the incident's timeline entries and the
 * compliance-calendar titles of its notification deadlines. Both are stored
 * or served as plain English (as every other system-written timeline entry
 * and calendar title is), so they cannot go through `next-intl`; what they
 * must not do is show a raw code such as `DATA_BREACH` or
 * `EARLY_WARNING_24H`.
 *
 * Each value is the English UI label from `messages/en.json`
 * (`incidents.filterEnums.*`, `incidents.detail.kinds.*`), and
 * tests/unit/incident-labels.test.ts holds them equal, so the timeline and
 * the page never name one thing two ways. Pure — no server imports.
 */
import type {
    IncidentNotificationKind,
    IncidentPhase,
    IncidentSeverity,
} from '@prisma/client';
import { FORENSIC_EVIDENCE_CHECKLIST } from '@/data/incident-containment';

export const INCIDENT_SEVERITY_LABEL: Record<IncidentSeverity, string> = {
    LOW: 'Low',
    MEDIUM: 'Medium',
    HIGH: 'High',
    CRITICAL: 'Critical',
};

/** `Incident.incidentType` is a String column; the schema bounds it to these. */
export const INCIDENT_TYPE_LABEL: Record<string, string> = {
    RANSOMWARE: 'Ransomware',
    DATA_BREACH: 'Data breach',
    DDOS: 'DDoS',
    UNAUTHORIZED_ACCESS: 'Unauthorized access',
    OTHER: 'Other',
};

export const INCIDENT_PHASE_LABEL: Record<IncidentPhase, string> = {
    DETECTION: 'Detection',
    CLASSIFICATION: 'Classification',
    EARLY_WARNING: 'Early warning',
    CONTAINMENT: 'Containment',
    INVESTIGATION: 'Investigation',
    DETAILED_REPORT: 'Detailed report',
    RECOVERY: 'Recovery',
    CLOSED: 'Closed',
};

export const INCIDENT_NOTIFICATION_KIND_LABEL: Record<IncidentNotificationKind, string> = {
    EARLY_WARNING_24H: '24-hour early warning',
    DETAILED_72H: '72-hour detailed report',
    FINAL_1MONTH: '1-month final report',
};

/** The type's label; an unrecognised value is returned as it was stored. */
export function incidentTypeLabel(type: string): string {
    return INCIDENT_TYPE_LABEL[type] ?? type;
}

/** The forensic checklist category's label, or `null` for an unknown key. */
export function forensicCategoryLabel(key: string): string | null {
    return FORENSIC_EVIDENCE_CHECKLIST.find((c) => c.key === key)?.label ?? null;
}
