/**
 * Bulgarian pages carry no English the PRODUCT wrote.
 *
 * `bg-messages-translated.test.ts` reads `messages/bg.json`. The 2026-11-22
 * mobile audit found English on 116 Bulgarian pages that a translated catalog
 * cannot fix, because the English never went through the catalog:
 *
 *   I2  dates formatted in a pinned `en-GB`, relative times with no locale;
 *   I3  literals in shared helpers (the ROI hint, "Expand all", the risk
 *       matrix's default names, celebration toasts);
 *   I4  English assembled on the server (the BIA rationale, the activity
 *       feed's raw codes, the audit log's action chips, agentic bell titles);
 *   I5  org dashboard widget titles stored in English;
 *   I6  raw enum values rendered as text, and catalog values that are still
 *       English ("{period}d", "you@company.com").
 *
 * Each class is checked here by what a Bulgarian reader would get, wherever
 * that can be computed without a browser: the helpers are CALLED in Bulgarian
 * and their output must hold no Latin letters. Where only the source can say
 * it (a server component that formats a date with the ambient helpers, a raw
 * enum as a JSX child), the scan covers the whole of `src/` and carries no
 * allowlist. The back-link labels of class I1 live in
 * `src/lib/nav/canonical-parents.ts`, which another change owns.
 *
 * "No Latin letters" is the test for product copy because Bulgarian product
 * copy has none, except the acronyms and product names this file strips
 * first (MFA, MTPD, RTO, SLE, ARO, FAIR, ROI).
 */
import * as fs from 'node:fs';

import {
    dateFormattersFor,
    type DateFormatters,
} from '@inflect/ui/lib/format-date';
import { describeRoiGap } from '@/lib/control-roi';
import { localizeRiskMatrixConfig } from '@/lib/risk-matrix/localize';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';
import {
    WIDGET_TITLES,
    WIDGET_TITLE_MESSAGE_KEYS,
    localizedWidgetTitle,
} from '@/lib/org-dashboard-widget-titles';
import {
    AGENTIC_NOTIFICATION_TITLES,
    localizedNotificationTitle,
} from '@/lib/notifications/agentic-titles';
import { ACTIVITY_EVENT_ACTIONS, KNOWN_ACTIVITY_VERBS } from '@/lib/audit/activity-humanize';
import { MILESTONES } from '@/lib/celebrations';
import { catalogTranslator, catalogValue } from '../helpers/catalog-translator';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const ACRONYMS = /\b(?:MFA|MTPD|RTO|SLE|ARO|FAIR|ROI)\b/g;
const latinIn = (text: string): string[] => text.replace(ACRONYMS, '').match(/[A-Za-z]+/g) ?? [];

const bg = catalogTranslator('bg');
const scoped = (ns: string) => (key: string, values?: Record<string, string | number>) => bg(`${ns}.${key}`, values);

// ─── I2 — dates ─────────────────────────────────────────────────────

describe('I2: a Bulgarian date is written in Bulgarian', () => {
    const f: DateFormatters = dateFormattersFor('bg');
    // Every month and every weekday, at an hour that is the previous day in
    // any zone west of UTC — so a local-time read would show up as a wrong day.
    const instants = Array.from({ length: 12 }, (_, m) => new Date(Date.UTC(2026, m, 3 + (m % 7), 0, 30, 5)));
    const now = new Date(Date.UTC(2026, 10, 29, 12));

    const single: (keyof DateFormatters)[] = [
        'formatDate', 'formatDateTime', 'formatDateTimeLong', 'formatDateShort', 'formatDateLong',
        'formatDateCompact', 'formatMonthYear', 'formatMonthShort', 'formatWeekdayShort',
    ];

    it.each(single)('%s has no Latin letters', (name) => {
        const fn = f[name] as (v: Date) => string;
        const latin = instants.flatMap((d) => latinIn(fn(d)));
        expect(latin).toStrictEqual([]);
    });

    it('formatDateRange, open-ended or not, has no Latin letters', () => {
        const [a, b] = [instants[0], instants[7]];
        const outs = [f.formatDateRange(a, b), f.formatDateRange(a, null), f.formatDateRange(null, b)];
        expect(outs.flatMap(latinIn)).toStrictEqual([]);
    });

    it('formatRelativeTime, past and future, has no Latin letters', () => {
        const outs = [
            f.formatRelativeTime(new Date(now.getTime() - 20 * 60_000), now),
            f.formatRelativeTime(new Date(now.getTime() + 3 * 86_400_000), now),
        ];
        expect(outs.flatMap(latinIn)).toStrictEqual([]);
        expect(outs[0]).toBe('преди 20 минути');
    });

    it('English keeps the en-GB dialect it always had', () => {
        const en = dateFormattersFor('en');
        expect(en.formatDate('2026-04-16T08:00:00Z')).toBe('16 Apr 2026');
        expect(en.formatRelativeTime(new Date(now.getTime() - 20 * 60_000), now)).toBe('20 minutes ago');
    });

    it('a server component never formats with the ambient helpers', () => {
        // A server component renders outside the tree where <Providers> binds
        // the reader's locale, so the bare helpers would write English there.
        // It takes `getDateFormatters()` instead. Route handlers and non-UI
        // modules are out of scope: they are not read on a page.
        const ambient = /import\s*\{[^}]*\b(formatDate\w*|formatMonth\w*|formatWeekday\w*|formatRelativeTime)\b[^}]*\}\s*from\s*'@inflect\/ui\/lib\/format-date'/;
        const offenders = repoFiles({ under: 'src/app', extensions: ['.tsx'] })
            .filter((file) => {
                const src = fs.readFileSync(file, 'utf8');
                return !/^\s*['"]use client['"]/.test(src) && ambient.test(src);
            })
            .map(repoRelative);
        expect(offenders).toStrictEqual([]);
    });

    it('no date-fns distance or date-picker locale is chosen outside format-date', () => {
        // Relative time goes through `formatRelativeTime`; the picker takes
        // the active locale when its caller names none. A hard-coded `enUS`
        // or a bare `formatDistance` is English on a Bulgarian page.
        const offenders = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })
            .filter((file) => {
                const src = codeOf(fs.readFileSync(file, 'utf8'));
                return /\bformatDistance(?:ToNow|Strict)?\s*\(/.test(src) || /\benUS\b/.test(src);
            })
            .map(repoRelative);
        expect(offenders).toStrictEqual([]);
    });
});

