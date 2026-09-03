/**
 * Structural ratchet for the NIS2 Article 23 incident-response feature.
 *
 * Locks the load-bearing invariants so a future refactor can't silently
 * drop them:
 *   - The three models + four enums exist in the schema.
 *   - All three tenant tables carry RLS (tenant_isolation +
 *     superuser_bypass + FORCE) and the free-text columns are in the
 *     Epic B encryption manifest.
 *   - markReportable derives EXACTLY three deadlines at +24h/+72h/+1mo.
 *   - The deadline-clock job exists, is registered, and runs ≥ hourly.
 *   - phase-advance / reportable / submit all write an audit event.
 *   - Reportability is a human SUGGESTION, never silently auto-asserted.
 *   - The detail page renders the 7-phase tracker + the three deadlines.
 *
 * Methodology adapted (CC BY 4.0) from Kshreenath/NIS2-Checklist —
 * Paolo Carner / BARE Consulting.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { computeDeadlines, PHASE_ORDER, suggestsReportable } from '@/lib/incidents/deadlines';

import { codeOf } from '../helpers/source-blocks';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
const exists = (rel: string) => fs.existsSync(path.join(REPO_ROOT, rel));

const SCHEMA_DIR = 'prisma/schema';
// Incident/BIA models moved to incidents.prisma (2026-07-10 schema split);
// read the whole-folder concatenation so they're found wherever they live.
const compliance = () => codeOf(readPrismaSchema());
const enums = () => read(`${SCHEMA_DIR}/enums.prisma`);
const usecase = () => read('src/app-layer/usecases/incident.ts');

const INCIDENT_MODELS = ['Incident', 'IncidentNotification', 'IncidentTimelineEntry'] as const;
const INCIDENT_ENUMS = [
    'IncidentSeverity',
    'IncidentPhase',
    'IncidentNotificationKind',
    'IncidentNotificationStatus',
] as const;

describe('NIS2 incident-response — schema', () => {
    it('declares the three models', () => {
        const src = compliance();
        for (const m of INCIDENT_MODELS) {
            expect(src).toMatch(new RegExp(`model ${m} \\{`));
        }
    });

    it('declares the four enums', () => {
        const src = enums();
        for (const e of INCIDENT_ENUMS) {
            expect(src).toMatch(new RegExp(`enum ${e} \\{`));
        }
    });

    it('every model is tenant-scoped + tenantId-indexed', () => {
        const src = compliance();
        for (const m of INCIDENT_MODELS) {
            const block = src.slice(src.indexOf(`model ${m} {`));
            const body = block.slice(0, block.indexOf('\n}'));
            expect(body).toMatch(/tenantId\s+String/);
            expect(body).toMatch(/@@index\(\[tenantId/);
        }
    });
});

describe('NIS2 incident-response — RLS migration', () => {
    const migration = 'prisma/migrations/20260628120000_nis2_incident_response/migration.sql';

    it('exists', () => {
        expect(exists(migration)).toBe(true);
    });

    it('applies the Class-A RLS policy set to all three tables', () => {
        const sql = read(migration);
        for (const m of INCIDENT_MODELS) {
            expect(sql).toMatch(new RegExp(`ALTER TABLE "${m}" ENABLE ROW LEVEL SECURITY`));
            expect(sql).toMatch(new RegExp(`ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY`));
            expect(sql).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON "${m}"`));
            expect(sql).toMatch(new RegExp(`CREATE POLICY superuser_bypass ON "${m}"`));
        }
    });
});

describe('NIS2 incident-response — field encryption', () => {
    it('encrypts every free-text column', () => {
        expect(ENCRYPTED_FIELDS.Incident).toContain('description');
        expect(ENCRYPTED_FIELDS.IncidentNotification).toContain('submissionNote');
        expect(ENCRYPTED_FIELDS.IncidentTimelineEntry).toContain('entry');
    });
});

describe('NIS2 incident-response — deadline arithmetic', () => {
    it('derives EXACTLY three deadlines at +24h / +72h / +1 month', () => {
        const detectedAt = new Date('2026-06-01T00:00:00.000Z');
        const deadlines = computeDeadlines(detectedAt);
        expect(deadlines).toHaveLength(3);
        const byKind = Object.fromEntries(deadlines.map((d) => [d.kind, d.dueAt.toISOString()]));
        expect(byKind.EARLY_WARNING_24H).toBe('2026-06-02T00:00:00.000Z');
        expect(byKind.DETAILED_72H).toBe('2026-06-04T00:00:00.000Z');
        expect(byKind.FINAL_1MONTH).toBe('2026-07-01T00:00:00.000Z');
    });

    it('models the seven-phase flow (+ CLOSED)', () => {
        expect(PHASE_ORDER).toEqual([
            'DETECTION',
            'CLASSIFICATION',
            'EARLY_WARNING',
            'CONTAINMENT',
            'INVESTIGATION',
            'DETAILED_REPORT',
            'RECOVERY',
            'CLOSED',
        ]);
    });
});

describe('NIS2 incident-response — deadline-clock job', () => {
    it('exists', () => {
        expect(exists('src/app-layer/jobs/incident-notification-deadlines.ts')).toBe(true);
    });

    it('is registered in the schedule registry at ≥ hourly cadence', () => {
        const schedules = read('src/app-layer/jobs/schedules.ts');
        const idx = schedules.indexOf("name: 'incident-notification-deadlines'");
        expect(idx).toBeGreaterThan(-1);
        // The cron pattern within ~150 chars of the name must be hourly or
        // finer — i.e. NOT a daily "0 H * * *" with a fixed hour.
        const window = schedules.slice(idx, idx + 200);
        // hourly "0 * * * *" or "*/N * * * *" — minute or hour wildcard.
        expect(window).toMatch(/pattern:\s*'0 \* \* \* \*'|pattern:\s*'\*\/\d+ \* \* \* \*'/);
    });

    it('is wired into the executor registry', () => {
        const registry = read('src/app-layer/jobs/executor-registry.ts');
        expect(registry).toMatch(/register\(\s*'incident-notification-deadlines'/);
    });
});

