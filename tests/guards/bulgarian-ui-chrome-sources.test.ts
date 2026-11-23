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
 *       feed's raw codes, the audit log's action chips and entity column,
 *       agentic bell titles and bodies, report metric definitions, agent
 *       control-test titles, audit-procedure names, workflow names);
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

import * as ts from 'typescript';

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
import { auditActionKey, auditEntityKey } from '@/lib/audit/audit-code-labels';
import {
    AGENTIC_SUBJECT,
    BREAKER_SIGNAL_CODES,
    ORPHAN_DETAIL,
    STALE_AXES,
    agenticBodyText,
    agentIdSubject,
    localizedNotificationBody,
    pinDetail,
    toolSubject,
} from '@/lib/notifications/agentic-bodies';
import { METRIC_DEFINITIONS } from '@/lib/agentic/report-definitions';
import { joinDefinitionList } from '@/lib/agentic/report-definition-text';
import {
    AGENTIC_CHECK_TITLES,
    ASSURANCE_PLAN_PREFIX,
    PROCEDURE_PLAN_PREFIX,
    localizedPlanName,
    procedureNameKey,
} from '@/lib/agentic/agentic-check-titles';
import { AUDIT_PROCEDURE_LIBRARY_V1, LIBRARY_V1_PROCEDURE_IDS } from '@/lib/agentic/audit-procedure-library';
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import { ISO27001_DOMAIN } from '@/lib/controls/control-taxonomy';
import { CONTROL_CATEGORY_THEMES } from '@/lib/controls/control-categories';
import { frameworkSectionLabel } from '@/lib/framework-tree/section-label';
import { controlCategoryLabel } from '@/app/t/[tenantSlug]/(app)/controls/filter-defs';
import { workflowMessageKey } from '@/lib/agentic/workflow-labels';
import { auditCodePopulation } from '../helpers/audit-code-population';
import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { catalogTranslator, catalogValue } from '../helpers/catalog-translator';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf, declarationOf } from '../helpers/source-blocks';

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

    it('no module formats a date while it loads', () => {
        // The ambient helpers write in the locale bound for the CURRENT render.
        // A module-level constant (`const WEEKDAYS = … formatWeekdayShort(…)`)
        // runs once, at import, and freezes whichever language came first —
        // the calendar's weekday headers stayed English that way.
        const helpers = /^format(?:Date\w*|Month\w*|Weekday\w*|RelativeTime)$/;
        const offenders: string[] = [];
        for (const file of repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })) {
            const text = fs.readFileSync(file, 'utf8');
            if (!text.includes("'@inflect/ui/lib/format-date'")) continue;
            const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
            // A function that is DECLARED or STORED runs later, inside a
            // render. One passed as an argument (`Array.from(…, (_, i) =>
            // formatWeekdayShort(…))`) may run right now, so it is read.
            const deferred = (node: ts.Node): boolean =>
                ts.isFunctionDeclaration(node) ||
                ts.isMethodDeclaration(node) ||
                ts.isClassDeclaration(node) ||
                ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
                    !ts.isCallExpression(node.parent) &&
                    !ts.isNewExpression(node.parent));
            const visit = (node: ts.Node): void => {
                if (deferred(node)) return;
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.test(node.expression.text)) {
                    offenders.push(`${repoRelative(file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
                }
                ts.forEachChild(node, visit);
            };
            sf.statements.forEach(visit);
        }
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
        expect(toggle.match(/'(?:Expand|Collapse) all'/g) ?? []).toStrictEqual([]);
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

// ─── I3 — chrome the shell and the shared primitives own ─────────────

describe('I3: the shell and the shared primitives speak through the catalog', () => {
    /** `description` values written as literals inside `useKeyboardShortcut(…)` calls. */
    function literalShortcutDescriptions(sf: ts.SourceFile): ts.PropertyAssignment[] {
        const found: ts.PropertyAssignment[] = [];
        const visit = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === 'useKeyboardShortcut'
            ) {
                for (const arg of node.arguments) {
                    if (!ts.isObjectLiteralExpression(arg)) continue;
                    for (const prop of arg.properties) {
                        if (
                            ts.isPropertyAssignment(prop) &&
                            prop.name.getText(sf) === 'description' &&
                            (ts.isStringLiteralLike(prop.initializer) || ts.isTemplateExpression(prop.initializer)) &&
                            /[A-Za-z]/.test(prop.initializer.getText(sf))
                        ) {
                            found.push(prop);
                        }
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
        return found;
    }

    it('no keyboard shortcut is registered with a literal description', () => {
        // The command palette lists every registered shortcut by its
        // description, so the description is UI copy: "Close navigation
        // drawer" read in English on a Bulgarian dashboard (#5828). Every
        // `useKeyboardShortcut(…, { description })` in `src/` passes a
        // translated string, never a string or template literal.
        const offenders: string[] = [];
        for (const file of repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })) {
            const text = fs.readFileSync(file, 'utf8');
            if (!text.includes('useKeyboardShortcut(')) continue;
            const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
            for (const prop of literalShortcutDescriptions(sf)) {
                offenders.push(`${repoRelative(file)}:${sf.getLineAndCharacterOfPosition(prop.getStart()).line + 1}`);
            }
        }
        expect(offenders).toStrictEqual([]);
    });

    it('the shortcut scan sees a literal description, and not a translated one', () => {
        // The population above is empty on a clean tree; this proves the
        // detector is not blind.
        const probe = (code: string) =>
            literalShortcutDescriptions(ts.createSourceFile('probe.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
        expect(probe("useKeyboardShortcut('Escape', close, { description: 'Close navigation drawer' });")).toHaveLength(1);
        expect(probe('useKeyboardShortcut("f", open, { scope: "global", description: `Open ${what}` });')).toHaveLength(1);
        expect(probe("useKeyboardShortcut('Escape', close, { description: tNav('closeNavigationDrawer') });")).toHaveLength(0);
    });

    it.each(Object.entries(ISO27001_DOMAIN))(
        'the controls browse rail, Category column and filter label the ISO 27001 domain %s in Bulgarian',
        (_key, domain) => {
            // The domain strings are the taxonomy's grouping, ordering and
            // filter keys and stay English; every surface labels them through
            // `controlCategoryLabel` (#5828).
            expect(latinIn(controlCategoryLabel(domain, scoped('controls')))).toStrictEqual([]);
        },
    );

    it.each(CONTROL_CATEGORY_THEMES)('a framework tree section grouped on the ISO theme %s reads in Bulgarian', (theme) => {
        // The framework page named its four ISO 27001 sections by the stored
        // constant ("ORGANIZATIONAL") in every language.
        expect(latinIn(frameworkSectionLabel(theme, (key) => bg(key)))).toStrictEqual([]);
        // A section a framework names itself is its own text.
        expect(frameworkSectionLabel('Annex A', (key) => bg(key))).toBe('Annex A');
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

// ─── I4 — the rest of the server-built text ─────────────────────────

/**
 * Latin a Bulgarian label may keep: product, vendor and standard names,
 * acronyms, and Microsoft's own term "service principal" (owner decision
 * 2026-10-30, #4553). Everything else in a Bulgarian label is Cyrillic.
 */
const KEPT_LATIN = new Set([
    'A2A', 'API', 'BIA', 'CVE', 'Entra', 'FAIR', 'KRI', 'MCP', 'MFA', 'NDA', 'NIS2', 'OpenShell',
    'OrangeHRM', 'SCIM', 'SLA', 'SharePoint', 'SoA', 'Workday', 'OWASP', 'Agentic', 'Top', 'SAP',
    'service', 'principal',
]);
const foreignWords = (text: string): string[] =>
    (text.replace(/\{[^{}]*\}/g, ' ').match(/[A-Za-z][A-Za-z0-9]*/g) ?? []).filter((w) => !KEPT_LATIN.has(w));
const CYRILLIC = /[Ѐ-ӿ]/;

/**
 * Audit codes written through a value the scan cannot read (a parameter, an
 * imported constant, a computed prefix), by file: how many such sites the
 * file holds, and the codes they write. A NEW site fails the test below until
 * somebody lists what it writes here — that is what makes "every code has a
 * label" a claim about the product rather than about the literals.
 */
const CODES_THROUGH_A_VALUE: Readonly<Record<string, { sites: number; codes: readonly string[]; why: string }>> = {
    'src/app-layer/events/audit.ts': { sites: 1, codes: [], why: 'logEvent itself, carrying its caller’s code' },
    'src/app-layer/jobs/dsar-erasure.ts': { sites: 1, codes: ['ERASURE_EXECUTED'], why: 'imported ERASURE_EXECUTED_ACTION' },
    'src/app-layer/repositories/DashboardRepository.ts': { sites: 1, codes: [], why: 'projects a stored row for the feed' },
    'src/app-layer/usecases/access-review.ts': {
        sites: 2,
        codes: ['ACCESS_REVIEW_EVIDENCE_GENERATED', 'ACCESS_REVIEW_EVIDENCE_REGENERATED'],
        why: 'the refusal helper carries literal codes its callers pass (read by the scan); the evidence filer takes a union',
    },
    'src/app-layer/usecases/agent-registry.ts': { sites: 1, codes: ['AGENT_ACTIVATED', 'AGENT_SUSPENDED'], why: 'the status writer’s parameter' },
    'src/app-layer/usecases/dsar-register.ts': {
        sites: 2,
        codes: ['DSAR_REQUESTED', 'DSAR_VERIFIED', 'DSAR_STARTED', 'DSAR_CANCELED', 'DSAR_COMPLETED', 'DSAR_REJECTED'],
        why: 'imported DSAR_AUDIT_ACTIONS',
    },
    'src/app-layer/usecases/editable-lifecycle-usecase.ts': {
        sites: 5,
        codes: ['POLICY_DRAFT_UPDATED', 'POLICY_PUBLISHED', 'POLICY_VERSION_CREATED', 'POLICY_REVERTED', 'POLICY_ARCHIVED'],
        why: 'buildAction(<prefix>, <operation>); the policy adapter is the one config',
    },
    'src/app-layer/usecases/org-members.ts': { sites: 1, codes: ['ORG_ADMIN_PROVISIONED', 'ORG_ADMIN_DEPROVISIONED'], why: 'TenantFanoutAuditAction' },
    'src/app-layer/usecases/scim-users.ts': {
        sites: 1,
        codes: ['SCIM_USER_CREATED', 'SCIM_USER_UPDATED', 'SCIM_USER_DEACTIVATED', 'SCIM_USER_REACTIVATED'],
        why: 'the audit helper’s parameter',
    },
    'src/app/t/[tenantSlug]/(app)/admin/audit-log/page.tsx': { sites: 2, codes: [], why: 'the page reads stored rows' },
    'src/lib/audit-log.ts': { sites: 2, codes: [], why: 'a pass-through writer' },
    'src/lib/audit/audit-writer.ts': { sites: 1, codes: [], why: 'the hash-chained writer itself' },
    'src/lib/audit/event-builder.ts': { sites: 1, codes: [], why: 'a pass-through builder' },
    'src/lib/audit/verify.ts': { sites: 3, codes: [], why: 'the chain verifier reads stored rows' },
    'src/lib/auth/security-events.ts': {
        sites: 1,
        codes: [
            'AUTH_LOGIN_SUCCESS', 'AUTH_LOGIN_FAILURE', 'AUTH_LOGIN_RATE_LIMITED', 'AUTH_LOGIN_EMAIL_VERIFICATION_REQUIRED',
            'AUTH_EMAIL_VERIFICATION_ISSUED', 'AUTH_EMAIL_VERIFIED', 'AUTH_PASSWORD_RESET_REQUESTED',
            'AUTH_PASSWORD_RESET_COMPLETED', 'AUTH_PASSWORD_CHANGED', 'AUTH_UNVERIFIED_ACCOUNT_CLAIMED',
        ],
        why: 'SecurityEventAction',
    },
    'src/lib/dto/common.ts': { sites: 1, codes: [], why: 'a DTO mapper over stored rows' },
    'src/lib/prisma.ts': {
        sites: 1,
        codes: ['CREATE', 'CREATEMANY', 'UPDATE', 'UPDATEMANY', 'DELETE', 'DELETEMANY', 'UPSERT'],
        why: 'the audit extension writes the operation, upper-cased, for every model but AuditLog',
    },
};

describe('I4: every audit code reads in Bulgarian', () => {
    const population = auditCodePopulation();
    const actions = [
        ...new Set([
            ...population.actions,
            ...Object.values(CODES_THROUGH_A_VALUE).flatMap((s) => s.codes),
            ...ACTIVITY_EVENT_ACTIONS,
        ]),
    ].sort();
    // The audit extension writes every model's own name as the entity.
    const entities = [
        ...new Set([...population.entities, ...parseSchemaModels().map((m) => m.name).filter((n) => n !== 'AuditLog')]),
    ];

    it('measured a real population', () => {
        expect(actions.length).toBeGreaterThan(450);
        expect(entities.length).toBeGreaterThan(250);
    });

    it('every code written through a value is listed with the codes it writes', () => {
        const sites: Record<string, number> = {};
        for (const at of population.unresolved) {
            const file = at.slice(0, at.lastIndexOf(':'));
            sites[file] = (sites[file] ?? 0) + 1;
        }
        const listed = Object.fromEntries(Object.entries(CODES_THROUGH_A_VALUE).map(([f, s]) => [f, s.sites]));
        expect(sites).toStrictEqual(listed);
    });

    it('every action code has a label in both catalogs, and the Bulgarian one is Bulgarian', () => {
        const missing: string[] = [];
        const foreign: string[] = [];
        for (const code of actions) {
            const key = `auditCodes.action.${auditActionKey(code)}`;
            try {
                catalogValue('en', key);
                const label = catalogValue('bg', key);
                if (!CYRILLIC.test(label) || foreignWords(label).length > 0) foreign.push(`${code}: ${label}`);
            } catch {
                missing.push(code);
            }
        }
        expect({ missing, foreign }).toStrictEqual({ missing: [], foreign: [] });
    });

    it('every entity type has a label in both catalogs, and the Bulgarian one is Bulgarian', () => {
        const missing: string[] = [];
        const foreign: string[] = [];
        for (const entity of entities) {
            const key = `auditCodes.entity.${auditEntityKey(entity)}`;
            try {
                catalogValue('en', key);
                const label = catalogValue('bg', key);
                if (foreignWords(label).length > 0) foreign.push(`${entity}: ${label}`);
            } catch {
                missing.push(entity);
            }
        }
        expect({ missing, foreign }).toStrictEqual({ missing: [], foreign: [] });
    });

    it('one entity type spelled two ways shares one label', () => {
        expect(auditEntityKey('AccessReview')).toBe(auditEntityKey('ACCESS_REVIEW'));
        expect(auditEntityKey('TenantA2aSigningKey')).toBe('tenant_a2a_signing_key');
    });
});

describe('I4: an agentic notification body reads in Bulgarian, stored rows included', () => {
    const t = scoped('notificationBodies');
    const NAME = 'Kestrel';

    // Every body the emitter can write: each subject it builds, and each
    // detail it builds for the types that carry one.
    const bodies: [string, string][] = [
        ['AGENT_KILL_SWITCH_ENGAGED', agenticBodyText('AGENT_KILL_SWITCH_ENGAGED', AGENTIC_SUBJECT.EVERY_AGENT, null)],
        ['AGENT_KILL_SWITCH_ENGAGED', agenticBodyText('AGENT_KILL_SWITCH_ENGAGED', NAME, null)],
        ['AGENT_PROPOSAL_QUARANTINED', agenticBodyText('AGENT_PROPOSAL_QUARANTINED', AGENTIC_SUBJECT.UNATTRIBUTED_CREDENTIAL, null)],
        ['AGENT_CIRCUIT_BREAKER_TRIPPED', agenticBodyText('AGENT_CIRCUIT_BREAKER_TRIPPED', NAME, BREAKER_SIGNAL_CODES.join(', '))],
        ['AGENT_CIRCUIT_BREAKER_TRIPPED', agenticBodyText('AGENT_CIRCUIT_BREAKER_TRIPPED', NAME, null)],
        ['AGENT_TOOL_MANIFEST_PIN_CHANGED', agenticBodyText('AGENT_TOOL_MANIFEST_PIN_CHANGED', toolSubject(NAME), pinDetail(null))],
        ['AGENT_TOOL_MANIFEST_PIN_CHANGED', agenticBodyText('AGENT_TOOL_MANIFEST_PIN_CHANGED', toolSubject(NAME), pinDetail(3))],
        [
            'AGENT_RISK_ASSESSMENT_STALE',
            agenticBodyText('AGENT_RISK_ASSESSMENT_STALE', NAME, STALE_AXES.map((a) => `${a} (none) → (none)`).join('; ')),
        ],
        ...Object.values(ORPHAN_DETAIL).map(
            (d) => ['AGENT_OWNER_DEPARTED', agenticBodyText('AGENT_OWNER_DEPARTED', NAME, d)] as [string, string],
        ),
    ];

    it.each(bodies)('%s (case %#)', (type, stored) => {
        const shown = localizedNotificationBody(type, stored, t);
        expect(shown).not.toBe(stored);
        // The agent's and the tool's names are a person's words, shown as written.
        const words = foreignWords(shown).filter((w) => w !== NAME);
        expect(words).toStrictEqual([]);
    });

    it('an agent named only by its id reads as "Агент <id>"', () => {
        const stored = agenticBodyText('AGENT_KILL_SWITCH_ENGAGED', agentIdSubject('cmh0abcdefghijklmnopqrstu'), null);
        expect(localizedNotificationBody('AGENT_KILL_SWITCH_ENGAGED', stored, t)).toMatch(/^Агент cmh0abcdefghijklmnopqrstu /);
    });

    it('a body this module did not write is shown exactly as stored', () => {
        const odd = agenticBodyText('AGENT_RISK_ASSESSMENT_STALE', NAME, 'something a later build wrote');
        expect(localizedNotificationBody('AGENT_RISK_ASSESSMENT_STALE', odd, t)).toBe(odd);
        expect(localizedNotificationBody('TASK_ASSIGNED', 'You were assigned a task', t)).toBe('You were assigned a task');
    });

    it('the emitter writes its bodies through the shared sentences', () => {
        const emitter = codeOf(fs.readFileSync(`${__dirname}/../../src/app-layer/notifications/agentic.ts`, 'utf8'));
        expect(emitter.match(/\bbody:\s*\([^)]*\)\s*=>\s*`/g) ?? []).toStrictEqual([]);
        expect(emitter.match(/\bbody:\s*\([^)]*\)\s*=>\s*agenticBodyText\(/g)?.length).toBe(
            Object.keys(AGENTIC_NOTIFICATION_TITLES).length,
        );
    });
});