// ─── I3 — shared helpers ────────────────────────────────────────────

describe('I3: shared helpers speak through the catalog', () => {
    it('every ROI gap nudge is a catalog key with Bulgarian copy', () => {
        const verdicts = [
            { reason: 'NO_COST', linkedRiskCount: 0 },
            { reason: 'NO_EFFECTIVENESS', linkedRiskCount: 1 },
            { reason: 'NO_QUANT_RISKS', linkedRiskCount: 0 },
            { reason: 'NO_QUANT_RISKS', linkedRiskCount: 2 },
        ] as const;
        const texts = verdicts.map((v) => bg(`controls.roi.gap.${describeRoiGap({ ok: false, ...v })}`));
        expect(texts.flatMap(latinIn)).toStrictEqual([]);
    });

    it('the tree toggle and the celebrations hold no copy of their own', () => {
        // Both read the catalog; an English default or toast written back into
        // the source is what this catches.
        const toggle = codeOf(fs.readFileSync(`${__dirname}/../../src/components/ui/TreeExpandCollapseToggle.tsx`, 'utf8'));
        expect(toggle).not.toMatch(/'(?:Expand|Collapse) all'/);
        expect(latinIn(bg('common.ui.expandAll'))).toStrictEqual([]);
        expect(latinIn(bg('common.ui.collapseAll'))).toStrictEqual([]);

        for (const def of Object.values(MILESTONES)) {
            expect(latinIn(catalogValue('bg', def.messageKey))).toStrictEqual([]);
            expect(latinIn(catalogValue('bg', def.descriptionKey))).toStrictEqual([]);
        }
    });

    it('the default risk matrix reads in Bulgarian', () => {
        const localized = localizeRiskMatrixConfig(DEFAULT_RISK_MATRIX_CONFIG, scoped('riskMatrixDefaults'));
        const words = [
            localized.axisLikelihoodLabel,
            localized.axisImpactLabel,
            ...localized.levelLabels.likelihood,
            ...localized.levelLabels.impact,
            ...localized.bands.map((b) => b.name),
        ];
        expect(words.flatMap(latinIn)).toStrictEqual([]);
    });

    it('a name the tenant chose is shown exactly as stored', () => {
        const renamed = {
            ...DEFAULT_RISK_MATRIX_CONFIG,
            axisImpactLabel: 'Severity',
            levelLabels: {
                likelihood: ['Hardly ever', ...DEFAULT_RISK_MATRIX_CONFIG.levelLabels.likelihood.slice(1)],
                impact: [...DEFAULT_RISK_MATRIX_CONFIG.levelLabels.impact],
            },
            bands: DEFAULT_RISK_MATRIX_CONFIG.bands.map((b, i) => (i === 3 ? { ...b, name: 'Showstopper' } : b)),
        };
        const localized = localizeRiskMatrixConfig(renamed, scoped('riskMatrixDefaults'));
        expect(localized.axisImpactLabel).toBe('Severity');
        expect(localized.levelLabels.likelihood[0]).toBe('Hardly ever');
        expect(localized.levelLabels.likelihood[1]).toBe(bg('riskMatrixDefaults.likelihood.2'));
        expect(localized.bands[3].name).toBe('Showstopper');
        expect(localized.bands[0].name).toBe(bg('riskMatrixDefaults.band.Low'));
        // A display map, never a write: the stored shape is untouched.
        expect(renamed.levelLabels.likelihood[1]).toBe('Unlikely');
    });
});

