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
 *   • `UNMIGRATED_BASELINE` is the frozen set of files that hardcode
 *     text today. It is grandfathered debt — the i18n migration is
 *     retiring it surface-by-surface (vendors, assets, …).
 *     Membership only moves DOWN.
 *   • FORWARD: a text-bearing file that neither uses next-intl NOR
 *     sits in the baseline FAILS. That is a new un-localised surface
 *     — wire `useTranslations` / `getTranslations` before it ships.
 *   • NO-STALE: every baseline entry must still exist AND still be
 *     un-migrated-with-text. Migrate a file (adopt next-intl) or
 *     delete it ⇒ remove it from the baseline in the SAME diff. The
 *     list can only shrink, so the debt is visible and monotonic.
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
 * (`hasJsxTextBetweenTags`), where that cannot happen. When the switch
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
function hasJsxTextBetweenTags(raw: string): boolean {
    const sf = ts.createSourceFile(
        'scan.tsx',
        raw,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.TSX,
    );
    let found = false;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (
            ts.isJsxText(node) &&
            JSX_WORD.test(node.text) &&
            raw[node.getFullStart() - 1] === '>' &&
            raw[node.getEnd()] === '<'
        ) {
            found = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
}

// UI-text-bearing props / object keys whose value is a STRING LITERAL
// containing a >=2-char lowercase run (skips acronyms like 'ISO',
// 'NIS2'). The ["'] immediately after =/: is load-bearing: the
// migrated {t('key')} form is in braces, so it can never match here.
const UI_PROP =
    /\b(?:title|placeholder|label|description|aria-label|searchPlaceholder|confirmLabel|heading|subtitle|emptyTitle|emptyDescription|tooltip|header|confirmText|cancelText|actionLabel)\s*[=:]\s*["'][^"'\n]*[a-z]{2,}[^"'\n]*["']/;

/** Heuristic: does this source render hardcoded, user-facing text? */
export function hasHardcodedUiText(raw: string): boolean {
    return (
        hasJsxTextBetweenTags(raw) ||
        UI_PROP.test(stripTypeAnnotations(stripComments(raw)))
    );
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
// Files that hardcode user-facing text and do NOT use next-intl.
// This list ONLY shrinks. When you localise a file, remove it here
// in the same PR (the no-stale test enforces this).
//
// The tenant app tree (`src/app/t/.../(app)`) and the org portal
// (`src/app/org`) are FULLY migrated — nothing from them is
// grandfathered. The entries below are all `src/components/**`
// primitives that the 2026-07 component-tree wave did not reach
// (charts, low-level UI, layout shells like ListPageShell). Being
// imported by server components is no reason to stay here:
// `useTranslations` also runs in a non-async Server Component, which
// is how `skeleton.tsx` (rendered by server `loading.tsx` files) left.
// Each is paid down by localising the file and deleting its line here.
const UNMIGRATED_BASELINE: ReadonlySet<string> = new Set<string>([
    'src/components/dev/swr-devtools.tsx',
    'src/components/layout/ListPageShell.tsx',
    'src/components/layout/org-workspace-switcher.tsx',
    'src/components/layout/tenant-switcher.tsx',
    'src/components/onboarding/Nis2SelfAssessmentStep.tsx',
    'src/components/ui/ComplianceStatusIndicator.tsx',
    'src/components/ui/FileDropzone.tsx',
    'src/components/ui/FrameworkBuilder.tsx',
    'src/components/ui/FrameworkMinimap.tsx',
    'src/components/ui/FreshnessBadge.tsx',
    'src/components/ui/GraphExplorer.tsx',
    'src/components/ui/NextBestActionCard.tsx',
    'src/components/ui/OnboardingTour.tsx',
    'src/components/ui/SankeyChart.tsx',
    'src/components/ui/TreeExpandCollapseToggle.tsx',
    'src/components/ui/TreeView.tsx',
    'src/components/ui/TruncationBanner.tsx',
    'src/components/ui/ai-assist-rail.tsx',
    'src/components/ui/date-picker/date-picker.tsx',
    'src/components/ui/date-picker/date-range-picker.tsx',
    'src/components/ui/filter/filter-list.tsx',
    'src/components/ui/filter/filter-select.tsx',
    'src/components/ui/selection-summary-panel.tsx',
    // Moved into the package by #3212, which deleted its `src/` entry as stale
    // (correct bookkeeping: the file was gone from `src/`). What that erased was
    // the only trace the debt existed -- the text was never localised, it just
    // left the population. Re-keyed here now the package is scanned. #3213
    'packages/ui/src/components/ui/charts/time-series-chart.tsx',
    'src/components/ui/status-breakdown.tsx',
    'src/components/ui/table-load-more-footer.tsx',
]);

// ─── The ratchet ────────────────────────────────────────────────

describe('i18n adoption ratchet — new UI goes through next-intl', () => {
    const files = [
        ...walk(APP_DIR),
        ...walk(ORG_DIR),
        ...walk(COMPONENTS_DIR),
        ...walk(PKG_COMPONENTS_DIR),
    ];

    const textBearingWithoutIntl = files
        .filter((f) => {
            const raw = fs.readFileSync(f, 'utf-8');
            return hasHardcodedUiText(raw) && !USES_INTL.test(raw);
        })
        .map(rel)
        .sort();

    it('has no NEW un-localised surface (text-bearing + no next-intl + not grandfathered)', () => {
        const offenders = textBearingWithoutIntl.filter((f) => !UNMIGRATED_BASELINE.has(f));
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} file(s) render hardcoded UI text without next-intl:\n` +
                    offenders.map((f) => `  ${f}`).join('\n') +
                    `\n\nWire the strings through next-intl:\n` +
                    `  • Server component / page:  const t = await getTranslations('<ns>')\n` +
                    `  • Client component:         const t = useTranslations('<ns>')\n` +
                    `then move the literals into messages/en.json + messages/bg.json ` +
                    `(the GAP-19 completeness guard requires both).\n\n` +
                    `See docs/i18n.md. Adding the file to UNMIGRATED_BASELINE is possible ` +
                    `but discouraged — it books permanent English-only debt for a brand-new surface.`,
            );
        }
    });

    it('has no stale baseline entries (every grandfathered file still exists + is still un-migrated)', () => {
        const current = new Set(textBearingWithoutIntl);
        const stale = [...UNMIGRATED_BASELINE].filter((f) => !current.has(f)).sort();
        if (stale.length > 0) {
            throw new Error(
                `${stale.length} UNMIGRATED_BASELINE entr(y/ies) are stale — the file was ` +
                    `migrated to next-intl, lost its hardcoded text, was deleted, or ` +
                    `LEFT THE SCANNED POPULATION (moved into a directory this ratchet ` +
                    `does not walk — #3213):\n` +
                    stale.map((f) => `  ${f}`).join('\n') +
                    `\n\nRemove them from UNMIGRATED_BASELINE in this PR. The ratchet only ` +
                    `moves down — grandfathered debt must be deleted as it is paid off.`,
            );
        }
    });
});

// ─── Self-test: prove the detector actually fires ───────────────
//
// Guards the heuristic itself. A future refactor that broke
// hasHardcodedUiText would otherwise let every un-migrated file slip
// through with this suite still green.
describe('i18n adoption ratchet — detector self-test', () => {
    it('flags a JSX text node with a real word', () => {
        expect(hasHardcodedUiText('<h1>Dashboard overview</h1>')).toBe(true);
    });

    it('flags a text node that spans lines between two tags', () => {
        expect(
            hasHardcodedUiText('const x = (\n  <p>\n    Nothing to show yet\n  </p>\n);'),
        ).toBe(true);
    });

    it('does NOT flag the TypeScript syntax the `>…<` regex read as text', () => {
        // The three shapes that kept 39 text-free files in the baseline;
        // each of these returned true before JSX text came from the AST.
        // Two generic bases in an `extends` clause: `>,\n  VariantProps<`.
        expect(
            hasHardcodedUiText(
                'export interface ButtonProps\n' +
                    '    extends React.ButtonHTMLAttributes<HTMLButtonElement>,\n' +
                    '        VariantProps<typeof buttonVariants> {}\n' +
                    'export const B = () => <button />;',
            ),
        ).toBe(false);
        // An arrow's `=>`, then code, then the next JSX `<`.
        expect(
            hasHardcodedUiText(
                'function S() {\n' +
                    '  const open = useCallback(() => setDrawerOpen(true), []);\n' +
                    '  return (<div onClick={open} />);\n}',
            ),
        ).toBe(false);
        // Code between one element's closing `>` and the next element's `<`.
        expect(
            hasHardcodedUiText(
                'function C() {\n' +
                    '  const label = <span />;\n' +
                    '  const interactive = Boolean(onClick) && !isEmpty;\n' +
                    '  return <div>{label}</div>;\n}',
            ),
        ).toBe(false);
    });

    it('flags a hardcoded UI-text prop literal', () => {
        expect(hasHardcodedUiText('<Input placeholder="Search assets" />')).toBe(true);
        expect(hasHardcodedUiText("const col = { header: 'Criticality' };")).toBe(true);
    });

    it('does NOT flag the next-intl {t(...)} form', () => {
        expect(hasHardcodedUiText("<h1>{t('dashboard.title')}</h1>")).toBe(false);
        expect(hasHardcodedUiText("<Input placeholder={t('search')} />")).toBe(false);
    });

    it('does NOT flag acronym-only / proper-noun literals', () => {
        expect(hasHardcodedUiText('<span>ISO27001</span>')).toBe(false);
        expect(hasHardcodedUiText("{ label: 'NIS2' }")).toBe(false);
    });

    it('does NOT flag prose inside comments', () => {
        expect(hasHardcodedUiText('// This renders the Dashboard heading for users')).toBe(false);
        expect(hasHardcodedUiText('/* Shows a friendly Welcome message here */')).toBe(false);
    });

    it('does NOT flag non-UI attributes (className / href / id)', () => {
        expect(hasHardcodedUiText('<div className="flex items-center" id="asset-row" />')).toBe(false);
    });

    it('does NOT flag TS generic annotations / casts adjacent to JSX', () => {
        // A server page's async-params signature whose `Promise<{…}>`
        // closing `>` precedes the `return (<Client>` — the code
        // between must not read as a JSX text node.
        const page =
            'export default async function P({ params }: { params: Promise<{ tenantSlug: string }> }) {\n' +
            '  const rows = (await load()) as unknown as Promise<Row[]>;\n' +
            '  return (<Client rows={rows} />);\n}';
        expect(hasHardcodedUiText(page)).toBe(false);
    });
});
