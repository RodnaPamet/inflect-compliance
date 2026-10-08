/**
 * i18n adoption ratchet — new UI surfaces MUST go through next-intl.
 *
 * Companion to the GAP-19 completeness guard
 * (`i18n-completeness.test.ts`). That test guarantees every key in
 * `en.json` has a translated `bg.json` counterpart — but it can only
 * police strings that already live in the message catalog. It says
 * nothing about a brand-new page that hardcodes `<h1>Dashboard</h1>`
 * and never reaches the catalog at all. Those screens render in
 * English regardless of the user's locale, and nothing caught them —
 * until this ratchet.
 *
 * ## The invariant
 *
 * Every `.tsx` file under the tenant app tree that renders
 * user-facing text MUST adopt next-intl (import `useTranslations` or
 * `getTranslations`). "Renders user-facing text" is detected
 * heuristically (see `hasHardcodedUiText`): a JSX text node with a
 * real word, or a UI-text prop / object key (`title` / `placeholder`
 * / `label` / `header` / …) carrying a string LITERAL. The `{t(...)}`
 * migrated form never matches — a value in `{}` braces is not a
 * quoted literal.
 *
 * ## Ratchet policy (mirrors the `as any` ratchet)
 *
 *   • `STRING_BUDGET` records, per file, how many hardcoded user-facing
 *     strings it carries today. Every number only moves DOWN, and a file
 *     at zero has no entry at all.
 *   • FORWARD: any file whose live string count EXCEEDS its budget fails —
 *     a new hardcoded string, whether or not the file uses next-intl.
 *   • DRIFT: a budget above the live count fails too, so paying a string
 *     down and forgetting to lower the number cannot leave headroom a
 *     future regression spends with a green build.
 *   • NO-STALE: an entry whose file reached zero, was deleted, or left the
 *     scanned population must be removed.
 *
 * ## Why the unit is the STRING (#3265)
 *
 * It used to be the FILE: `UNMIGRATED_BASELINE` was a set meaning "has text
 * and no next-intl", and the forward check was
 * `hasHardcodedUiText(raw) && !USES_INTL.test(raw)`. `USES_INTL` is a bare
 * identifier regex over the whole source, so ONE `t()` call anywhere made
 * every other string in the file invisible — permanently, because a
 * partially-migrated file has text AND intl and so matched no entry shape.
 * It could be neither flagged nor grandfathered nor ratcheted down.
 *
 * Measured at the switch: 60% of the hardcoded strings in the scanned tree
 * were invisible that way — 117 strings across 34 files, against 79 the
 * ratchet could see. The numbers are recorded beside `STRING_BUDGET`.
 *
 * The old coverage of partial migration was ACCIDENTAL and worth naming: a
 * partially migrated file surfaced only if it happened to be grandfathered,
 * because migrating it made its entry stale and the no-stale test spoke up.
 * For a file that was never baselined, nothing fired and nothing ever would.
 *
 * ## Scope + known limitations (deliberate, documented)
 *
 *   • Scope is `.tsx` under `src/app/t/[tenantSlug]/(app)`, the org
 *     portal `src/app/org`, and the shared component library
 *     `src/components` — the three surfaces the locale-selectable UI
 *     work covered. Module-level shared label maps in `.ts` files
 *     (filter-defs, `*-options.ts` enum labels) are the same
 *     documented follow-up the vendors/assets PRs carved out.
 *   • This enforces next-intl ADOPTION, not per-string completeness.
 *     A file already on next-intl can still carry a residual literal
 *     (some partial migrations do today); catching every straggler is
 *     the migration PRs' job, not this ratchet's. The high-value
 *     invariant here is: no NEW surface ships without next-intl.
 *   • JSX text is read from the TypeScript AST; the UI-prop check is a
 *     regex. Text reaching the DOM through a variable, a child
 *     component, a parameter default (`ariaLabel = 'Tabs'`), a literal
 *     inside an attribute EXPRESSION (`aria-label={a ? 'x' : 'y'}`) or a
 *     text node sitting beside an `{expression}` is invisible to it. It
 *     catches the common case — literal strings in JSX / props — which is
 *     exactly what "new UI strings go through next-intl" means in
 *     practice.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_DIR = path.join(REPO_ROOT, 'src/app/t/[tenantSlug]/(app)');
// The 2026-07 component-tree wave extended coverage past the tenant app to
// the shared component library and the multi-tenant org portal — the two
// blind spots that rendered English regardless of locale. `src/app/org` is
// fully migrated (zero grandfathered files); `src/components` carries a
// shrinking baseline of not-yet-localised primitives.
const ORG_DIR = path.join(REPO_ROOT, 'src/app/org');
const COMPONENTS_DIR = path.join(REPO_ROOT, 'src/components');
/**
 * The shared package's components (#3213).
 *
 * Until this was added, every file #3046 moved into `packages/ui` LEFT this
 * ratchet's population, so each extraction batch quietly shrank the surface it
 * covers. That compounds in the worst direction: the files being moved are
 * exactly the shared primitives another product vendors, so the surface with
 * the weakest copy discipline was the one drifting out of scope.
 *
 * It surfaced as a stale-baseline failure, not as reasoning -- #3212 moved
 * `time-series-chart.tsx` and the entry had to be deleted to go green, which
 * removed the only trace that the file had ever been grandfathered. The
 * stale-entry message lists three causes and the real fourth one, "the file
 * left the scanned population", was not among them.
 */