// ─── I4 / I5 — server-built text ────────────────────────────────────

describe('I4/I5: text the server builds reaches a Bulgarian reader in Bulgarian', () => {
    it('the BIA detail page composes the rationale from messages, not the server sentence', () => {
        const pages = repoFiles({ under: 'src/app', extensions: ['.tsx'] }).filter((file) =>
            /\brecovery\.rationale\b/.test(codeOf(fs.readFileSync(file, 'utf8'))),
        );
        expect(pages.map(repoRelative)).toStrictEqual([]);
        expect(catalogValue('bg', 'audits.biaDetail.recoveryRationale')).toMatch(/възстановяване/);
    });

    it('every activity event and verb has Bulgarian feed and chip copy', () => {
        for (const action of ACTIVITY_EVENT_ACTIONS) {
            expect(latinIn(bg(`dashboard.activity.event.${action}`))).toStrictEqual([]);
            expect(latinIn(bg(`admin.auditActionChip.event.${action}`))).toStrictEqual([]);
        }
        for (const verb of KNOWN_ACTIVITY_VERBS) {
            expect(latinIn(bg(`admin.auditActionChip.verb.${verb}`))).toStrictEqual([]);
        }
    });

    it('every org widget title, stored in English, reads in Bulgarian until the org renames it', () => {
        const t = scoped('org.widgets');
        for (const [key, english] of Object.entries(WIDGET_TITLES)) {
            const [type, chartType] = key.split('/');
            expect(WIDGET_TITLE_MESSAGE_KEYS[key]).toBeDefined();
            expect(latinIn(localizedWidgetTitle(type, chartType, english, t))).toStrictEqual([]);
            expect(latinIn(localizedWidgetTitle(type, chartType, null, t))).toStrictEqual([]);
        }
        expect(localizedWidgetTitle('KPI', 'coverage', 'Board view', t)).toBe('Board view');
    });

    it('every agentic bell title, stored in English, reads in Bulgarian', () => {
        const t = scoped('notificationTitles');
        for (const [type, english] of Object.entries(AGENTIC_NOTIFICATION_TITLES)) {
            expect(latinIn(localizedNotificationTitle(type, english, t))).toStrictEqual([]);
        }
        // Another emitter's title is not this map's to translate.
        expect(localizedNotificationTitle('TASK_ASSIGNED', 'Task assigned', t)).toBe('Task assigned');
    });

    it('the agentic emitter takes its titles from the shared map', () => {
        const emitter = codeOf(fs.readFileSync(`${__dirname}/../../src/app-layer/notifications/agentic.ts`, 'utf8'));
        expect(emitter.match(/\btitle:\s*['"`]/g) ?? []).toStrictEqual([]);
    });
});

// ─── I6 — enums and catalog values ──────────────────────────────────

describe('I6: no raw enum and no English unit or address on a Bulgarian page', () => {
    it('no JSX child is a bare status, severity, tier, criticality or level value', () => {
        // `{row.status}` alone on a line renders `ACTIVE`. Route it through
        // the label map the page already has.
        const bare = /^\s*\{[A-Za-z_$][\w$.?]*\.(?:status|severity|riskTier|tier|criticality|level)\}\s*$/m;
        const offenders = repoFiles({ under: 'src', extensions: ['.tsx'] })
            .filter((file) => bare.test(fs.readFileSync(file, 'utf8')))
            .map(repoRelative);
        expect(offenders).toStrictEqual([]);
    });

    function flatten(tree: Record<string, unknown>, prefix = '', out = new Map<string, string>()) {
        for (const [k, v] of Object.entries(tree)) {
            const path = prefix ? `${prefix}.${k}` : k;
            if (typeof v === 'string') out.set(path, v);
            else flatten(v as Record<string, unknown>, path, out);
        }
        return out;
    }
    const bgValues = flatten(JSON.parse(fs.readFileSync(`${__dirname}/../../messages/bg.json`, 'utf8')));

    it('no Bulgarian value glues a Latin unit to a number ("{period}d", "30d")', () => {
        const glued = [...bgValues].filter(([, v]) => /(?:\}|\d)(?:d|h|w|m|mo|y)\b/.test(v)).map(([k]) => k);
        expect(glued).toStrictEqual([]);
    });

    it('a person in a Bulgarian placeholder address is not "you" or "colleague"', () => {
        const english = [...bgValues].filter(([, v]) => /\b(?:you|colleague)@/i.test(v)).map(([k]) => k);
        expect(english).toStrictEqual([]);
    });
});
