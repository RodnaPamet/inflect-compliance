/**
 * RQ3-OB-A — one-voice ratchet.
 *
 * The product spoke two currencies on the same page ($ tiles beside
 * € rows) because eight files each declared a local `money()` with a
 * hardcoded symbol. Regression classes guarded:
 *
 *   - a hardcoded currency template literal reappearing anywhere in
 *     src/ outside the canonical formatter;
 *   - a local `const money =` formatter declaration reappearing
 *     (the canonical path is `useMoneyFormatter()` client-side or
 *     `formatCompactCurrency(v, sym)` server-side);
 *   - raw ISO date slices in user-facing text (one date voice:
 *     formatDate);
 *   - inline pluralization ternaries drifting back where the shared
 *     helper exists.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A — comments are masked at the READ SEAM, so an assertion cannot
// be satisfied by a comment instead of the code it names. Every read below is
// TypeScript/TSX, re-derived in this file rather than assumed from the paths.
import { codeOf } from '../helpers/source-blocks';

const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));

/**
 * `execFileSync` (not `execSync`) — argv array bypasses the shell so
 * the patterns + scan-root path can never be interpreted as shell
 * tokens. -F is fixed-string so the patterns themselves remain
 * inert. CodeQL's `js/shell-command-injection-from-environment` rule
 * fires on string-built shell commands; argv-form is the canonical
 * fix.
 */
function grepSrc(pattern: string): string[] {
    let stdout: string;
    try {
        stdout = execFileSync(
            'grep',
            ['-rlnF', '-e', pattern, path.join(ROOT, 'src'), '--include=*.ts', '--include=*.tsx'],
            { encoding: 'utf-8' },
        );
    } catch (e) {
        // grep exits 1 when no matches — `as` cast for the error
        // shape; treat as no findings.
        const err = e as { status: number; stdout?: string };
        if (err.status === 1) stdout = err.stdout ?? '';
        else throw e;
    }
    return stdout.split('\n').filter(Boolean).map((p) => path.relative(ROOT, p)).sort();
}

describe('RQ3-OB-A — one voice', () => {
    test('no hardcoded currency template literal outside the canonical formatter', () => {
        const dollar = grepSrc('`$${').filter((p) => p !== 'src/lib/risk-coherence.ts');
        const euro = grepSrc('`€${').filter((p) => p !== 'src/lib/risk-coherence.ts');
        expect([...dollar, ...euro]).toEqual([]);
    });

    test('no local money-formatter declarations (useMoneyFormatter is the seam)', () => {
        let out: string;
        try {
            out = execFileSync(
                'grep',
                ['-rnF', '-e', 'const money = (n', path.join(ROOT, 'src'), '--include=*.ts', '--include=*.tsx'],
                { encoding: 'utf-8' },
            ).trim();
        } catch (e) {
            const err = e as { status: number; stdout?: string };
            if (err.status === 1) out = '';
            else throw e;
        }
        expect(out).toBe('');
    });

    test('the tenant currency flows: schema field → server record → context → hook', () => {
        expect(read('prisma/schema/auth.prisma')).toMatch(/currencySymbol\s+String\s+@default\("€"\)/);
        expect(read('src/lib/server/tenant-context.server.ts')).toMatch(/currencySymbol: true/);
        expect(read('src/lib/tenant-context-provider.tsx')).toMatch(/export function useMoneyFormatter/);
        expect(read('src/app/t/[tenantSlug]/layout.tsx')).toMatch(/currencySymbol: serverCtx\.tenant\.currencySymbol/);
    });

    test('one date voice — no raw ISO slices in user-facing strings', () => {
        expect(read('src/app-layer/usecases/risk-appetite.ts')).not.toMatch(/toISOString\(\)\.slice/);
        expect(read('src/app-layer/usecases/risk-appetite.ts')).toMatch(/formatDate\(breach\.detectedAt\)/);
    });

    test('grammar — staleness uses the shared pluralizer (no "1 days ago")', () => {
        expect(read('src/lib/risk-staleness.ts')).toMatch(/countNoun\(/);
        expect(read('src/lib/risk-staleness.ts')).not.toMatch(/\$\{verdict\.assessmentAgeDays\} days/);
    });
});
