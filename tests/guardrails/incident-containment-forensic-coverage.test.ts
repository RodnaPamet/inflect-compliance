/**
 * Structural ratchet for the incident containment runbooks + forensic
 * evidence linking (Prompt 3, P2 + P3).
 *
 * Locks the load-bearing invariants:
 *   - per-incidentType containment runbooks exist for the 4 real types,
 *     each with stable step keys, + a 6-role IR RACI + a forensic
 *     checklist (src/data/incident-containment.ts);
 *   - the IncidentEvidence junction exists + is RLS + index covered;
 *   - Incident carries completedContainmentSteps;
 *   - the usecase has toggleContainmentStep + link/unlinkEvidence, all
 *     audited;
 *   - the detail page renders the containment runbook + forensic
 *     checklist;
 *   - provenance (CC BY 4.0, Paolo Carner / BARE Consulting) is credited.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    INCIDENT_CONTAINMENT_RUNBOOKS,
    INCIDENT_RESPONSE_RACI,
    FORENSIC_EVIDENCE_CHECKLIST,
    containmentRunbookFor,
} from '@/data/incident-containment';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf } from '../helpers/source-blocks';

const REPO_ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
/** Comments MASKED at the read seam (#2246) — assertions bind to code, not prose. */
const read = (rel: string) => codeOf(readRaw(rel));
const exists = (rel: string) => fs.existsSync(path.join(REPO_ROOT, rel));

const REAL_TYPES = ['RANSOMWARE', 'DATA_BREACH', 'DDOS', 'UNAUTHORIZED_ACCESS'] as const;

describe('incident containment runbooks (P2)', () => {
    it('has a runbook for each of the 4 real incident types', () => {
        for (const t of REAL_TYPES) {
            const rb = INCIDENT_CONTAINMENT_RUNBOOKS[t];
            expect(rb).toBeTruthy();
            expect(rb.steps.length).toBeGreaterThanOrEqual(4);
        }
    });

    it('every step has a stable, type-prefixed key (survives label edits)', () => {
        for (const t of REAL_TYPES) {
            for (const step of INCIDENT_CONTAINMENT_RUNBOOKS[t].steps) {
                expect(step.key.startsWith(`${t}-`)).toBe(true);
                expect(step.label.length).toBeGreaterThan(0);
            }
        }
        // Keys are globally unique.
        const allKeys = REAL_TYPES.flatMap((t) =>
            INCIDENT_CONTAINMENT_RUNBOOKS[t].steps.map((s) => s.key),
        );
        expect(new Set(allKeys).size).toBe(allKeys.length);
    });

    it('containmentRunbookFor returns null for OTHER / unknown types', () => {
        expect(containmentRunbookFor('OTHER')).toBeNull();
        expect(containmentRunbookFor('NONSENSE')).toBeNull();
        expect(containmentRunbookFor('RANSOMWARE')).toBeTruthy();
    });

    it('declares the six incident-response roles (RACI)', () => {
        // LITERAL ON PURPOSE — do not derive. The IR RACI is a closed six-role
        // model (every other assertion here is a weak `some(...)`, so this is
        // the only thing that notices a role being added or dropped). Contrast
        // FORENSIC_EVIDENCE_CHECKLIST below, deliberately an open floor.
        expect(INCIDENT_RESPONSE_RACI).toHaveLength(6);
        // The DPO/legal role owns the regulatory determination.
        expect(
            INCIDENT_RESPONSE_RACI.some((r) => /dpo|legal/i.test(r.role)),
        ).toBe(true);
    });
});

describe('forensic evidence checklist (P3)', () => {
    it('lists the core forensic categories with stable keys', () => {
        expect(FORENSIC_EVIDENCE_CHECKLIST.length).toBeGreaterThanOrEqual(5);
        const keys = FORENSIC_EVIDENCE_CHECKLIST.map((c) => c.key);
        expect(keys).toEqual(expect.arrayContaining([
            'SYSTEM_LOGS', 'MEMORY_CAPTURE', 'NETWORK_CAPTURE', 'DISK_IMAGE', 'INDICATORS',
        ]));
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('IncidentEvidence junction (P3 schema)', () => {
    const compliance = () => readPrismaSchema();

    it('declares the IncidentEvidence model with composite parent FKs', () => {
        const src = compliance();
        expect(src).toMatch(/model IncidentEvidence \{/);
        // composite FKs to (id, tenantId) on both parents — tenant-safe.
        expect(src).toMatch(/incident\s+Incident\s+@relation\(fields: \[incidentId, tenantId\]/);
        expect(src).toMatch(/evidence\s+Evidence\s+@relation\(fields: \[evidenceId, tenantId\]/);
        expect(src).toMatch(/@@index\(\[tenantId, incidentId\]\)/);
    });

    it('Incident carries completedContainmentSteps', () => {
        expect(compliance()).toMatch(/completedContainmentSteps\s+String\[\]/);
    });

    it('the migration applies Class-A RLS to IncidentEvidence', () => {
        const migration =
            'prisma/migrations/20260629120000_incident_containment_forensics/migration.sql';
        expect(exists(migration)).toBe(true);
        const sql = read(migration);
        expect(sql).toMatch(/ALTER TABLE "IncidentEvidence" ENABLE ROW LEVEL SECURITY/);
        expect(sql).toMatch(/CREATE POLICY tenant_isolation ON "IncidentEvidence"/);
        expect(sql).toMatch(/CREATE POLICY superuser_bypass ON "IncidentEvidence"/);
    });
});

describe('incident usecase — containment + evidence (auditability)', () => {
    const usecase = () => read('src/app-layer/usecases/incident.ts');

    it('toggleContainmentStep, linkEvidence, unlinkEvidence each emit an audit event', () => {
        const src = usecase();
        for (const fn of ['toggleContainmentStep', 'linkEvidence', 'unlinkEvidence']) {
            const start = src.indexOf(`export async function ${fn}`);
            expect(start).toBeGreaterThan(-1);
            const rest = src.slice(start + 1);
            const nextExport = rest.indexOf('\nexport async function ');
            const body = nextExport > -1 ? rest.slice(0, nextExport) : rest;
            expect(body).toMatch(/logEvent\(/);
        }
    });

    it('forensic-evidence links validate the evidence belongs to the tenant', () => {
        expect(usecase()).toMatch(/evidenceExists\(/);
    });
});

describe('incident detail UI — containment + forensic', () => {
    const detail = 'src/app/t/[tenantSlug]/(app)/incidents/[incidentId]/page.tsx';

    it('renders the containment runbook + forensic checklist + IR roles', () => {
        const src = read(detail);
        expect(src).toMatch(/containmentRunbookFor/);
        expect(src).toMatch(/FORENSIC_EVIDENCE_CHECKLIST/);
        expect(src).toMatch(/INCIDENT_RESPONSE_RACI/);
        expect(src).toMatch(/containment-step/);
    });
});

describe('provenance — CC BY 4.0 attribution', () => {
    it('credits Paolo Carner / BARE Consulting (CC BY 4.0) in the reference data', () => {
        // RAW read ON PURPOSE — the one assertion in this file that is
        // deliberately ABOUT a comment. CC BY 4.0 requires the attribution to
        // live in the file header, so masking comments (which every other
        // read here does, per #2246) would delete the very thing being
        // asserted and turn a correct licence check red.
        const src = readRaw('src/data/incident-containment.ts');
        expect(src).toMatch(/CC BY 4\.0/);
        expect(src.toLowerCase()).toMatch(/paolo carner|bare consulting/);
    });
});
