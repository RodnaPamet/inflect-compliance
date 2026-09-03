/**
 * ORG_MATURITY widget coverage ratchet.
 *
 * Locks the org security-maturity feature (concept ported from Cybether,
 * MIT): the model/enums/widget-type exist, the typed-shape accepts it, the
 * set action is permission-gated + audited, the renderer uses the Epic 59
 * radar primitive (not raw SVG) + KPIStat, the read derives from
 * OrgMaturityRating rows (NOT from coverage — the two axes stay distinct),
 * the preset includes it, and the >90-day staleness note renders.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

import { assertWidgetTypedShape } from '@/app-layer/schemas/org-dashboard-widget.schemas';
import { DEFAULT_ORG_DASHBOARD_PRESET } from '@/app-layer/usecases/org-dashboard-presets';

const ROOT = path.resolve(__dirname, '../..');
// codeOf() masks comments at the READ SEAM (#2246) — every path read here is
// .prisma / .ts / .tsx, and every assertion is about code, not prose.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

describe('ORG_MATURITY — schema + model', () => {
    const enums = read('prisma/schema/enums.prisma');
    const auth = read('prisma/schema/auth.prisma');

    it('defines OrgMaturityRating + MaturityDomain/MaturityLevel enums + the widget type', () => {
        expect(auth).toMatch(/model OrgMaturityRating \{/);
        expect(enums).toMatch(/enum MaturityDomain \{[\s\S]*GOVERN[\s\S]*RECOVER[\s\S]*\}/);
        expect(enums).toMatch(/enum MaturityLevel \{[\s\S]*INITIAL[\s\S]*OPTIMIZING[\s\S]*\}/);
        expect(enums).toMatch(/ORG_MATURITY\b/);
        expect(enums).toMatch(/ORG_MATURITY_RATING_SET\b/);
    });

    it('is org-scoped (organizationId, no tenantId / no RLS)', () => {
        const model = auth.match(/model OrgMaturityRating \{[\s\S]*?\n\}/)?.[0] ?? '';
        expect(model).toMatch(/organizationId/);
        expect(model).not.toMatch(/tenantId/);
    });

    it('assertWidgetTypedShape accepts ORG_MATURITY and rejects a bad config', () => {
        expect(() =>
            assertWidgetTypedShape({ type: 'ORG_MATURITY', chartType: 'radar', config: { view: 'radar', showCoverageHint: true } }),
        ).not.toThrow();
        expect(() =>
            assertWidgetTypedShape({ type: 'ORG_MATURITY', chartType: 'radar', config: { bogus: 1 } }),
        ).toThrow();
    });
});

describe('ORG_MATURITY — set action + the maturity≠coverage distinction', () => {
    const usecase = read('src/app-layer/usecases/org-maturity.ts');

    it('setOrgMaturityRating is gated on canSetMaturity', () => {
        expect(usecase).toMatch(/setOrgMaturityRating/);
        expect(usecase).toMatch(/permissions\.canSetMaturity/);
    });

    it('emits the ORG_MATURITY_RATING_SET audit entry', () => {
        expect(usecase).toMatch(/appendOrgAuditEntry/);
        expect(usecase).toMatch(/action:\s*'ORG_MATURITY_RATING_SET'/);
    });

    it('getCurrentOrgMaturity reads OrgMaturityRating rows, NOT a coverage re-derivation', () => {
        expect(usecase).toMatch(/orgMaturityRating\.findMany/);
        // Coverage may only appear as an ADVISORY hint, never as the rating.
        expect(usecase).toMatch(/coverageHint/);
        expect(usecase).toMatch(/coverageToMaturityBand/);
        expect(usecase).toMatch(/sanitizePlainText/);
    });

    it('canSetMaturity is an ORG_ADMIN-only permission flag', () => {
        const perms = read('src/lib/permissions.ts');
        expect(perms).toMatch(/canSetMaturity: boolean/);
        expect((perms.match(/canSetMaturity: true/g) ?? []).length).toBe(1);
    });
});

describe('ORG_MATURITY — renderer + preset', () => {
    const widget = read('src/app/org/[orgSlug]/(app)/OrgMaturityWidget.tsx');
    const dispatcher = read('src/app/org/[orgSlug]/(app)/widget-dispatcher.tsx');

    it('the dispatcher handles the ORG_MATURITY case', () => {
        expect(dispatcher).toMatch(/case 'ORG_MATURITY'/);
        expect(dispatcher).toContain('OrgMaturityWidget');
    });

    it('renders via the Epic 59 radar-chart primitive + KPIStat (not raw SVG)', () => {
        expect(widget).toMatch(/RadarChart/);
        expect(widget).toMatch(/from '@\/components\/ui\/charts'/);
        expect(widget).toMatch(/KPIStat/);
        expect(widget).not.toMatch(/<svg\b/);
    });

    it('renders a staleness note for ratings older than 90 days', () => {
        expect(widget).toMatch(/STALE_DAYS\s*=\s*90/);
        // #2246 Class A — this was `toMatch(/may be stale/)`, and that phrase
        // lives only in the file-header comment: the note is localized, so the
        // English words are in messages/, never in the widget. Anchor on the
        // conditional and the i18n key that together ARE the note.
        expect(widget).toMatch(/isStale\s*&&/);
        expect(widget).toMatch(/widgets\.maturityStale/);
        expect(widget).toContain('org-maturity-stale');
    });

    it('the preset includes the ORG_MATURITY radar (half-width)', () => {
        const m = DEFAULT_ORG_DASHBOARD_PRESET.find((w) => w.type === 'ORG_MATURITY');
        expect(m).toBeDefined();
        expect(m?.chartType).toBe('radar');
        expect(m?.size.w).toBe(6);
    });
});
