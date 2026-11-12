/**
 * The committed CI evaluation budget can be metered, and cannot pass the
 * owner's USD 5 a night (D-EV-1, D-EV-2; docs/ai-architecture/ragas.md 0.6).
 *
 * garak and Ragas both spend on the dedicated CI key, so their caps are SHARES
 * of one cap, in evals/cost-meter/shares.json, priced by one pinned table,
 * evals/cost-meter/prices.json. This guard runs the meter's own `check-shares`
 * (the same function a job calls before it spends anything), so the rule a
 * job enforces and the rule CI enforces are one rule, and restates the two
 * numbers a reviewer most needs to see: the shares sum to at most USD 5.00,
 * and every configured model has a price.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

const shares = read('evals/cost-meter/shares.json') as { nightlyCapUsd: number; shares: Record<string, { usd: number; model: string }> };
const prices = read('evals/cost-meter/prices.json') as {
    version: string;
    models: Record<string, { usdPerMillionInputTokens: number; usdPerMillionOutputTokens: number }>;
};

describe('the CI evaluation cost meter, as committed', () => {
    it("passes the meter's own share check", () => {
        const r = spawnSync(process.execPath, [path.join(ROOT, 'evals/cost-meter/meter.mjs'), 'check-shares'], { encoding: 'utf-8' });
        expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    });

    it('the shares sum to at most USD 5.00, counted in whole cents', () => {
        const cents = Object.values(shares.shares).reduce((s, x) => s + Math.round(x.usd * 100), 0);
        expect(cents).toBeLessThanOrEqual(500);
        expect(Math.round(shares.nightlyCapUsd * 100)).toBeLessThanOrEqual(500);
    });

    it('garak and Ragas each hold the decided default share of USD 2.50', () => {
        expect(shares.shares.garak?.usd).toBe(2.5);
        expect(shares.shares.ragas?.usd).toBe(2.5);
    });

    it('every configured model has a price, and every price is a rate', () => {
        expect(prices.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        for (const [job, share] of Object.entries(shares.shares)) {
            const price = prices.models[share.model];
            expect({ job, model: share.model, priced: price !== undefined }).toEqual({ job, model: share.model, priced: true });
            expect(price.usdPerMillionInputTokens).toBeGreaterThan(0);
            expect(price.usdPerMillionOutputTokens).toBeGreaterThan(0);
        }
    });

    it("garak's budget names the model its share is metered as", () => {
        expect(read('.garak/budget.json').model).toBe(shares.shares.garak.model);
    });
});