const PKG_COMPONENTS_DIR = path.join(REPO_ROOT, 'packages/ui/src/components');

// ─── Detection ──────────────────────────────────────────────────

/** Strip block + line comments so prose in comments never matches. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Strip TypeScript generic type annotations + casts — `: Promise<{…}>`
 * and `as Promise<Row[]>`, and explicit call type arguments like
 * `useRef<Set<string>>(…)` — before the UI-prop scan.
 *
 * It was written for the regex JSX-text check this file used to run,
 * whose `>…<` window read the code between a generic's closing `>` and
 * the next JSX `<` as a text node. JSX text now comes from the AST
 * (`collectJsxText`, which was `hasJsxTextBetweenTags` before #3265 made the
 * unit the string rather than the file), where that cannot happen. When the switch
 * was made, no UI_PROP verdict over the 977 scanned files depended on
 * this step; it stays so that change replaced only the JSX-text half of
 * the detector.
 */
function stripTypeAnnotations(src: string): string {
    return (
        src
            .replace(/(:|(?:\bas\b))\s*[A-Za-z_][\w.]*\s*<[\s\S]*?>/g, '$1 _')
            // Anchored on `>(` so it only ever eats a generic call site, never
            // JSX (which opens with `<`) or a `a < b` comparison.
            .replace(/\b([A-Za-z_][\w.]*)\s*<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\(/g, '$1(')
    );
}

const USES_INTL = /\b(useTranslations|getTranslations)\b/;

/**
 * A JSX text node holding a real (>=3-char lowercase) word, sitting
 * directly between two tags: `>Save changes<`, not `>Save {n} rows<`.
 *
 * The same rule the regex `>[^<>{}]*[a-z]{3,}[^<>{}]*<` stated, read from
 * the AST instead of from source text. A regex cannot tell a text node
 * from TypeScript: two generic bases in an `extends` clause
 * (`>,\n VariantProps<`), an arrow's `=>` followed later by a JSX `<`, and
 * the code between one element's closing `>` and the next element's `<`
 * all read as text. Measured on 2026-09-29 over the 977 files this ratchet
 * scans: 39 of the 76 UNMIGRATED_BASELINE entries were listed for that
 * syntax alone (button, card, checkbox, the chart primitives, the app
 * shell) and render no JSX text at all, while the AST reading flagged no
 * file the regex did not — 39 fewer, 0 new.
 *
 * The `>` / `<` neighbour test is what keeps it the SAME rule. A text node
 * beside an `{expression}` was invisible to the regex and still is; widening
 * that is a separate decision, because it surfaces files no baseline lists.
 */
const JSX_WORD = /[a-z]{3,}/;

/**
 * EVERY hardcoded JSX text node, not just the first (#3265).
 *
 * This used to be `hasJsxTextBetweenTags`, returning a boolean and short-
 * circuiting on the first hit — it walked the AST, found the exact nodes, and
 * threw their positions away. That made the ratchet's unit the FILE when the
 * thing it cares about is the STRING, and one `t()` call anywhere in a file
 * made every other string in it invisible. Collecting the text costs nothing
 * the walk was not already doing and is what lets a partially-migrated file be
 * graded.
 */
function collectJsxText(raw: string): string[] {
    const sf = ts.createSourceFile(
        'scan.tsx',
        raw,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.TSX,
    );
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isJsxText(node) &&
            JSX_WORD.test(node.text) &&
            raw[node.getFullStart() - 1] === '>' &&
            raw[node.getEnd()] === '<'
        ) {
            out.push(node.text.trim().replace(/\s+/g, ' '));
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

// UI-text-bearing props / object keys whose value is a STRING LITERAL
// containing a >=2-char lowercase run (skips acronyms like 'ISO',
// 'NIS2'). The ["'] immediately after =/: is load-bearing: the
// migrated {t('key')} form is in braces, so it can never match here.
const UI_PROP =
    /\b(?:title|placeholder|label|description|aria-label|searchPlaceholder|confirmLabel|heading|subtitle|emptyTitle|emptyDescription|tooltip|header|confirmText|cancelText|actionLabel)\s*[=:]\s*["'][^"'\n]*[a-z]{2,}[^"'\n]*["']/g;

/**
 * Every hardcoded user-facing string in this source, with its text (#3265).
 *
 * `UI_PROP` now carries `/g` and is read with `matchAll`. A non-global regex's
 * `.test()` answers "is there at least one", which is the same
 * boolean-by-construction limitation `collectJsxText` had: it cannot see the
 * second string in a file, so it cannot see partial migration.
 *
 * NOTE the `/g` + `matchAll` pairing specifically. A global regex carries
 * `lastIndex` across `.test()` calls, so reusing this constant with `.test()`
 * would return alternating answers for identical input. `matchAll` does not
 * mutate it.
 */
function collectHardcodedUiStrings(raw: string): {
    readonly jsx: readonly string[];
    readonly props: readonly string[];
    readonly total: number;
} {
    const jsx = collectJsxText(raw);
    const props = [...stripTypeAnnotations(stripComments(raw)).matchAll(UI_PROP)].map(
        (m) => m[0],
    );
    return { jsx, props, total: jsx.length + props.length };
}

/**
 * Heuristic: does this source render hardcoded, user-facing text?
 *
 * Retained as the boolean view over the collector so the invariant above reads
 * the same, and so the two can never disagree about a file.
 */
export function hasHardcodedUiText(raw: string): boolean {
    return collectHardcodedUiStrings(raw).total > 0;
}

/**
 * Every `.tsx` UI file under `dir`.
 *
 * Co-located tests are skipped. `src/**\/__tests__/` is a real directory in
 * this codebase (Epic 67's convention — hook tests live next to the hook),
 * and a test harness that renders `<input aria-label="name" />` is not a
 * user-facing surface: localising it would mean translating fixtures. The
 * guard flagged the first such file to carry JSX, which is a false positive,
 * not un-migrated UI.
 */
function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === '__tests__') continue;
            out.push(...walk(p));
        } else if (e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx')) {
            out.push(p);
        }
    }
    return out;
}

