/**
 * The three MECHANICAL shared-UI couplings, in one implementation.
 *
 * #3047 records a classification per file; #3048 ratchets the totals down.
 * Both need the same derivation, and a detector copied into two guards is two
 * detectors that drift — so it lives here, the way `ratchet-slack.ts` does for
 * the sentinel several ratchets share.
 *
 * Only the greppable three are here. Hardcoded copy and domain vocabulary need
 * a reader (is `controls` the GRC noun or a widget prop?) and stay as recorded
 * judgement in the classification map.
 *
 * READ THROUGH `codeOf`. Comments are masked at the seam, because the naive
 * version flagged `use-local-storage.ts` — the storage primitive itself —
 * whose docstring contains the example `useLocalStorage('k', {})`. A detector
 * that reads prose as code reports the seam built to contain a pattern as a
 * breach of it. String literals are KEPT: a Tailwind class and a storage key
 * both live in one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf } from './source-blocks';

/**
 * The four shared-UI roots as they are addressed inside the application.
 */
const APP_ROOTS = [
    'src/components/ui',
    'src/components/layout',
    'src/components/app-shell',
    'src/lib/hooks',
] as const;

/**
 * Where #3046 is moving those four. `packages/ui/src/components/ui` is the
 * destination of `src/components/ui`, and so on for all four — §1 of
 * `docs/shared-ui-package-design.md` mirrors the source layout under the
 * package precisely so a move reads as a rename.
 *
 * ─── Why the package half is DERIVED and not typed out again ──────────
 *
 * Two guards carry a >600 floor on this population
 * (`ui-core-classification.test.ts` and `shared-ui-coupling-ratchet.test.ts`),
 * though only ONE of them can fire on a shrink: in the classification guard the
 * `toBeGreaterThan(600)` sits immediately after
 * `expect({missing, stale}).toEqual(...)` in the same `it`, so a root removal
 * fails on 569 stale map entries and the floor line never executes. Stricter,
 * not weaker — but the count of independent floor detectors is one, measured by
 * removing a root and reading which assertion reddened in each guard. The live
 * count is 613, and the margin is therefore 13 files. The floor exists to catch a denominator that
 * shrinks while the assertion stays green, which is exactly what a file move
 * out of these roots would do — so §5.1 requires the roots to learn the
 * destination BEFORE anything moves, in its own commit, verified by the count
 * being UNCHANGED.
 *
 * "Unchanged" is the whole verification, and it is also the problem: these four
 * destinations do not exist yet, `walk()` returns `[]` for a path that does not
 * exist, and so a root MISSPELLED here is INERT — it reads 613 too. A typo
 * would be discovered at step 2, by the move it was added to protect, as a
 * population that fell by the size of the batch. Deriving the package half from
 * the app half makes that class of typo unrepresentable rather than merely
 * documented: there is one spelling of each root in this file, not two.
 *
 * The derivation is not a substitute for proving the new roots are LIVE. That
 * was a positive control, run once when this landed: a `.ts` file planted under
 * `packages/ui/src/components/ui/` took the population to 614, and removing it
 * returned it to 613. Nothing in a green run can distinguish a correct new root
 * from a dead one while the destinations are empty, so the proof had to be a
 * planted file.
 */
const PACKAGE_PREFIX = 'packages/ui/';

export const SHARED_UI_ROOTS: readonly string[] = [
    ...APP_ROOTS,
    ...APP_ROOTS.map((root) => `${PACKAGE_PREFIX}${root}`),
];

export type CouplingKind = 'storage-key' | 'brand-as-text' | 'domain-import';

