/**
 * The mobile audit enumerates every page of the app from the file system
 * (`scripts/mobile-audit/routes.ts`) and compares two reports
 * (`report.ts`). A route the enumeration missed would never be measured, and
 * a comparison that ignored a lost route would let a page that stopped
 * rendering lower a count.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { audienceOf, enumerateRoutes, fillPattern, paramsOf, patternOfPageFile, routeSlug } from '../../scripts/mobile-audit/routes';
import { RESOLVERS } from '../../scripts/mobile-audit/resolve';
import { compareReports, headline, newlyFailing, renderComparison, type AuditReport, type CapturedPage } from '../../scripts/mobile-audit/report';
import { MOBILE_METRICS, type MetricCounts } from '../../scripts/mobile-audit/measure';

const ROOT = path.resolve(__dirname, '..', '..');

describe('route enumeration', () => {
    it('drops route groups, keeps dynamic segments, skips private folders', () => {
        expect(patternOfPageFile('t/[tenantSlug]/(app)/risks/[riskId]/page.tsx')).toBe('/t/[tenantSlug]/risks/[riskId]');
        expect(patternOfPageFile('t/[tenantSlug]/(app)/vendors/_form/page.tsx')).toBeNull();
        expect(patternOfPageFile('t/[tenantSlug]/(app)/risks/RisksClient.tsx')).toBeNull();
        expect(paramsOf('/t/[tenantSlug]/controls/[controlId]/tests/[planId]')).toEqual(['tenantSlug', 'controlId', 'planId']);
    });

    it('classifies who views a route', () => {
        expect(audienceOf('/t/[tenantSlug]/risks')).toBe('tenant');
        expect(audienceOf('/org/[orgSlug]')).toBe('org');
        expect(audienceOf('/account/security')).toBe('session');
        expect(audienceOf('/login')).toBe('anonymous');
    });

    it('fills a pattern, and refuses one with a missing value', () => {
        expect(fillPattern('/t/[tenantSlug]/risks/[riskId]', { tenantSlug: 'acme', riskId: 'r 1' })).toBe('/t/acme/risks/r%201');
        expect(fillPattern('/t/[tenantSlug]/risks/[riskId]', { tenantSlug: 'acme' })).toBeNull();
        expect(routeSlug('/t/[tenantSlug]/risks')).toBe('t_tenantSlug_risks');
    });

    it('finds every page.tsx git tracks under src/app', () => {
        const tracked = execSync('git ls-files -- "src/app/**/page.tsx" "src/app/page.tsx"', { cwd: ROOT, encoding: 'utf8' })
            .split('\n')
            .filter((f) => f && !/\/_[^/]+\//.test(f));
        const found = new Set(enumerateRoutes(ROOT).map((r) => r.file));
        expect(tracked.filter((f) => !found.has(f))).toEqual([]);
    });

    it('has a resolver for every dynamic route, or the audit would report it as uncaptured', () => {
        const dynamic = enumerateRoutes(ROOT).filter((r) => r.params.some((p) => p !== 'tenantSlug' && p !== 'orgSlug'));
        expect(dynamic.map((r) => r.pattern).filter((p) => !(p in RESOLVERS))).toEqual([]);
    });
});

describe('compareReports', () => {
    const zero = Object.fromEntries(MOBILE_METRICS.map((m) => [m.id, 0])) as MetricCounts;
    const page = (id: string, counts: Partial<MetricCounts>): CapturedPage => ({
        kind: 'route', id, config: '390-dark-bg', url: id, finalUrl: id, status: 200,
        counts: { ...zero, ...counts }, samples: {}, leaks: [], consoleErrors: [],
    });
    const report = (captured: CapturedPage[], uncaptured = 0): AuditReport => ({
        generatedAt: '', baseUrl: '', commit: null, configs: ['390-dark-bg'], routeCount: captured.length + uncaptured,
        captured,
        uncaptured: Array.from({ length: uncaptured }, (_, i) => ({ kind: 'route' as const, id: `/gone/${i}`, config: '390-dark-bg', reason: 'x' })),
    });

    it('counts pages failing each check, not elements', () => {
        expect(headline(report([page('/a', { clipped: 5 }), page('/b', { clipped: 1 })]))['390-dark-bg'].clipped).toBe(2);
    });

    it('flags a count that rose as a regression and one that fell as a move', () => {
        const ref = report([page('/a', { clipped: 1 }), page('/b', { tapUnder24: 1 })]);
        const now = report([page('/a', { clipped: 1, inputUnder16: 1 }), page('/b', {})]);
        const { rows, regressions } = compareReports(ref, now);
        expect(rows.map((r) => `${r.metric}:${r.reference}->${r.current}`).sort()).toEqual(['inputUnder16:0->1', 'tapUnder24:1->0']);
        expect(regressions.map((r) => r.metric)).toEqual(['inputUnder16']);
    });

    it('flags a route that stopped rendering, so it cannot lower a count unnoticed', () => {
        const ref = report([page('/a', { clipped: 1 }), page('/b', {})]);
        const now = report([page('/b', {})], 1);
        expect(compareReports(ref, now).regressions.map((r) => r.metric)).toEqual(['uncaptured']);
    });
});

describe('renderComparison (what the scheduled workflow quotes in its issue)', () => {
    const zero = Object.fromEntries(MOBILE_METRICS.map((m) => [m.id, 0])) as MetricCounts;
    const page = (id: string, counts: Partial<MetricCounts>): CapturedPage => ({
        kind: 'route', id, config: '390-dark-bg', url: id, finalUrl: id, status: 200,
        counts: { ...zero, ...counts }, samples: {}, leaks: [], consoleErrors: [],
    });
    const report = (captured: CapturedPage[], gone: string[] = []): AuditReport => ({
        generatedAt: 'now', baseUrl: '', commit: 'abc1234', configs: ['390-dark-bg'], routeCount: captured.length + gone.length,
        captured,
        uncaptured: gone.map((id) => ({ kind: 'route' as const, id, config: '390-dark-bg', reason: 'HTTP 500' })),
    });

    it('names the routes that fail a check now and did not before, and only those', () => {
        const ref = report([page('/a', { tapUnder24: 1 }), page('/b', {}), page('/c', {})]);
        const now = report([page('/a', { tapUnder24: 2 }), page('/b', { tapUnder24: 1 }), page('/c', {})]);
        expect(newlyFailing(ref, now, '390-dark-bg', 'tapUnder24')).toEqual(['/b']);
        const md = renderComparison(ref, now);
        expect(md).toContain('**1 count rose**');
        expect(md).toContain('| 390-dark-bg | Tap target < 24 px in the page body | 1 | 2 ▲ |');
        expect(md).toContain('- `/b`');
        expect(md).not.toContain('- `/a`');
    });

    it('names a route that stopped rendering, with its reason', () => {
        const ref = report([page('/a', {}), page('/b', {})]);
        const now = report([page('/a', {})], ['/b']);
        const md = renderComparison(ref, now);
        expect(md).toContain('| 390-dark-bg | Routes not captured | 0 | 1 ▲ |');
        expect(md).toContain('- `/b (HTTP 500)`');
    });

    it('reports a fall without calling it a regression, and says so when nothing moved', () => {
        const ref = report([page('/a', { clipped: 1 })]);
        const fell = renderComparison(ref, report([page('/a', {})]));
        expect(fell).toContain('Every count that moved fell.');
        expect(fell).not.toContain('rose');
        expect(renderComparison(ref, ref)).toContain('No count of failing pages moved.');
    });
});
