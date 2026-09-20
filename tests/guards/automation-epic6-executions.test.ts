/**
 * Automation Epic 6 — structural ratchet for execution history + re-trigger.
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

describe('Automation Epic 6 — execution history & re-trigger', () => {
    it('the executions + re-trigger routes exist', () => {
        expect(
            exists('src/app/api/t/[tenantSlug]/automation/rules/[id]/executions/route.ts'),
        ).toBe(true);
        expect(
            exists('src/app/api/t/[tenantSlug]/automation/rules/[id]/re-trigger/route.ts'),
        ).toBe(true);
    });

    it('the executions usecase scrubs PII + cursor-paginates', () => {
        const src = read('src/app-layer/usecases/automation-executions.ts');
        expect(src).toMatch(/PII_BLOCKLIST/);
        expect(src).toMatch(/scrubPayload/);
        expect(src).toMatch(/listForRulePaginated/);
        expect(src).toMatch(/nextCursor/);
    });

    it('re-trigger targets a single rule via the dispatcher', () => {
        const src = read('src/app-layer/usecases/automation-executions.ts');
        expect(src).toMatch(/targetRuleId/);
        expect(src).toMatch(/triggeredBy: 'manual'/);
        // the dispatcher honours the target
        expect(read('src/app-layer/jobs/automation-event-dispatch.ts')).toMatch(
            /payload\.targetRuleId/,
        );
    });

    it('the detail sheet mounts the executions panel', () => {
        expect(exists('src/components/processes/ExecutionsPanel.tsx')).toBe(true);
        expect(read('src/components/processes/RuleDetailSheet.tsx')).toMatch(/ExecutionsPanel/);
    });
});
