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

    /**
     * B3-5 — two cases removed here, both now covered BEHAVIOURALLY:
     *
     *   • "lazy-fetches on open — no eager per-chip fetch" →
     *     `tests/rendered/risk-score-explainer-lazy-fetch.test.tsx`, which
     *     mounts 25 chips and counts real requests. The old version sliced
     *     the component source between two declaration NAMES
     *     (`indexOf('const onOpenChange')` → `indexOf('return (')`) — a
     *     shape CLAUDE.md bans, because reordering the declarations yields a
     *     BACKWARDS, empty slice in which every `not.toMatch` passes while
     *     checking nothing.
     *
     *   • "MIGRATION provenance is labelled honestly" →
     *     `tests/rendered/risk-score-explainer-provenance.test.tsx`
     *     ("MIGRATION never claims an actor"), which renders the popover
     *     rather than grepping for the label string.
     *
     * What remains below is the API/aggregator surface — claims about route
     * shape and query bounding that no component render can see.
     */
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