describe('NIS2 incident-response — auditability', () => {
    it('phase-advance, reportable, and submit each emit an audit event', () => {
        const src = usecase();
        // Each function block must contain a logEvent call.
        for (const fn of ['advancePhase', 'markReportable', 'submitNotification']) {
            const start = src.indexOf(`export async function ${fn}`);
            expect(start).toBeGreaterThan(-1);
            // body up to the next top-level export
            const rest = src.slice(start + 1);
            const nextExport = rest.indexOf('\nexport async function ');
            const body = nextExport > -1 ? rest.slice(0, nextExport) : rest;
            expect(body).toMatch(/logEvent\(/);
        }
    });
});

describe('NIS2 incident-response — reportability is a human suggestion', () => {
    it('createIncident never auto-asserts reportable=true', () => {
        const src = usecase();
        const start = src.indexOf('export async function createIncident');
        const rest = src.slice(start);
        const body = rest.slice(0, rest.indexOf('\nexport async function '));
        // The create path must NOT silently set reportable true.
        expect(body).not.toMatch(/reportable:\s*true/);
    });

    it('markReportable takes an explicit boolean decision', () => {
        const schema = read('src/app-layer/schemas/incident.schemas.ts');
        expect(schema).toMatch(/reportable:\s*z\.boolean\(\)/);
    });

    it('suggestsReportable is only a heuristic (HIGH/CRITICAL)', () => {
        expect(suggestsReportable('CRITICAL')).toBe(true);
        expect(suggestsReportable('HIGH')).toBe(true);
        expect(suggestsReportable('MEDIUM')).toBe(false);
        expect(suggestsReportable('LOW')).toBe(false);
    });
});

describe('NIS2 incident-response — detail UI', () => {
    const detail = 'src/app/t/[tenantSlug]/(app)/incidents/[incidentId]/page.tsx';

    it('exists', () => {
        expect(exists(detail)).toBe(true);
    });

    it('renders the seven-phase tracker', () => {
        const src = read(detail);
        // #2246 Class A — this was `toMatch(/7-phase/)`, and "7-phase" occurs
        // in the page only inside the JSX comment that labels the block. The
        // tracker itself is a map over PHASE_ORDER, so assert the iteration
        // (which is what "renders" means here) rather than the label on it.
        // That the iterated flow IS the seven-phase one is asserted against
        // the live import in `models the seven-phase flow (+ CLOSED)` above.
        expect(src).toMatch(/PHASE_ORDER\.map\(/);
        // All phase labels referenced (the stepper renders the flow).
        expect(src).toMatch(/PHASE_ORDER|DETECTION/);
    });

    it('surfaces the three Article 23 notification deadlines', () => {
        const src = read(detail);
        expect(src).toMatch(/EARLY_WARNING_24H/);
        expect(src).toMatch(/DETAILED_72H/);
        expect(src).toMatch(/FINAL_1MONTH/);
    });

    it('carries the not-legal-advice disclaimer', () => {
        const src = read(detail);
        // The disclaimer copy moved to the incidents catalog; the detail
        // page references the key and the en value carries the wording.
        expect(src).toMatch(/detail\.notLegal(Strong|Body)/);
        const en = JSON.parse(read('messages/en.json')) as {
            incidents: { detail: { notLegalStrong: string; notLegalBody: string } };
        };
        const copy = `${en.incidents.detail.notLegalStrong} ${en.incidents.detail.notLegalBody}`.toLowerCase();
        expect(copy).toMatch(/not legal advice|legal\/dpo|dpo/);
    });
});
