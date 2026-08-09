/**
 * RQ2-3 — score-explainer presence + contract ratchet.
 *
 * A risk score chip that renders bare is the regression this guards:
 * the number goes back to being unexplainable, and the RQ2-1/RQ2-2
 * provenance work becomes invisible plumbing. Structural checks:
 *
 *   1. The two canonical score surfaces (risks list, risk detail
 *      MetaStrip) mount `RiskScoreExplainer` around their chips.
 *   2. The component lazy-fetches on OPEN — never eagerly. List
 *      pages render hundreds of chips; an eager fetch per chip is a
 *      self-inflicted N+1 against our own API.
 *   3. The popover labels MIGRATION provenance honestly instead of
 *      hiding or aliasing it.
 *   4. The aggregator stays read-bounded: events take-5, breaches
 *      filtered to unresolved, breaches take-bounded.
 *   5. The API surface is GET-only (read-only contract — an
 *      explanation endpoint must never grow a mutation verb).
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const component = read('src/components/risks/RiskScoreExplainer.tsx');
const usecase = read('src/app-layer/usecases/risk-score-explanation.ts');
const route = read('src/app/api/t/[tenantSlug]/risks/[id]/score-explanation/route.ts');
const risksClient = read('src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx');
const riskDetail = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');

describe('RQ2-3 — score chips explain themselves', () => {
    test('risks list mounts the explainer around the score chip', () => {
        expect(risksClient).toMatch(/import \{ RiskScoreExplainer \} from '@\/components\/risks\/RiskScoreExplainer'/);
        expect(risksClient).toMatch(/<RiskScoreExplainer/);
    });

    test('risk detail page mounts the explainer', () => {
        expect(riskDetail).toMatch(/import \{ RiskScoreExplainer \} from '@\/components\/risks\/RiskScoreExplainer'/);
        expect(riskDetail).toMatch(/<RiskScoreExplainer/);
    });

    test('the explainer lazy-fetches on open — no eager per-chip fetch', () => {
        // RQ3-OB-B — the fetch was hoisted into `loadExplanation`
        // so the Retry affordance can re-fire the same path. The
        // open-change handler now calls `loadExplanation()` instead
        // of inlining the fetch.
        const handler = component.slice(
            component.indexOf('const onOpenChange'),
            component.indexOf('return ('),
        );
        expect(handler).toMatch(/loadExplanation\(\)/);
        // The hoisted load fn is the single fetch site.
        const loadFn = component.slice(
            component.indexOf('const loadExplanation'),
            component.indexOf('const onOpenChange'),
        );
        expect(loadFn).toMatch(/fetch\(/);
        // No useEffect-fetch on mount (that would fire once per
        // rendered chip on a list page).
        expect(component).not.toMatch(/useEffect/);
        // Exactly one fetch call in the whole component — the one
        // inside loadExplanation, reused by both open-change AND
        // the Retry button.
        const fetches = component.match(/fetch\(/g) ?? [];
        expect(fetches).toHaveLength(1);
    });

    test('MIGRATION provenance is labelled honestly in the popover', () => {
        // i18n-aware: the label is localised via next-intl. Assert the
        // MIGRATION branch returns the t('provMigration') key AND that the
        // en.json value still labels it honestly ("pre-provenance backfill").
        expect(component).toMatch(/case 'MIGRATION':\s*\n\s*return t\('provMigration'\)/);
        const en = JSON.parse(read('messages/en.json'));
        expect(en.panels.scoreExplainer.provMigration).toBe('pre-provenance backfill');
    });

    test('the aggregator stays read-bounded (events take-5, breaches unresolved + bounded)', () => {
        expect(usecase).toMatch(/take:\s*5/);
        expect(usecase).toMatch(/resolvedAt:\s*null/);
        expect(usecase).toMatch(/take:\s*10/);
    });

    test('the API surface is GET-only and routes through the aggregator', () => {
        expect(route).toMatch(/export const GET = withApiErrorHandling/);
        expect(route).toMatch(/getScoreExplanation\(ctx, params\.id\)/);
        for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            expect(route).not.toMatch(new RegExp(`export const ${verb}`));
        }
    });

    test('actor names resolve via one batched lookup (no per-event query)', () => {
        expect(usecase).toMatch(/id:\s*\{\s*in:\s*actorIds\s*\}/);
    });
});
