/**
 * The English labels the server writes into an incident's timeline and its
 * calendar titles (`src/lib/incidents/labels.ts`, #4463) are the UI's own
 * English labels, so the timeline and the page never name one thing two
 * ways — and none of them is the raw enum code.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    INCIDENT_NOTIFICATION_KIND_LABEL,
    INCIDENT_PHASE_LABEL,
    INCIDENT_SEVERITY_LABEL,
    INCIDENT_TYPE_LABEL,
    forensicCategoryLabel,
    incidentTypeLabel,
} from '@/lib/incidents/labels';
import { INCIDENT_TYPES } from '@/app-layer/schemas/incident.schemas';

type Labels = Record<string, string>;
const ui = (
    JSON.parse(fs.readFileSync(path.join(__dirname, '../../messages/en.json'), 'utf8')) as {
        incidents: {
            filterEnums: { severity: Labels; type: Labels; phase: Labels };
            detail: { kinds: Labels };
        };
    }
).incidents;

describe('incident labels match the UI catalogue', () => {
    it('severity', () => {
        expect(INCIDENT_SEVERITY_LABEL).toEqual({
            LOW: ui.filterEnums.severity.low,
            MEDIUM: ui.filterEnums.severity.medium,
            HIGH: ui.filterEnums.severity.high,
            CRITICAL: ui.filterEnums.severity.critical,
        });
    });

    it('type — one label for every type the schema accepts', () => {
        expect(INCIDENT_TYPE_LABEL).toEqual({
            RANSOMWARE: ui.filterEnums.type.ransomware,
            DATA_BREACH: ui.filterEnums.type.dataBreach,
            DDOS: ui.filterEnums.type.ddos,
            UNAUTHORIZED_ACCESS: ui.filterEnums.type.unauthorizedAccess,
            OTHER: ui.filterEnums.type.other,
        });
        expect(Object.keys(INCIDENT_TYPE_LABEL).sort()).toEqual([...INCIDENT_TYPES].sort());
    });

    it('phase', () => {
        expect(INCIDENT_PHASE_LABEL).toEqual({
            DETECTION: ui.filterEnums.phase.detection,
            CLASSIFICATION: ui.filterEnums.phase.classification,
            EARLY_WARNING: ui.filterEnums.phase.earlyWarning,
            CONTAINMENT: ui.filterEnums.phase.containment,
            INVESTIGATION: ui.filterEnums.phase.investigation,
            DETAILED_REPORT: ui.filterEnums.phase.detailedReport,
            RECOVERY: ui.filterEnums.phase.recovery,
            CLOSED: ui.filterEnums.phase.closed,
        });
    });

    it('notification kind', () => {
        expect(INCIDENT_NOTIFICATION_KIND_LABEL).toEqual(ui.detail.kinds);
    });

    it('falls back to the stored value only for a type or category it does not know', () => {
        expect(incidentTypeLabel('DATA_BREACH')).toBe('Data breach');
        expect(incidentTypeLabel('LEGACY_KIND')).toBe('LEGACY_KIND');
        expect(forensicCategoryLabel('SYSTEM_LOGS')).toBe('System & application logs');
        expect(forensicCategoryLabel('NOT_A_CATEGORY')).toBeNull();
    });
});