function rel(abs: string): string {
    return path.relative(REPO_ROOT, abs);
}

// ─── Frozen baseline — grandfathered un-migrated files ──────────
//
// Per-file CEILING on hardcoded user-facing strings. Only ever goes DOWN.
//
// WHY A COUNT AND NOT A MEMBERSHIP SET (#3265)
// ────────────────────────────────────────────
// This was `UNMIGRATED_BASELINE`, a set meaning "has text AND no next-intl".
// That shape cannot express a PARTIALLY migrated file — one with text AND
// intl — so such a file could be neither flagged nor grandfathered nor
// ratcheted down. The debt was simply unrepresentable, and one `t()` call
// anywhere in a file made every other string in it invisible, permanently.
//
// MEASURED at the switch, over the same four directories (982 .tsx files,
// 417 of them already using next-intl):
//
//   visible to the old ratchet   26 files    79 strings   (all 26 were baselined)
//   INVISIBLE (partial)          34 files   118 strings
//   ----------------------------------------------------
//   total                        60 files   197 strings
//
// (196 at first measurement; +1 when #3272 merged a new hardcoded label while
//  this PR was in the queue. Re-measured on the union rather than on the branch.)
//
// So 60% of the hardcoded UI strings in the scanned tree were unseen, and the
// invisible debt EXCEEDED the visible debt. The JSX-text-only slice of the
// invisible set is 10 files / 21 strings, which reproduces #3265's independent
// measurement exactly — two detectors written separately agreeing on that
// subset is what makes the rest of these numbers trustworthy.
//
// The old set's verdicts are preserved: the 26 `no-intl` entries below are
// byte-identical to the former `UNMIGRATED_BASELINE`, verified as an identical
// set rather than an equal count.
//
// A file with next-intl and zero hardcoded strings scores 0 and needs no entry,
// which is the state the old set was trying to describe by omission.
const STRING_BUDGET: Readonly<Record<string, number>> = {
    'packages/ui/src/components/ui/charts/time-series-chart.tsx': 1, // no-intl, 1 jsx
    'src/app/org/[orgSlug]/(app)/members/MembersTable.tsx': 2, // partial, 2 prop
    'src/app/org/[orgSlug]/(app)/tenants/new/NewTenantForm.tsx': 2, // partial, 2 prop
    // 23 -> 24: #3272 (Step 5a) added `label: 'Access reviews'` to the scope
    // group map after this budget was first measured, and the ratchet caught it
    // on the merge-group candidate — green alone, red on the union. Recorded at
    // 24 rather than localised here: a ratchet's baseline is the state of the
    // tree it is INTRODUCED on, and reaching into another branch's just-merged
    // feature to pay one string down would widen this PR past its subject. The
    // guard now stops the 25th.
    // 24 -> 6: #3289 then localised that row AND the seventeen like it. The whole
    // SCOPE_GROUPS table was hardcoded English, so paying down only the newest row
    // would have left it half-translated — the state where the next contributor
    // copies whichever neighbour they land on.
    //
    // Keep the sequence: 23 was a file that already called `t()` and scored as
    // ADOPTED under the old file-level check. It is the clearest record in this
    // file of why the unit had to become the string.
    'src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx': 6, // partial, 1 jsx + 5 prop
    'src/app/t/[tenantSlug]/(app)/admin/billing/BillingEventLog.tsx': 6, // partial, 6 prop
    'src/app/t/[tenantSlug]/(app)/admin/billing/page.tsx': 1, // partial, 1 jsx
    'src/app/t/[tenantSlug]/(app)/admin/entra/page.tsx': 8, // partial, 7 jsx + 1 prop
    'src/app/t/[tenantSlug]/(app)/admin/integrations/identity-accounts/page.tsx': 2, // partial, 2 prop
    'src/app/t/[tenantSlug]/(app)/admin/notifications/page.tsx': 2, // partial, 2 prop
    'src/app/t/[tenantSlug]/(app)/admin/sso/page.tsx': 9, // partial, 9 prop
    'src/app/t/[tenantSlug]/(app)/admin/trust-center/TrustCenterAdminClient.tsx': 3, // partial, 3 prop
    'src/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/page.tsx': 1, // partial, 1 prop
    'src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx': 2, // partial, 2 prop
    'src/app/t/[tenantSlug]/(app)/audits/nis2-gap/Nis2GapLifecycleClient.tsx': 7, // partial, 2 jsx + 5 prop
    'src/app/t/[tenantSlug]/(app)/calendar/_components/CalendarHeatmap.tsx': 1, // partial, 1 prop
    'src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx': 2, // partial, 1 jsx + 1 prop
    'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx': 17, // partial, 17 prop
    'src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/page.tsx': 1, // partial, 1 prop
    'src/app/t/[tenantSlug]/(app)/incidents/[incidentId]/page.tsx': 1, // partial, 1 prop
    'src/app/t/[tenantSlug]/(app)/policies/[policyId]/PolicySharePointSection.tsx': 1, // partial, 1 jsx
    'src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx': 1, // partial, 1 prop
    'src/app/t/[tenantSlug]/(app)/risks/NewRiskModal.tsx': 1, // partial, 1 prop
    'src/app/t/[tenantSlug]/(app)/risks/ai-systems/NewAiSystemModal.tsx': 3, // partial, 3 prop
    'src/app/t/[tenantSlug]/(app)/risks/ai-systems/[systemId]/AiSystemDetailClient.tsx': 3, // partial, 3 prop
    'src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx': 1, // partial, 1 prop
    'src/app/t/[tenantSlug]/(app)/tests/page.tsx': 3, // partial, 3 prop
    'src/app/t/[tenantSlug]/(app)/tests/runs/[runId]/page.tsx': 1, // partial, 1 prop
    'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx': 1, // partial, 1 prop
    'src/components/TraceabilityPanel.tsx': 1, // partial, 1 prop
    'src/components/dev/swr-devtools.tsx': 9, // no-intl, 6 jsx + 3 prop
    'src/components/layout/ListPageShell.tsx': 2, // no-intl, 2 prop
    'src/components/layout/MobileNavDrawer.tsx': 1, // partial, 1 prop
    'src/components/layout/org-workspace-switcher.tsx': 6, // no-intl, 5 jsx + 1 prop
    'src/components/layout/tenant-switcher.tsx': 5, // no-intl, 4 jsx + 1 prop
    'src/components/onboarding/Nis2SelfAssessmentStep.tsx': 14, // no-intl, 9 jsx + 5 prop
    'src/components/onboarding/OnboardingWizard.tsx': 3, // partial, 3 jsx
    'src/components/processes/RuleDetailSheet.tsx': 4, // partial, 3 jsx + 1 prop
    'src/components/risks/RiskScoreExplainer.tsx': 1, // partial, 1 prop
    'src/components/ui/ComplianceStatusIndicator.tsx': 4, // no-intl, 4 prop
    'src/components/ui/DonutChart.tsx': 1, // partial, 1 jsx
    'src/components/ui/FileDropzone.tsx': 2, // no-intl, 2 prop
    'src/components/ui/FrameworkBuilder.tsx': 3, // no-intl, 3 jsx
    'src/components/ui/FrameworkMinimap.tsx': 2, // no-intl, 1 jsx + 1 prop
    'src/components/ui/FreshnessBadge.tsx': 4, // no-intl, 4 prop
    'src/components/ui/GraphExplorer.tsx': 1, // no-intl, 1 jsx
    'src/components/ui/NextBestActionCard.tsx': 1, // no-intl, 1 jsx
    'src/components/ui/OnboardingTour.tsx': 1, // no-intl, 1 prop
    'src/components/ui/RichTextEditor.tsx': 1, // partial, 1 jsx
    'src/components/ui/SankeyChart.tsx': 3, // no-intl, 1 jsx + 2 prop
    'src/components/ui/TreeExpandCollapseToggle.tsx': 1, // no-intl, 1 prop
    'src/components/ui/TreeView.tsx': 1, // no-intl, 1 jsx
    'src/components/ui/TruncationBanner.tsx': 1, // no-intl, 1 jsx
    'src/components/ui/ai-assist-rail.tsx': 5, // no-intl, 2 jsx + 3 prop
    'src/components/ui/date-picker/date-picker.tsx': 2, // no-intl, 1 jsx + 1 prop
    'src/components/ui/date-picker/date-range-picker.tsx': 3, // no-intl, 1 jsx + 2 prop
    'src/components/ui/filter/filter-list.tsx': 3, // no-intl, 2 jsx + 1 prop
    'src/components/ui/filter/filter-select.tsx': 2, // no-intl, 1 jsx + 1 prop
    'src/components/ui/selection-summary-panel.tsx': 1, // no-intl, 1 jsx
    'src/components/ui/status-breakdown.tsx': 1, // no-intl, 1 jsx
    'src/components/ui/table-load-more-footer.tsx': 1, // no-intl, 1 jsx
};

