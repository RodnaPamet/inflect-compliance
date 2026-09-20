/**
 * Automation Epic 9 — structural ratchet for the analytics dashboard.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('Automation Epic 9 — analytics dashboard', () => {
    it('analytics usecase + route + tab exist', () => {
        expect(exists('src/app-layer/usecases/automation-analytics.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/automation/analytics/route.ts')).toBe(true);
        expect(exists('src/app/t/[tenantSlug]/(app)/processes/AnalyticsTab.tsx')).toBe(true);
    });

    it('the usecase aggregates the documented metrics', () => {
        const src = read('src/app-layer/usecases/automation-analytics.ts');
        for (const k of ['topRules', 'slaBreaches', 'avgDurationMs', 'errorRate', 'executions']) {
            expect(src).toMatch(new RegExp(k));
        }
    });

    it('ProcessesClient mounts the Analytics tab', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx');
        expect(src).toMatch(/AnalyticsTab/);
        expect(src).toMatch(/"analytics"/);
    });
});
