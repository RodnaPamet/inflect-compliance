/**
 * polish #1 — score-chip a11y ratchet.
 *
 * The explainer trigger announces the SCORE + BAND before the verb
 * "explain", so a screen-reader user gets "20 · High, explain" not
 * just "Explain this score". Pins the wiring at both call sites.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('score-chip a11y label', () => {
    test('the explainer derives its aria-label from the label prop', () => {
        const src = read('src/components/risks/RiskScoreExplainer.tsx');
        // i18n-aware: the aria-label is now composed via next-intl. Assert
        // the t('key') wiring in source AND that the en.json values still
        // carry the canonical English the a11y contract requires.
        expect(src).toMatch(/aria-label=\{label \? t\('explainLabelAria', \{ label \}\) : t\('explainAria'\)\}/);
        const en = JSON.parse(read('messages/en.json'));
        expect(en.panels.scoreExplainer.explainAria).toBe('Explain this score');
        expect(en.panels.scoreExplainer.explainLabelAria).toBe('{label}, explain');
    });

    test('the risks list passes score · band', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx');
        expect(src).toMatch(/label=\{`\$\{score\} · \$\{band\.name\}`\}/);
    });

    test('the risk detail header passes inherentScore · band.label', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');
        expect(src).toMatch(/label=\{`\$\{risk\.inherentScore\} · \$\{band\.label\}`\}/);
    });
});