describe('I4: report metric definitions read in Bulgarian', () => {
    const defs = Object.values(METRIC_DEFINITIONS);

    it('the English catalog is the registry, word for word', () => {
        const drift = defs.filter((d) => {
            const en = (f: string) => catalogValue('en', `agentMetrics.${d.id}.${f}`);
            return (
                en('label') !== d.label ||
                en('population') !== d.population ||
                en('includes') !== joinDefinitionList(d.includes) ||
                en('excludes') !== joinDefinitionList(d.excludes)
            );
        });
        expect(drift.map((d) => d.id)).toStrictEqual([]);
    });

    it('every definition has Bulgarian label, population, includes and excludes', () => {
        const untranslated: string[] = [];
        for (const d of defs) {
            for (const f of ['label', 'population', 'includes', 'excludes']) {
                const value = catalogValue('bg', `agentMetrics.${d.id}.${f}`);
                if (value !== '—' && !CYRILLIC.test(value)) untranslated.push(`${d.id}.${f}`);
            }
        }
        expect(untranslated).toStrictEqual([]);
    });
});

describe('I4: agent control tests and audit procedures read in Bulgarian', () => {
    it('every check’s title is the shared one, and reads in Bulgarian', () => {
        const src = codeOf(fs.readFileSync(`${__dirname}/../../src/app-layer/services/agent-control-tests.ts`, 'utf8'));
        const ids = declarationOf(src, 'AGENTIC_CHECK_IDS').match(/'AGENTIC_[A-Z0-9_]+'/g)?.map((s) => s.slice(1, -1)) ?? [];
        expect(ids.sort()).toStrictEqual(Object.keys(AGENTIC_CHECK_TITLES).sort());
        // Every entry of the registry names its title from the shared map.
        const named = [...declarationOf(src, 'AGENTIC_CHECKS').matchAll(/\btitle:\s*AGENTIC_CHECK_TITLES\.(\w+)/g)].map((m) => m[1]);
        expect(named.sort()).toStrictEqual(ids.sort());
        for (const [id, english] of Object.entries(AGENTIC_CHECK_TITLES)) {
            expect(catalogValue('en', `agentChecks.title.${id}`)).toBe(english);
            expect(foreignWords(catalogValue('bg', `agentChecks.title.${id}`))).toStrictEqual([]);
        }
    });

    it('a stock plan name reads in Bulgarian; a renamed one is shown as written', () => {
        const tChecks = Object.assign(scoped('agentChecks'), {
            has: (k: string) => { try { catalogValue('bg', `agentChecks.${k}`); return true; } catch { return false; } },
        });
        const tProcedures = Object.assign(scoped('audits.workpaperReviews.procedureName'), {
            has: (k: string) => {
                try { catalogValue('bg', `audits.workpaperReviews.procedureName.${k}`); return true; } catch { return false; }
            },
        });
        for (const title of Object.values(AGENTIC_CHECK_TITLES)) {
            expect(foreignWords(localizedPlanName(`${ASSURANCE_PLAN_PREFIX}${title}`, tChecks, tProcedures))).toStrictEqual([]);
        }
        for (const id of LIBRARY_V1_PROCEDURE_IDS) {
            const shown = localizedPlanName(
                `${PROCEDURE_PLAN_PREFIX}${AUDIT_PROCEDURE_LIBRARY_V1[id].title} (${id})`,
                tChecks,
                tProcedures,
            );
            expect(shown).toContain(catalogValue('bg', `audits.workpaperReviews.procedureName.${procedureNameKey(id)}`));
            expect(foreignWords(shown.replace(`(${id})`, ''))).toStrictEqual([]);
        }
        expect(localizedPlanName('Quarterly access check', tChecks, tProcedures)).toBe('Quarterly access check');
        expect(localizedPlanName(`${ASSURANCE_PLAN_PREFIX}our own wording`, tChecks, tProcedures)).toBe(
            `${ASSURANCE_PLAN_PREFIX}our own wording`,
        );
    });

    it('every library procedure has a Bulgarian name', () => {
        for (const id of LIBRARY_V1_PROCEDURE_IDS) {
            const key = `audits.workpaperReviews.procedureName.${procedureNameKey(id)}`;
            expect(catalogValue('en', key)).toBe(AUDIT_PROCEDURE_LIBRARY_V1[id].title);
            expect(foreignWords(catalogValue('bg', key))).toStrictEqual([]);
        }
    });
});

