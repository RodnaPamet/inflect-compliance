/**
 * RQ3-OB-B — Polish ratchet (skeletons + explainer retry + ALE sort).
 *
 * Three small wins, three regression classes guarded:
 *
 *   - Skeletons: the risk + control detail pages must not regress
 *     to an empty-shell loading state (the flash of bare layout
 *     chrome that landed before the page-data SWR resolved).
 *   - Explainer retry: the score explainer's error state must
 *     carry a Retry affordance (no silent failures — the user can
 *     re-fire the fetch without closing/reopening the popover).
 *   - ALE sort: the risks register must list `'ale'` in its
 *     sortable-column allowlist AND mount a column with the
 *     matching id, so the header click actually triggers a sort.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const riskDetail = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');
const controlDetail = read('src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx');
const explainer = read('src/components/risks/RiskScoreExplainer.tsx');
const risksClient = read('src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx');

describe('RQ3-OB-B — detail-page loading uses a structured skeleton', () => {
    test('risk detail page renders <SkeletonDetailPage /> when loading', () => {
        expect(riskDetail).toMatch(/<SkeletonDetailPage \/>/);
        // The bare empty-children regression we explicitly forbid.
        expect(riskDetail).not.toMatch(
            /<EntityDetailLayout loading[^>]*>\s*<>\s*<\/>\s*<\/EntityDetailLayout>/,
        );
    });

    test('control detail page renders <SkeletonDetailPage /> when loading', () => {
        expect(controlDetail).toMatch(/<SkeletonDetailPage \/>/);
        expect(controlDetail).not.toMatch(
            /<EntityDetailLayout loading[^>]*>\s*\{null\}\s*<\/EntityDetailLayout>/,
        );
    });
});

describe('RQ3-OB-B — score explainer offers a Retry on error', () => {
    test('the error branch carries a retry button + testid', () => {
        expect(explainer).toMatch(/data-testid="score-explainer-error"/);
        expect(explainer).toMatch(/data-testid="score-explainer-retry"/);
        expect(explainer).toMatch(/onClick=\{loadExplanation\}/);
    });

    test('the load fn is hoisted (so retry calls the same path as the initial open)', () => {
        expect(explainer).toMatch(/const loadExplanation = \(\) => \{/);
        expect(explainer).toMatch(/setState\('loading'\);[\s\S]*?fetch\(/);
    });
});

describe('RQ3-OB-B — ALE sortability on the risks register', () => {
    test('the sortable-column allowlist includes \'ale\'', () => {
        expect(risksClient).toMatch(
            /sortableRiskColumns = useMemo\(\s*\(\)\s*=>\s*\[[^\]]*'ale'[^\]]*\]/,
        );
    });

    test('the sort accessor maps \'ale\' to riskAle (honest-null sorts last)', () => {
        // Migrated off the per-page `case 'ale'` comparator onto the shared
        // `sortRowsByDisplay` helper (which orders nullish values last, so the
        // honest-null behaviour is preserved). The accessor returns the same
        // value the ALE column displays — `riskAle(r) ?? null`.
        expect(risksClient).toMatch(/sortRowsByDisplay\(/);
        expect(risksClient).toMatch(/ale:\s*\(r\)\s*=>\s*riskAle\(r\)\s*\?\?\s*null/);
    });

    test('a column with id=\'ale\' exists so the header click can trigger the sort', () => {
        // Header migrated to next-intl; resolve the key against en.json.
        const en = JSON.parse(read('messages/en.json')) as { risks: { colHeaders: Record<string, string> } };
        expect(risksClient).toMatch(/id: 'ale',\s+header: tx\('colHeaders\.ale'\),/);
        expect(en.risks.colHeaders.ale).toBe('ALE');
    });
});