/**
 * `@/lib/<name>` a shared file may import without being coupled. Deliberately
 * an ALLOWLIST of the neutral few rather than a denylist of domains: the domain
 * set grows, and a denylist that misses a new one reports clean. The first
 * draft of this was a denylist and it missed `@/lib/evidence-upload-limits`
 * and `@/lib/framework-tree`.
 *
 * ─── Widened by four, and the rule did not soften ────────────────────
 *
 * `format-date`, `kpi-trend`, `number-format` and `locale-constants` are the
 * same KIND as `cn`: leaf utilities — date formatting, trend arithmetic, number
 * formatting, the locale table — that carry no product vocabulary. Each was
 * MEASURED, not assumed: all four have ZERO `@/` imports of their own, so none
 * can pull a domain module in behind its allowance.
 *
 * The docstring's argument against allowlists still stands for a new DOMAIN
 * module. The list grew because four names were measured neutral, not because
 * the bar moved; `@/lib/framework-tree` and `@/lib/evidence-upload-limits` are
 * exactly as coupled as they were.
 *
 * ─── Four entries were DELETED, and they were worse than unused ──────
 *
 * `utils`, `format`, `dates` and `a11y` named modules that DO NOT EXIST as a
 * file or a directory under `src/lib`, and no file in the repo imports any of
 * them. They were names for nothing. That matters beyond the entry count: the
 * first argument for adding `format-date` was "the same kind as the
 * `cn`/`dates`/`format`/`a11y` entries already there", which is an argument
 * from entries that are not real. Deleting them stops the next reader
 * inheriting it.
 *
 * `theme-constants` is KEPT, and is a different case. The module exists
 * (`src/lib/theme-constants.ts`) and has four importers, none of them inside
 * `SHARED_UI_ROOTS` — so the allowance is dormant, not false. An unused
 * allowance for a real module is a judgement waiting to be used; a name for
 * nothing is a judgement nobody ever made.
 *
 * ─── Widened by two more, and the AUDIT had already said so ──────────
 *
 * #3046 batch 4 adds `resize-image` and `text-utils`. The measurement is the
 * same one batch 2 ran, with the same two numbers: both resolve, and both have
 * ZERO import statements OF ANY KIND — not merely zero `@/` imports, so neither
 * can pull anything in behind its allowance. (The counting pattern was run as a
 * discriminating pair, not just on the candidates: `cn.ts` 2, `format-date.ts`
 * 1, `resize-image.ts` 0, `text-utils.ts` 0. A pattern that matched nothing
 * would have reported both candidates as leaves too.)
 *
 * What makes these two different from a judgement call is that the #3047 audit
 * had ALREADY ruled on them, in the opposite direction to the detector:
 *
 *   `filter/filter-list.tsx` — the only importer of `@/lib/text-utils` — is
 *     recorded "No brand-as-text, no storage key, **no domain import**, no
 *     domain vocabulary … the only MIXED file here whose coupling is copy
 *     alone". The detector was counting a `domain-import` on a file whose
 *     recorded finding says there is none.
 *   `file-upload.tsx` — the only importer of `@/lib/resize-image` — is
 *     recorded as coupled by "an `evidence` preset in its prop union, a Dub
 *     brand reference, and five untranslated error sentences". The import is
 *     not among its findings either.
 *
 * So this is the detector being brought into line with a reading a human
 * already did, not the bar moving. Both modules are first-party replacements
 * for the `Dub utils` shim (their own docstrings say so) — a canvas
 * cover-fit/centre-crop resizer and `truncate`/`truncateGlyph`/`pluralize`.
 * Replacing the brand's utility shim is the WHOLE POINT of #3046, so a shared
 * component importing one of those replacements is the decoupled state, not a
 * residual coupling.
 *
 * NOT added, and measured rather than assumed: `@/components/theme`, which
 * `layout/user-menu.tsx` imports for `ThemeToggle`. It is tempting because
 * `src/components/theme/ThemeProvider.tsx` is one of the four non-root files
 * `docs/shared-ui-package-design.md` admits alongside the package — but the
 * directory holds TWO files and the admitted list holds one. Carving out the
 * namespace would assert `ThemeToggle` neutral, which no pass has looked at;
 * the design doc reserves it for step 4. Narrower than `SHARED_COMPONENT_DIRS`
 * allows, so it stays coupled.
 */