// ─── The ratchet ────────────────────────────────────────────────

describe('i18n adoption ratchet — hardcoded UI strings only ever decrease', () => {
    const files = [
        ...walk(APP_DIR),
        ...walk(ORG_DIR),
        ...walk(COMPONENTS_DIR),
        ...walk(PKG_COMPONENTS_DIR),
    ];

    /** rel path -> every hardcoded string in it. Files with none are absent. */
    const live = new Map<string, { jsx: readonly string[]; props: readonly string[] }>();
    let usesIntlCount = 0;
    for (const abs of files) {
        const raw = fs.readFileSync(abs, 'utf-8');
        if (USES_INTL.test(raw)) usesIntlCount += 1;
        const found = collectHardcodedUiStrings(raw);
        if (found.total > 0) live.set(rel(abs), { jsx: found.jsx, props: found.props });
    }
    const countOf = (f: string): number => {
        const hit = live.get(f);
        return hit === undefined ? 0 : hit.jsx.length + hit.props.length;
    };

    it('the detector can still see the population it grades', () => {
        // Denominators beside the results. Every assertion below is a
        // comparison against a recorded number, and a detector that stopped
        // matching would report zero strings everywhere and pass all three —
        // which is exactly the failure mode #3265 describes one level up.
        expect(files.length).toBeGreaterThan(900);
        expect(usesIntlCount).toBeGreaterThan(300);
        expect(live.size).toBeGreaterThan(0);
        // And the detector must still find BOTH kinds, or half of it could rot
        // silently while the other half carried the count.
        expect([...live.values()].some((v) => v.jsx.length > 0)).toBe(true);
        expect([...live.values()].some((v) => v.props.length > 0)).toBe(true);
    });

    it('no file carries MORE hardcoded strings than its recorded budget', () => {
        const over = [...live.keys()]
            .filter((f) => countOf(f) > (STRING_BUDGET[f] ?? 0))
            .sort();
        if (over.length > 0) {
            const detail = over
                .map((f) => {
                    const hit = live.get(f)!;
                    const shown = [...hit.jsx, ...hit.props]
                        .slice(0, 4)
                        .map((x) => `        ${JSON.stringify(x.slice(0, 70))}`)
                        .join('\n');
                    return (
                        `  ${f}\n` +
                        `      ${countOf(f)} string(s), budget ${STRING_BUDGET[f] ?? 0}\n` +
                        shown
                    );
                })
                .join('\n');
            throw new Error(
                `${over.length} file(s) exceed their hardcoded-string budget:\n${detail}\n\n` +
                    `Wire the strings through next-intl:\n` +
                    `  • Server component / page:  const t = await getTranslations('<ns>')\n` +
                    `  • Client component:         const t = useTranslations('<ns>')\n` +
                    `then move the literals into messages/en.json + messages/bg.json ` +
                    `(the GAP-19 completeness guard requires both).\n\n` +
                    `ADOPTING next-intl IS NOT ENOUGH ANY MORE, and that is the point of ` +
                    `#3265: the unit is the STRING. A file that calls useTranslations once ` +
                    `and hardcodes ten strings scores ten. Raising a budget books permanent ` +
                    `English-only debt for a string a user will read.\n\n` +
                    `See docs/i18n.md.`,
            );
        }
    });

    it('no budget entry has unspent slack (drift sentinel)', () => {
        // Symmetric to every other ratchet here. A budget above the live count
        // is headroom a future regression spends with a green build — and in
        // this file that headroom is measured in strings a user would read.
        const slack = Object.keys(STRING_BUDGET)
            .filter((f) => countOf(f) < STRING_BUDGET[f])
            .map((f) => `  ${f}: budget ${STRING_BUDGET[f]}, live ${countOf(f)}`)
            .sort();
        if (slack.length > 0) {
            throw new Error(
                `${slack.length} STRING_BUDGET entr(y/ies) sit above the live count:\n` +
                    slack.join('\n') +
                    `\n\nLower each to its live count in the same PR that paid the ` +
                    `strings down. A file now at 0 should have its entry DELETED.`,
            );
        }
    });

    it('no stale entries — every budgeted file still exists and still has text', () => {
        const stale = Object.keys(STRING_BUDGET)
            .filter((f) => !live.has(f))
            .sort();
        if (stale.length > 0) {
            throw new Error(
                `${stale.length} STRING_BUDGET entr(y/ies) are stale — the file reached ` +
                    `zero hardcoded strings, was deleted, or LEFT THE SCANNED POPULATION ` +
                    `(moved into a directory this ratchet does not walk — #3213):\n` +
                    stale.map((f) => `  ${f}`).join('\n') +
                    `\n\nDelete them from STRING_BUDGET in this PR. The ratchet only ` +
                    `moves down — paid-off debt must leave the list.`,
            );
        }
    });
});
