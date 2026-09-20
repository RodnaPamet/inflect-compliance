/**
 * VR-8 — automation canvas export ratchet.
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

describe('VR-8 — canvas export', () => {
    it('the evidence-pack usecase + route exist', () => {
        expect(exists('src/app-layer/usecases/automation-export.ts')).toBe(true);
        expect(
            exists('src/app/api/t/[tenantSlug]/processes/[id]/export-automation/route.ts'),
        ).toBe(true);
        const uc = read('src/app-layer/usecases/automation-export.ts');
        expect(uc).toMatch(/export function summarizeRuleExecutions/);
        expect(uc).toMatch(/export async function buildAutomationEvidencePack/);
        // 30-day window + success rate are the audit-relevant aggregates
        expect(uc).toMatch(/executions30d/);
        expect(uc).toMatch(/successRate/);
    });
});