export const NEUTRAL_LIB = new Set([
    'cn', 'ui-storage', 'hooks', 'design', 'theme-constants',
    'format-date', 'kpi-trend', 'number-format', 'locale-constants',
    'resize-image', 'text-utils',
]);

const RAW_STORAGE_HOOK = /use(?:Local|Session)Storage(?:<[^>]*>)?\(\s*[`'"]/;
const SEAM = /uiStorageKey|uiCookieName/;
/**
 * A brand FILL token used as TEXT. `--brand-default` is 4.03:1, under WCAG
 * 1.4.3's 4.5:1 for text; `text-content-brand` is the AA-safe replacement.
 * Border, background and fill are deliberately NOT matched — non-text owes
 * 1.4.11's 3:1, which 4.03:1 already clears.
 */
const BRAND_AS_TEXT = /text-brand-[\w-]+|text-\[var\(--brand-[\w-]+\)\]/;
/**
 * The shared-component namespaces a file in the roots may import from. There is
 * no allowlist beyond the roots themselves, and that asymmetry with
 * `NEUTRAL_LIB` is the point: `@/lib` holds genuinely neutral utilities every
 * shared file needs, whereas an `@/components/<x>` outside these three is by
 * construction a component NOBODY AUDITED — the classification map covers only
 * `SHARED_UI_ROOTS`, so such a target has no entry at all. Carving out
 * `theme` or `icons` here would be asserting they are neutral when no pass has
 * ever looked at them.
 */
const SHARED_COMPONENT_DIRS = new Set(['ui', 'layout', 'app-shell']);

/**
 * `@/app-layer/...`, `@/lib/<domain>` and `@/components/<non-shared>`.
 *
 * The `components` arm was MISSING until #3098, and the gap was silent: a file
 * could reach the rest of the product through `@/components/` and still be
 * recorded GENERIC — the precise claim a vendoring consumer relies on. One file
 * was doing exactly that (`layout/ClientProviders.tsx`, reclassified with this
 * change), and seven more tripped it on top of couplings they already had.
 */
const IMPORT = /from\s+['"]@\/(app-layer|lib|components)\/([\w.-]+)/g;

export function sharedUiPopulation(repoRoot: string): string[] {
    const walk = (rel: string): string[] => {
        const abs = path.join(repoRoot, rel);
        if (!fs.existsSync(abs)) return [];
        return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory()
                ? walk(`${rel}/${e.name}`)
                : /\.(ts|tsx)$/.test(e.name)
                  ? [`${rel}/${e.name}`]
                  : [],
        );
    };
    return SHARED_UI_ROOTS.flatMap(walk).sort();
}

export function mechanicalCouplings(repoRoot: string, rel: string): CouplingKind[] {
    const code = codeOf(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
    const found: CouplingKind[] = [];
    if (RAW_STORAGE_HOOK.test(code) && !SEAM.test(code)) found.push('storage-key');
    if (BRAND_AS_TEXT.test(code)) found.push('brand-as-text');
    for (const m of code.matchAll(IMPORT)) {
        const [, scope, name] = m;
        const coupled =
            scope === 'app-layer' ||
            (scope === 'lib' && !NEUTRAL_LIB.has(name)) ||
            (scope === 'components' && !SHARED_COMPONENT_DIRS.has(name));
        if (coupled) {
            found.push('domain-import');
            break;
        }
    }
    return found;
}

/** path -> kinds, for every file that trips at least one. */
export function couplingIndex(repoRoot: string): Map<string, CouplingKind[]> {
    const out = new Map<string, CouplingKind[]>();
    for (const f of sharedUiPopulation(repoRoot)) {
        const k = mechanicalCouplings(repoRoot, f);
        if (k.length) out.set(f, k);
    }
    return out;
}
