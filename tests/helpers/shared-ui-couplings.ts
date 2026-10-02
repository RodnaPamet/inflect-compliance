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

export const SHARED_UI_ROOTS = [
    'src/components/ui',
    'src/components/layout',
    'src/components/app-shell',
    'src/lib/hooks',
] as const;

export type CouplingKind = 'storage-key' | 'brand-as-text' | 'domain-import';

/**
 * `@/lib/<name>` a shared file may import without being coupled. Deliberately
 * an ALLOWLIST of the neutral few rather than a denylist of domains: the domain
 * set grows, and a denylist that misses a new one reports clean. The first
 * draft of this was a denylist and it missed `@/lib/evidence-upload-limits`
 * and `@/lib/framework-tree`.
 */
const NEUTRAL_LIB = new Set([
    'cn', 'ui-storage', 'hooks', 'utils', 'format', 'dates', 'a11y', 'design',
    'theme-constants',
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
