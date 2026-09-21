/**
 * VR-9 — Control-page AI rule-suggestions ratchet.
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

describe('VR-9 — control AI suggestions', () => {
    it('the suggester usecase + route exist', () => {
        expect(exists('src/app-layer/usecases/automation-suggestions.ts')).toBe(true);
        expect(
            exists('src/app/api/t/[tenantSlug]/ai/automation-suggestions/route.ts'),
        ).toBe(true);
        const uc = read('src/app-layer/usecases/automation-suggestions.ts');
        expect(uc).toMatch(/export function rankRuleSuggestions/);
        expect(uc).toMatch(/assertCanReadAutomation/);
        // excludes already-covered events
        expect(uc).toMatch(/coveredEvents/);
    });

    it('the rail component is mounted in the Control detail page right rail', () => {
        const rail = 'src/components/automation/AutomationSuggestionsRail.tsx';
        expect(exists(rail)).toBe(true);
        const page = read('src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx');
        expect(page).toMatch(/AutomationSuggestionsRail/);
        expect(page).toMatch(/rail=\{/);
        expect(page).toMatch(/surfaceKey="controls-detail-ai"/);
    });
});
