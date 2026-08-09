/**
 * Client components format money through the tenant's formatter.
 *
 * `src/lib/tenant-context-provider.tsx` states the rule in a comment:
 *
 *   > One symbol per tenant, one formatter per product. Components call
 *   > `useMoneyFormatter()` instead of importing formatCompactCurrency
 *   > with a hardcoded symbol — the hook closes over the tenant's
 *   > configured currencySymbol (default €).
 *
 * Nothing enforced it, so it drifted. Nine risk files obeyed and two did
 * not: `RisksClient.tsx` and `risks/[riskId]/page.tsx` imported
 * `formatCompactCurrency` directly, whose symbol parameter defaults to €.
 * A tenant configured for '$' therefore saw dollars on the risk dashboard
 * (which uses the hook) and euros on the register and the risk header —
 * the same figure in two currencies, one click apart. Nothing looked
 * broken; the numbers were right and the symbol was a lie.
 *
 * WHY A SOURCE SCAN IS THE RIGHT TOOL HERE. This is a "no code path may do
 * X" claim over a whole directory. A rendered test can only show that the
 * components it mounts behave; it cannot show that the next one added will.
 * See CLAUDE.md → "Epic-ratchet lifecycle" for when to prefer behaviour.
 *
 * SERVER code is exempt: there is no React context to read, so a server
 * renderer must be passed the symbol explicitly. The rule is about
 * components that COULD call the hook.
 *
 * ALLOWED lists the presentational primitives that legitimately take the
 * formatter as a PROP and re-export a default. They never bind a tenant
 * symbol themselves — their callers pass `money`. Shrink this list; do not
 * grow it without the same justification a new exemption would need.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/app/t', 'src/app/org'];

/**
 * Files that may import `formatCompactCurrency` directly, each with the
 * reason it cannot use the hook.
 */
const ALLOWED: Record<string, string> = {
    'src/components/risks/RiskMatrixCell.tsx':
        'presentational primitive — takes the formatter via props from its matrix parent',
    'src/components/ui/charts/loss-exceedance-curve.tsx':
        'chart primitive — axis tick formatter supplied by the calling page',
    'src/components/ui/charts/ale-histogram.tsx':
        'chart primitive — axis tick formatter supplied by the calling page',
};

function walk(dir: string): string[] {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const out: string[] = [];
    const rec = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) rec(full);
            else if (/\.(tsx|ts)$/.test(e.name)) out.push(full);
        }
    };
    rec(abs);
    return out;
}

/**
 * A client component — the only kind that can call a React hook chain.
 *
 * The directive must be the first STATEMENT, but comments may precede it,
 * and several files open with a long docblock (ControlRoiCard's sits at
 * line 16). An early-lines heuristic silently under-detects those, so strip
 * leading comments and whitespace first and test what actually comes first.
 */
function isClientComponent(src: string): boolean {
    const head = src
        .replace(/^\uFEFF/, '')
        .replace(/^(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*)*/, '');
    return /^['"]use client['"]/.test(head.trimStart());
}

describe('tenant money formatter', () => {
    it('no client page imports formatCompactCurrency directly', () => {
        const offenders: string[] = [];

        for (const dir of SCAN_DIRS) {
            for (const abs of walk(dir)) {
                const rel = path.relative(ROOT, abs).split(path.sep).join('/');
                if (rel in ALLOWED) continue;
                const src = fs.readFileSync(abs, 'utf8');
                if (!isClientComponent(src)) continue; // server: symbol passed explicitly
                if (/import\s*\{[^}]*\bformatCompactCurrency\b[^}]*\}\s*from/.test(src)) {
                    offenders.push(rel);
                }
            }
        }

        expect({
            offenders: offenders.sort(),
            hint:
                offenders.length === 0
                    ? 'none'
                    : 'Call `useMoneyFormatter()` from @/lib/tenant-context-provider instead. ' +
                      'Importing formatCompactCurrency directly defaults the symbol to €, so a ' +
                      'tenant on another currency sees two symbols on adjacent screens.',
        }).toEqual({ offenders: [], hint: 'none' });
    });

    it('the hook is the only place that resolves the tenant symbol', () => {
        // A second `currencySymbol ?? '€'` fallback anywhere in the app tree
        // is a fork of the default: change the provider's and they disagree.
        const forks: string[] = [];
        for (const dir of SCAN_DIRS) {
            for (const abs of walk(dir)) {
                const src = fs.readFileSync(abs, 'utf8');
                if (/currencySymbol\s*\?\?\s*['"]€['"]/.test(src)) {
                    forks.push(path.relative(ROOT, abs).split(path.sep).join('/'));
                }
            }
        }
        expect(forks.sort()).toEqual([]);
    });

    it('every allowlisted primitive still exists', () => {
        const stale = Object.keys(ALLOWED).filter((f) => !fs.existsSync(path.join(ROOT, f)));
        expect(stale).toEqual([]);
    });
});
