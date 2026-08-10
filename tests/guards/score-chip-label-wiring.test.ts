/**
 * Both score-chip call sites pass a label to the explainer.
 *
 * The a11y CONTRACT — that the trigger announces "20 · High, explain", score
 * first — is asserted against the rendered accessible name in
 * `tests/rendered/risk-score-explainer-a11y-label.test.tsx`. This file
 * covers only what that cannot see: that the two large page components
 * actually pass a `label`, rather than mounting the explainer bare and
 * silently falling back to the generic "Explain this score" on every row.
 *
 * B3-5 — this replaces `polish-01-score-chip-a11y.test.ts`, which:
 *
 *   - matched the component's `aria-label={label ? t(...) : t(...)}` source
 *     literally (now covered behaviourally, and better);
 *   - pinned two English strings in `messages/en.json`, so a copy edit
 *     turned CI red — banned by the ratchet-lifecycle policy;
 *   - pinned the call sites' EXACT template literals, including spacing
 *     around the `·`, so reformatting counted as a regression.
 *
 * The two assertions below deliberately match the SHAPE — a label prop whose
 * expression mentions the score and the band — not the exact characters.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** `label={...}` whose expression names both a score and a band. */
const LABELLED = /label=\{`[^`]*\$\{[^}]*[Ss]core[^}]*\}[^`]*\$\{[^}]*band[^}]*\}[^`]*`\}/;

describe('score-chip explainer label wiring', () => {
    it('the risks list passes a score+band label', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx');
        expect(src).toMatch(/<RiskScoreExplainer/);
        expect(src).toMatch(LABELLED);
    });

    it('the risk detail header passes a score+band label', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');
        expect(src).toMatch(/<RiskScoreExplainer/);
        expect(src).toMatch(LABELLED);
    });
});
