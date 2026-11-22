/**
 * The committed CI evaluation budget can be metered, and cannot pass the
 * owner's nightly cap: USD 6.50 since the owner's amendment of 2026-11-17
 * (D-EV-1, D-EV-2; it was USD 5; docs/ai-architecture/ragas.md 0.6).
 *
 * garak and Ragas both spend on the dedicated CI key, so their caps are SHARES
 * of one cap, in evals/cost-meter/shares.json, priced by one pinned table,
 * evals/cost-meter/prices.json. A share lists the MODELS it may spend on. This
 * guard runs the meter's own `check-shares` (the same function a job calls
 * before it spends anything), so the rule a job enforces and the rule CI
 * enforces are one rule, and restates the numbers a reviewer most needs to
 * see: the shares sum to at most the cap, the cap is at most USD 6.50, and
 * every listed model has a price.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

const shares = read('evals/cost-meter/shares.json') as { nightlyCapUsd: number; shares: Record<string, { usd: number; models: string[] }> };
const prices = read('evals/cost-meter/prices.json') as {
    version: string;
    models: Record<string, { usdPerMillionInputTokens: number; usdPerMillionOutputTokens: number }>;
};

describe('the CI evaluation cost meter, as committed', () => {
    it("passes the meter's own share check", () => {
        const r = spawnSync(process.execPath, [path.join(ROOT, 'evals/cost-meter/meter.mjs'), 'check-shares'], { encoding: 'utf-8' });
        expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    });

    it('the shares sum to at most the cap, and the cap to at most USD 6.50, counted in whole cents', () => {
        const cents = Object.values(shares.shares).reduce((s, x) => s + Math.round(x.usd * 100), 0);
        expect(cents).toBeLessThanOrEqual(Math.round(shares.nightlyCapUsd * 100));
        expect(Math.round(shares.nightlyCapUsd * 100)).toBeLessThanOrEqual(650);
    });

    // The shared cap is D-EV-1/D-EV-2 and the split is D-EV-11, both as
    // amended by the owner on 2026-11-17. Pinned so a move is a reviewed diff
    // against that decision.
    it('the cap and the shares are the ones the owner decided: USD 6.50; garak USD 2.50 on Haiku alone, Ragas USD 4.00', () => {
        expect(shares.nightlyCapUsd).toBe(6.5);
        expect(shares.shares.garak).toEqual({ usd: 2.5, models: ['claude-haiku-4-5'] });
        expect(shares.shares.ragas?.usd).toBe(4);
    });

    // The judge stays Haiku; the product's answers are written by the
    // assistant's production model (owner decision 2026-11-17).
    it("Ragas spends on its Haiku judge and the assistant's production model, and nothing else", () => {
        const env = fs.readFileSync(path.join(ROOT, 'src/lib/ai/model-defaults.ts'), 'utf-8');
        const assistantModel = /export const AGENT_FLUE_MODEL_DEFAULT = '([^']+)';/.exec(env)?.[1];
        expect(assistantModel).toBeDefined();
        expect([...shares.shares.ragas.models].sort()).toEqual(['claude-haiku-4-5', assistantModel!].sort());
    });

    it('every listed model has a price, and every price is a rate', () => {
        expect(prices.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        for (const [job, share] of Object.entries(shares.shares)) {
            expect(share.models.length).toBeGreaterThan(0);
            for (const model of share.models) {
                const price = prices.models[model];
                expect({ job, model, priced: price !== undefined }).toEqual({ job, model, priced: true });
                expect(price.usdPerMillionInputTokens).toBeGreaterThan(0);
                expect(price.usdPerMillionOutputTokens).toBeGreaterThan(0);
            }
        }
    });

    it('the price table carries the list prices the owner stated for the assistant’s model (2026-11-17)', () => {
        expect(prices.models['claude-sonnet-5-5']).toMatchObject({ usdPerMillionInputTokens: 2, usdPerMillionOutputTokens: 10 });
        expect(prices.models['claude-haiku-4-5']).toMatchObject({ usdPerMillionInputTokens: 1, usdPerMillionOutputTokens: 5 });
    });

    it("garak's budget names the one model its share lists", () => {
        expect(shares.shares.garak.models).toEqual([read('.garak/budget.json').model]);
    });
});
