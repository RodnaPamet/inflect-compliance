/**
 * Perf-instrumentation coverage ratchet.
 *
 * Locks in the measurement surfaces this PR adds — the slow-query log,
 * the bundle analyzer, and the baseline directory — so a later refactor
 * can't silently remove the instrumentation later perf phases depend on.
 *
 * NOTE: Real-user monitoring (Web Vitals) already exists on main —
 * `src/lib/observability/web-vitals.ts` + `src/app/api/telemetry/vitals/route.ts`
 * + `<WebVitalsReporter>` (mounted in ClientProviders, via `next/web-vitals`).
 * This PR deliberately does NOT add a second RUM path; it asserts the
 * existing one is present so the surface stays covered.
 *
 * See docs/implementation-notes/2026-06-26-perf-baseline.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// SOURCE reads are comment-masked at the seam, so a commented-out `$on('query')`
// or instrument name cannot satisfy an assertion about live wiring. package.json
// is JSON and stays raw so it still parses.
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|prisma)$/;
const read = (rel: string) => {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return CODE_FILE.test(rel) ? codeOf(raw) : raw;
};
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

describe('perf instrumentation coverage', () => {
    describe('RUM (existing surface — not duplicated)', () => {
        it('the web-vitals RUM client + sink exist', () => {
            expect(exists('src/lib/observability/web-vitals.ts')).toBe(true);
            expect(exists('src/app/api/telemetry/vitals/route.ts')).toBe(true);
            expect(exists('src/components/observability/WebVitalsReporter.tsx')).toBe(true);
        });
    });

    describe('slow-query log', () => {
        it('prisma.ts enables query events and listens for them', () => {
            const prisma = read('src/lib/prisma.ts');
            expect(prisma).toMatch(/level:\s*'query'\s*,\s*emit:\s*'event'/);
            expect(prisma).toMatch(/\$on\(\s*'query'/);
        });

        it('metrics.ts declares the db.slow_query.count instrument', () => {
            expect(read('src/lib/observability/metrics.ts')).toContain('db.slow_query.count');
        });
    });

    describe('bundle analyzer', () => {
        it('next.config.js wraps in withBundleAnalyzer', () => {
            const cfg = read('next.config.js');
            expect(cfg).toMatch(/@next\/bundle-analyzer/);
            expect(cfg).toMatch(/withBundleAnalyzer\(/);
        });

        it('package.json has an analyze script + the dev dependency', () => {
            const pkg = JSON.parse(read('package.json')) as {
                scripts: Record<string, string>;
                devDependencies: Record<string, string>;
            };
            expect(pkg.scripts.analyze).toMatch(/ANALYZE=true/);
            expect(pkg.devDependencies['@next/bundle-analyzer']).toBeDefined();
        });

        it('a bundle-analyze CI workflow exists', () => {
            expect(exists('.github/workflows/bundle-analyze.yml')).toBe(true);
        });
    });

    describe('baseline', () => {
        it('docs/perf/ directory exists', () => {
            expect(exists('docs/perf')).toBe(true);
            expect(fs.statSync(path.join(ROOT, 'docs/perf')).isDirectory()).toBe(true);
        });
    });
});
