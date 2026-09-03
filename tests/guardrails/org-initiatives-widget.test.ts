/**
 * ORG_INITIATIVES widget coverage ratchet.
 *
 * Locks the portfolio security-initiative feature (concept ported from
 * Cybether, MIT): the models/enum/widget-type exist, the typed-shape
 * accepts it, create/status-change audit, cross-tenant link resolution
 * goes through the SANCTIONED withTenantDb path (never bypassing tenant
 * isolation), the list/detail use the org-table pattern + Epic 67
 * undo-toast for unlink, the widget renders ProgressBar rows + the at-risk
 * flag, and manual-wins-else-rollup progress derivation is correct.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertWidgetTypedShape } from '@/app-layer/schemas/org-dashboard-widget.schemas';
import { DEFAULT_ORG_DASHBOARD_PRESET } from '@/app-layer/usecases/org-dashboard-presets';
import { deriveProgress } from '@/app-layer/usecases/org-security-initiative';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('ORG_INITIATIVES — schema + models', () => {
    const enums = read('prisma/schema/enums.prisma');
    const auth = read('prisma/schema/auth.prisma');

    it('defines OrgSecurityInitiative + OrgInitiativeLink + InitiativeStatus + the widget type', () => {
        expect(auth).toMatch(/model OrgSecurityInitiative \{/);
        expect(auth).toMatch(/model OrgInitiativeLink \{/);
        expect(enums).toMatch(/enum InitiativeStatus \{[\s\S]*PLANNED[\s\S]*CANCELLED[\s\S]*\}/);
        expect(enums).toMatch(/ORG_INITIATIVES\b/);
        expect(enums).toMatch(/ORG_INITIATIVE_CREATED\b/);
        expect(enums).toMatch(/ORG_INITIATIVE_STATUS_CHANGED\b/);
    });

    it('the link model is cross-tenant (stores linkedTenantId ref + entity ref)', () => {
        const model = auth.match(/model OrgInitiativeLink \{[\s\S]*?\n\}/)?.[0] ?? '';
        // Named linkedTenantId (NOT tenantId) so it isn't auto-detected as
        // RLS-isolated tenant data — it's a cross-tenant reference.
        expect(model).toMatch(/linkedTenantId/);
        expect(model).toMatch(/entityType/);
        expect(model).toMatch(/entityId/);
    });

    it('assertWidgetTypedShape accepts ORG_INITIATIVES and rejects a bad config', () => {
        expect(() => assertWidgetTypedShape({ type: 'ORG_INITIATIVES', chartType: 'list', config: { topN: 5 } })).not.toThrow();
        expect(() => assertWidgetTypedShape({ type: 'ORG_INITIATIVES', chartType: 'list', config: { bogus: 1 } })).toThrow();
    });
});

describe('ORG_INITIATIVES — usecase (audit + sanctioned cross-tenant read)', () => {
    const usecase = read('src/app-layer/usecases/org-security-initiative.ts');

    it('create + status-change emit the new OrgAuditAction values', () => {
        expect(usecase).toMatch(/'ORG_INITIATIVE_CREATED'/);
        expect(usecase).toMatch(/'ORG_INITIATIVE_STATUS_CHANGED'/);
        expect(usecase).toMatch(/appendOrgAuditEntry/);
    });

    it('cross-tenant link resolution goes through withTenantDb (not a raw cross-tenant prisma read)', () => {
        expect(usecase).toMatch(/withTenantDb\(/);
        // The completion read must happen INSIDE withTenantDb (RLS enforced),
        // never via the global prisma client crossing tenants.
        expect(usecase).not.toMatch(/prisma\.task\.findMany/);
        expect(usecase).not.toMatch(/prisma\.control\.findMany/);
    });

    it('write is permission-gated + sanitises free text', () => {
        expect(usecase).toMatch(/permissions\.canConfigureDashboard/);
        expect(usecase).toMatch(/sanitizePlainText/);
    });

    it('manual-wins-else-rollup progress derivation is correct', () => {
        // Manual overrides the rollup.
        expect(deriveProgress(80, 1, 4)).toEqual({ percent: 80, completed: 1, total: 4, manual: true });
        // No manual → completed/total.
        expect(deriveProgress(null, 3, 4)).toEqual({ percent: 75, completed: 3, total: 4, manual: false });
        // No links → 0, no divide-by-zero.
        expect(deriveProgress(null, 0, 0)).toEqual({ percent: 0, completed: 0, total: 0, manual: false });
        // Manual clamps to [0,100].
        expect(deriveProgress(150, 0, 0).percent).toBe(100);
    });
});

describe('ORG_INITIATIVES — renderer + surface + preset', () => {
    const widget = read('src/app/org/[orgSlug]/(app)/OrgInitiativesWidget.tsx');
    const dispatcher = read('src/app/org/[orgSlug]/(app)/widget-dispatcher.tsx');
    const detail = read('src/app/org/[orgSlug]/(app)/initiatives/[initiativeId]/InitiativeDetailClient.tsx');
    const list = read('src/app/org/[orgSlug]/(app)/initiatives/InitiativesClient.tsx');

    it('the dispatcher handles the ORG_INITIATIVES case', () => {
        expect(dispatcher).toMatch(/case 'ORG_INITIATIVES'/);
        expect(dispatcher).toContain('OrgInitiativesWidget');
    });

    it('the widget renders ProgressBar rows + the at-risk flag', () => {
        expect(widget).toMatch(/ProgressBar/);
        expect(widget).toMatch(/atRisk/);
        expect(widget).toMatch(/at risk/);
    });

    it('the list + detail use the org-table pattern; unlink uses the Epic 67 undo-toast', () => {
        // Name the VALUE import specifically. Both files also carry
        // `import type { ColumnDef } from '@/components/ui/table'`, so a bare
        // `from '@/components/ui/table'` needle is satisfied by the type
        // import alone — it would stay green with <DataTable> ripped out.
        expect(list).toMatch(/import \{[^}]*\bDataTable\b[^}]*\} from '@\/components\/ui\/table'/);
        expect(detail).toMatch(/import \{[^}]*\bDataTable\b[^}]*\} from '@\/components\/ui\/table'/);
        expect(detail).toMatch(/useToastWithUndo/);
    });

    it('the preset includes the ORG_INITIATIVES tracker (wide card)', () => {
        const i = DEFAULT_ORG_DASHBOARD_PRESET.find((w) => w.type === 'ORG_INITIATIVES');
        expect(i).toBeDefined();
        expect(i?.size.w).toBe(12);
    });
});
