/**
 * ORG_THREAT_LEVEL widget coverage ratchet.
 *
 * Locks the org-wide threat-level feature (concept ported from Cybether,
 * MIT) end to end: the model/enums/widget-type exist, the typed-shape
 * contract accepts it, the set action is permission-gated + audited, the
 * renderer handles the type with escalating StatusBadge tones + a
 * staleness note, and the default preset includes it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertWidgetTypedShape } from '@/app-layer/schemas/org-dashboard-widget.schemas';
import { DEFAULT_ORG_DASHBOARD_PRESET } from '@/app-layer/usecases/org-dashboard-presets';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
/** Comments MASKED at the read seam (#2246) — assertions bind to code, not prose. */
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

describe('ORG_THREAT_LEVEL — schema + model', () => {
    const enums = read('prisma/schema/enums.prisma');
    const auth = read('prisma/schema/auth.prisma');

    it('defines the OrgThreatLevel model + OrgThreatTier enum + widget type', () => {
        expect(auth).toMatch(/model OrgThreatLevel \{/);
        expect(enums).toMatch(/enum OrgThreatTier \{[\s\S]*GUARDED[\s\S]*SEVERE[\s\S]*\}/);
        expect(enums).toMatch(/ORG_THREAT_LEVEL\b/); // widget type
        expect(enums).toMatch(/ORG_THREAT_LEVEL_SET\b/); // audit action
    });

    it('is org-scoped, NOT tenant-scoped (no tenantId, no RLS)', () => {
        const model = auth.match(/model OrgThreatLevel \{[\s\S]*?\n\}/)?.[0] ?? '';
        expect(model).toMatch(/organizationId/);
        expect(model).not.toMatch(/tenantId/);
    });

    it('assertWidgetTypedShape accepts ORG_THREAT_LEVEL and rejects a bad config', () => {
        expect(() =>
            assertWidgetTypedShape({
                type: 'ORG_THREAT_LEVEL',
                chartType: 'banner',
                config: { showHistory: true },
            }),
        ).not.toThrow();
        expect(() =>
            assertWidgetTypedShape({
                type: 'ORG_THREAT_LEVEL',
                chartType: 'banner',
                config: { bogus: 1 },
            }),
        ).toThrow();
    });
});

describe('ORG_THREAT_LEVEL — set action (permission + audit)', () => {
    const usecase = read('src/app-layer/usecases/org-threat-level.ts');

    it('setOrgThreatLevel is gated on canSetThreatLevel', () => {
        expect(usecase).toMatch(/setOrgThreatLevel/);
        expect(usecase).toMatch(/permissions\.canSetThreatLevel/);
    });

    it('emits the ORG_THREAT_LEVEL_SET audit entry', () => {
        expect(usecase).toMatch(/appendOrgAuditEntry/);
        expect(usecase).toMatch(/action:\s*'ORG_THREAT_LEVEL_SET'/);
    });

    it('sanitises the curated free text', () => {
        expect(usecase).toMatch(/sanitizePlainText/);
    });

    it('canSetThreatLevel is an ORG_ADMIN-only permission flag', () => {
        const perms = read('src/lib/permissions.ts');
        expect(perms).toMatch(/canSetThreatLevel: boolean/);
        // ORG_ADMIN arm grants it; the others deny it.
        expect((perms.match(/canSetThreatLevel: true/g) ?? []).length).toBe(1);
    });
});

describe('ORG_THREAT_LEVEL — renderer + preset', () => {
    const widget = read('src/app/org/[orgSlug]/(app)/OrgThreatLevelWidget.tsx');
    const dispatcher = read('src/app/org/[orgSlug]/(app)/widget-dispatcher.tsx');

    it('the dispatcher handles the ORG_THREAT_LEVEL case', () => {
        expect(dispatcher).toMatch(/case 'ORG_THREAT_LEVEL'/);
        expect(dispatcher).toContain('OrgThreatLevelWidget');
    });

    it('uses StatusBadge with escalating tones (the deliberate alert exception)', () => {
        expect(widget).toMatch(/from '@\/components\/ui\/status-badge'/);
        expect(widget).toMatch(/SEVERE:\s*'error'/);
        expect(widget).toMatch(/ELEVATED:\s*'warning'/);
    });

    it('renders a staleness note for postures older than 30 days', () => {
        expect(widget).toMatch(/STALE_DAYS\s*=\s*30/);
        // #2246 Class A — this was `toMatch(/may be stale/)`, and that phrase
        // lives only in the file-header comment: the note is localized, so the
        // English words are in messages/, never in the widget. Anchor on the
        // conditional and the i18n key that together ARE the note.
        expect(widget).toMatch(/isStale\s*&&/);
        expect(widget).toMatch(/widgets\.threatStale/);
        expect(widget).toContain('org-threat-level-stale');
    });

    it('uses platform Modal + RadioGroup for the update action', () => {
        expect(widget).toMatch(/from '@\/components\/ui\/modal'/);
        expect(widget).toMatch(/from '@\/components\/ui\/radio-group'/);
    });

    it('the default preset includes the ORG_THREAT_LEVEL widget at the top, full width', () => {
        const threat = DEFAULT_ORG_DASHBOARD_PRESET.find((w) => w.type === 'ORG_THREAT_LEVEL');
        expect(threat).toBeDefined();
        expect(threat?.position).toEqual({ x: 0, y: 0 });
        expect(threat?.size.w).toBe(12);
    });
});