describe('I4: workflow names read in Bulgarian', () => {
    it('every registered workflow has its name and description in both catalogs', () => {
        for (const w of listWorkflowDefinitions()) {
            const key = `agentWorkflows.${workflowMessageKey(w.key)}`;
            expect(catalogValue('en', `${key}.name`)).toBe(w.name);
            expect(catalogValue('en', `${key}.description`)).toBe(w.description);
            expect(foreignWords(catalogValue('bg', `${key}.name`))).toStrictEqual([]);
            expect(foreignWords(catalogValue('bg', `${key}.description`))).toStrictEqual([]);
        }
    });

    it('no page shows a definition’s own name or description', () => {
        // `def.name` / `w.name` of a workflow definition reaches the page only
        // through `localizedWorkflowName`. The scan reads the files that load
        // the registry.
        const offenders: string[] = [];
        for (const file of repoFiles({ under: 'src', extensions: ['.tsx'] })) {
            const src = codeOf(fs.readFileSync(file, 'utf8'));
            if (!/\b(?:get|list)WorkflowDefinitions?\b/.test(src)) continue;
            const unwrapped = src.split('\n').filter(
                (line) => /\b(?:def\??|w)\.(?:name|description)\b/.test(line) && !/localizedWorkflow(?:Name|Description)\(/.test(line),
            );
            if (unwrapped.length > 0) offenders.push(`${repoRelative(file)}: ${unwrapped[0].trim()}`);
        }
        expect(offenders).toStrictEqual([]);
    });
});
