/**
 * Structural ratchet for the Business Impact Analysis (continuity) module.
 *
 * PR-1 (backend) locks:
 *   - BusinessImpactAnalysis + BiaDependency models exist, tenant-scoped,
 *     with RLS, encrypted `notes`, and index coverage.
 *   - A BIA attaches to a ProcessNode (reuse of the modeled-process
 *     concept, NOT a parallel one) and exposes a process cross-link read.
 *   - Control wiring is CONDITIONAL: the resolver returns exactly one of
 *     continuity / process / none — never an unconditional BIA surface
 *     (the no-dead-tab lock, verified end-to-end by the integration test).
 *   - Recovery-priority derivation is transparent (a documented ordering,
 *     no black-box continuity score).
 *   - A BIA links to the NIS2 Art.21(2)(c) control as evidence.
 *
 * (PR-2 extends this file with the UI-placement assertions: the Business
 *  Continuity tab beside Incidents, the canvas cross-link, and the
 *  section-vs-chip conditional rendering.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const COMPLIANCE_SCHEMA = readPrismaSchema();
const ENUMS = read('prisma/schema/enums.prisma');
const PROCESSES_SCHEMA = read('prisma/schema/processes.prisma');
const MIGRATION = read('prisma/migrations/20260701130000_bia_module/migration.sql');
const ENCRYPTED_FIELDS = read('src/lib/security/encrypted-fields.ts');
const USECASE = read('src/app-layer/usecases/business-impact-analysis.ts');
const PRIORITY = read('src/app-layer/services/bia-recovery-priority.ts');

describe('BIA — schema + RLS + encryption + process attach', () => {
    it('defines BusinessImpactAnalysis + BiaDependency models', () => {
        expect(COMPLIANCE_SCHEMA).toMatch(/model\s+BusinessImpactAnalysis\s*\{/);
        expect(COMPLIANCE_SCHEMA).toMatch(/model\s+BiaDependency\s*\{/);
    });

    it('the BIA attaches to a ProcessNode (reuse, not a parallel process concept)', () => {
        const bia = COMPLIANCE_SCHEMA.match(/model\s+BusinessImpactAnalysis\s*\{[\s\S]*?\n\}/)![0];
        expect(bia).toMatch(/processNodeId\s+String\?/);
        expect(bia).toMatch(/processNode\s+ProcessNode\?/);
        // ProcessNode carries the back-relation (the canvas cross-link).
        expect(PROCESSES_SCHEMA).toMatch(/businessImpactAnalyses\s+BusinessImpactAnalysis\[\]/);
    });

    it('is tenant-scoped with tenantId-leading indexes', () => {
        const bia = COMPLIANCE_SCHEMA.match(/model\s+BusinessImpactAnalysis\s*\{[\s\S]*?\n\}/)![0];
        expect(bia).toMatch(/tenantId\s+String/);
        expect(bia).toMatch(/@@index\(\[tenantId, criticality\]\)/);
        expect(bia).toMatch(/@@index\(\[tenantId, processNodeId\]\)/);
    });

    it('encrypts the free-text notes (Epic B manifest)', () => {
        expect(ENCRYPTED_FIELDS).toMatch(/BusinessImpactAnalysis:\s*\[\s*'notes'\s*\]/);
    });

    it('applies the canonical RLS triple to both tables', () => {
        for (const table of ['BusinessImpactAnalysis', 'BiaDependency']) {
            expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE "${table}"\\s+ENABLE ROW LEVEL SECURITY`));
            expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE "${table}"\\s+FORCE ROW LEVEL SECURITY`));
            expect(MIGRATION).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON "${table}"`));
            expect(MIGRATION).toMatch(new RegExp(`CREATE POLICY superuser_bypass ON "${table}"`));
        }
    });
});

describe('BIA — conditional control wiring (the no-dead-tab lock)', () => {
    it('the resolver returns exactly continuity / process / none', () => {
        expect(USECASE).toMatch(/kind:\s*'continuity'/);
        expect(USECASE).toMatch(/kind:\s*'process'/);
        expect(USECASE).toMatch(/kind:\s*'none'/);
        expect(USECASE).toMatch(/export async function getControlBiaSurface/);
    });

    it('continuity is gated on an Art.21(2)(c)/continuity requirement link (not unconditional)', () => {
        expect(USECASE).toMatch(/CONTINUITY_REQUIREMENT_CODES/);
        expect(USECASE).toMatch(/'Art\.21\(2\)\(c\)'/);
        expect(USECASE).toMatch(/controlRequirementLink\.findMany/);
    });

    it('the process case is DERIVED via edge→node→BIA (no new control→BIA FK)', () => {
        expect(USECASE).toMatch(/processEdgeControl\.findMany/);
        expect(USECASE).toMatch(/processNode\.findMany/);
        // No FK from Control (or ControlEvidenceLink) directly to a process chip.
        const bia = COMPLIANCE_SCHEMA.match(/model\s+BusinessImpactAnalysis\s*\{[\s\S]*?\n\}/)![0];
        expect(bia).not.toMatch(/controlId\s+String/);
    });
});

describe('BIA — transparent recovery priority + evidence link', () => {
    it('recovery priority is a documented ordering, NOT a black-box score', () => {
        expect(PRIORITY).toMatch(/export function deriveRecoveryPriority/);
        expect(PRIORITY).toMatch(/CRITICALITY_RANK/);
        expect(PRIORITY + USECASE).not.toMatch(/continuityScore|compositeScore|blackBox|opaqueScore/i);
    });

    it('a BIA links to the continuity control as evidence (kind BIA)', () => {
        expect(ENUMS).toMatch(/enum EvidenceLinkKind\s*\{[\s\S]*?BIA[\s\S]*?\}/);
        expect(USECASE).toMatch(/export async function linkBiaToControl/);
        expect(USECASE).toMatch(/kind:\s*'BIA'/);
        // ControlEvidenceLink carries the biaId reference.
        expect(COMPLIANCE_SCHEMA).toMatch(/biaId\s+String\?/);
    });

    it('surfaces incident recovery-deadline context (the co-location payoff)', () => {
        expect(USECASE).toMatch(/export async function getIncidentBiaContext/);
    });
});

describe('BIA — UI placement (beside Incidents in the Internal Audit page)', () => {
    const AUDITS = read('src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx');
    const SIDEBAR = read('src/components/layout/SidebarNav.tsx');
    const PAGE_SEG = read('src/lib/nav/page-segregation.ts');

    it('the Business Continuity pill sits in the Internal Audit header beside Incidents', () => {
        expect(AUDITS).toMatch(/audits-business-continuity-link/);
        expect(AUDITS).toMatch(/\/audits\/business-continuity/);
        // beside Incidents — both are secondary pills in the same header.
        expect(AUDITS).toMatch(/audits-incidents-link/);
    });

    it('is NOT a standalone nav item and NOT a canvas tab (routed under /audits)', () => {
        expect(SIDEBAR).not.toMatch(/business-continuity|\/bia\b/);
        // registered as a SUBPAGE of the audit area, not a MAIN nav destination.
        expect(PAGE_SEG).toMatch(/'\/audits\/business-continuity'/);
        expect(PAGE_SEG).toMatch(/'\/audits\/business-continuity\/\[id\]'/);
    });

    it('ships the register + detail surfaces on the platform primitives', () => {
        const client = read('src/app/t/[tenantSlug]/(app)/audits/business-continuity/BusinessContinuityClient.tsx');
        const detail = read('src/app/t/[tenantSlug]/(app)/audits/business-continuity/[id]/BiaDetailClient.tsx');
        expect(client).toMatch(/EntityListPage/);
        expect(detail).toMatch(/EntityDetailLayout/);
        // recovery-priority rank surfaced in the register.
        expect(client).toMatch(/recovery/);
    });
});

describe('BIA — deep wiring into control + incident pages (the no-dead-tab UI)', () => {
    const CONTROL_SURFACE = read('src/components/bia/ControlBiaSurface.tsx');
    const CONTROL_DETAIL = read('src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx');
    const INCIDENT_CTX = read('src/components/bia/IncidentBiaContext.tsx');
    const INCIDENT_DETAIL = read('src/app/t/[tenantSlug]/(app)/incidents/[incidentId]/page.tsx');

    it('the control BIA surface renders continuity / process / nothing — and returns null for none', () => {
        // The component itself enforces the no-dead-tab contract.
        expect(CONTROL_SURFACE).toMatch(/kind === 'none'\)\s*return null/);
        expect(CONTROL_SURFACE).toMatch(/kind === 'process'/);
        expect(CONTROL_SURFACE).toMatch(/control-bia-continuity/);
        expect(CONTROL_SURFACE).toMatch(/bia-surface/); // fetches the server-resolved surface
    });

    it('the control detail page mounts the conditional surface', () => {
        expect(CONTROL_DETAIL).toMatch(/ControlBiaSurface/);
    });

    it('the incident detail page surfaces the BIA recovery-deadline context', () => {
        expect(INCIDENT_CTX).toMatch(/bia-context/);
        expect(INCIDENT_CTX).toMatch(/rows\.length === 0\)\s*return null/); // no dead surface
        expect(INCIDENT_DETAIL).toMatch(/IncidentBiaContext/);
    });
});

describe('BIA — process-canvas cross-link (link out, not live in the canvas)', () => {
    const AFFORDANCE = read('src/components/bia/NodeBiaAffordance.tsx');
    const INSPECTOR = read('src/components/processes/ProcessInspector.tsx');
    const BIA_USECASE = read('src/app-layer/usecases/business-impact-analysis.ts');

    it('the node affordance resolves nodeKey→id via (processMapId, nodeKey) and links out to the audit area', () => {
        expect(AFFORDANCE).toMatch(/processMapId=/);
        expect(AFFORDANCE).toMatch(/nodeKey=/);
        // links OUT to the BIA under /audits/business-continuity (NOT a canvas tab).
        expect(AFFORDANCE).toMatch(/\/audits\/business-continuity/);
        // the resolver usecase exists.
        expect(BIA_USECASE).toMatch(/export async function getBiasForProcessNodeKey/);
    });

    it('the process inspector mounts the node BIA affordance', () => {
        expect(INSPECTOR).toMatch(/NodeBiaAffordance/);
    });
});
