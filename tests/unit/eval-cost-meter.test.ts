/**
 * The shared CI evaluation cost meter (evals/cost-meter/meter.mjs; Ragas
 * sub-phase 0.6, D-EV-1 and D-EV-2): the check is before the call, an unknown
 * cost is never read as a small one, and shares cannot be configured past the
 * owner's USD 5 a night.
 *
 * The meter is an ES module run by plain `node` in CI (garak's breaker calls
 * it), so it is exercised here the way the workflows run it: in a child node.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const METER = path.join(ROOT, 'evals/cost-meter/meter.mjs');
const METER_URL = `file://${METER}`;

/** Run `body` (an async function body with `m` = the meter module) in node, and return what it returns. */
function inMeter<T>(body: string): T {
    const script = `import * as m from ${JSON.stringify(METER_URL)};\nconst out = await (async () => { ${body} })();\nprocess.stdout.write(JSON.stringify(out));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout) as T;
}

const HAIKU = `{ usdPerMillionInputTokens: 1, usdPerMillionOutputTokens: 5 }`;

describe('cost meter: the check is before the call', () => {
    it('reserves a call at counted input plus max_tokens, and refuses the call that could pass the share', () => {
        const out = inMeter<{ first: { ok: boolean }; second: { ok: boolean; reason?: string }; status: string; spent: number }>(`
            const meter = m.createMeter({ shareUsd: 0.01, price: ${HAIKU} });
            // 1000 in + 1000 max out = 0.001 + 0.005 = 0.006.
            const first = meter.reserve({ inputTokens: 1000, maxOutputTokens: 1000 });
            // Another 0.006 would make 0.012 > 0.01: refused before it is sent.
            const second = meter.reserve({ inputTokens: 1000, maxOutputTokens: 1000 });
            return { first, second, status: meter.status(), spent: meter.spentUsd() };
        `);
        expect(out.first.ok).toBe(true);
        expect(out.second).toMatchObject({ ok: false, reason: 'BUDGET_EXHAUSTED' });
        expect(out.status).toBe('BUDGET_EXHAUSTED');
        expect(out.spent).toBe(0);
    });

    it('admits a call whose worst case lands exactly on the share', () => {
        const out = inMeter<{ ok: boolean }>(`
            const meter = m.createMeter({ shareUsd: 0.01, price: ${HAIKU} });
            return meter.reserve({ inputTokens: 5000, maxOutputTokens: 1000 });
        `);
        expect(out.ok).toBe(true);
    });

    it('settles to the reported usage, and keeps the worst case when no usage came back', () => {
        const out = inMeter<{ reported: number; unknown: number; open: number }>(`
            const a = m.createMeter({ shareUsd: 1, price: ${HAIKU} });
            const r1 = a.reserve({ inputTokens: 1000, maxOutputTokens: 1000 });
            a.settle(r1.id, { inputTokens: 1000, outputTokens: 10 });
            const b = m.createMeter({ shareUsd: 1, price: ${HAIKU} });
            const r2 = b.reserve({ inputTokens: 1000, maxOutputTokens: 1000 });
            b.settle(r2.id, null);
            return { reported: a.spentUsd(), unknown: b.spentUsd(), open: a.openReservations() + b.openReservations() };
        `);
        expect(out.reported).toBe(0.00105);
        expect(out.unknown).toBe(0.006);
        expect(out.open).toBe(0);
    });

    it('unreadable usage is charged the worst case and closes the reservation: it never reopens the share', () => {
        // A partial usage object (outputTokens missing) used to throw AFTER the
        // reservation was released: spent stayed 0, the reservation was gone,
        // and a second USD 2.00 call fitted a USD 2.50 share.
        const out = inMeter<{ settled: { chargedUsd: number; usageUnreadable: boolean }; spent: number; reserved: number; open: number; next: boolean }[]>(`
            const results = [];
            for (const usage of [{ inputTokens: 1000000 }, { inputTokens: 1000000, outputTokens: -1 }, { inputTokens: 1.5, outputTokens: 0 }, {}]) {
                const meter = m.createMeter({ shareUsd: 2.5, price: ${HAIKU} });
                const r = meter.reserve({ inputTokens: 1000000, maxOutputTokens: 200000 });
                const settled = meter.settle(r.id, usage);
                const next = meter.reserve({ inputTokens: 1000000, maxOutputTokens: 200000 });
                results.push({ settled, spent: meter.spentUsd(), reserved: meter.reservedUsd(), open: meter.openReservations(), next: next.ok });
            }
            return results;
        `);
        for (const r of out) {
            expect(r).toEqual({
                settled: { chargedUsd: 2, overran: false, usageUnreadable: true },
                spent: 2,
                reserved: 0,
                open: 0,
                next: false,
            });
        }
    });

    it('a settled refund frees room for the next call; an open reservation still holds it', () => {
        const out = inMeter<{ heldRefused: boolean; afterSettle: boolean }>(`
            const meter = m.createMeter({ shareUsd: 0.01, price: ${HAIKU} });
            const r = meter.reserve({ inputTokens: 1000, maxOutputTokens: 1000 });
            const held = meter.precheck({ inputTokens: 1000, maxOutputTokens: 1000 });
            meter.settle(r.id, { inputTokens: 1000, outputTokens: 0 });
            const after = meter.precheck({ inputTokens: 1000, maxOutputTokens: 1000 });
            return { heldRefused: !held.fits, afterSettle: after.fits };
        `);
        expect(out).toEqual({ heldRefused: true, afterSettle: true });
    });

    it('once exhausted, refuses even a call that would fit: a stopped run stays stopped', () => {
        const out = inMeter<{ ok: boolean }>(`
            const meter = m.createMeter({ shareUsd: 0.01, price: ${HAIKU} });
            meter.reserve({ inputTokens: 100000, maxOutputTokens: 0 });
            return meter.reserve({ inputTokens: 1, maxOutputTokens: 1 });
        `);
        expect(out.ok).toBe(false);
    });

    it('refuses token counts that are not non-negative integers, and a reservation settled twice', () => {
        const out = inMeter<string[]>(`
            const errs = [];
            const meter = m.createMeter({ shareUsd: 1, price: ${HAIKU} });
            for (const call of [{ inputTokens: -1, maxOutputTokens: 1 }, { inputTokens: 1.5, maxOutputTokens: 1 }, { inputTokens: 1, maxOutputTokens: Number.NaN }]) {
                try { meter.reserve(call); errs.push('accepted'); } catch { errs.push('refused'); }
            }
            const r = meter.reserve({ inputTokens: 1, maxOutputTokens: 1 });
            meter.settle(r.id, null);
            try { meter.settle(r.id, null); errs.push('accepted'); } catch { errs.push('refused'); }
            return errs;
        `);
        expect(out).toEqual(['refused', 'refused', 'refused', 'refused']);
    });

    it('prices an unpriced model as nothing at all: it refuses', () => {
        const out = inMeter<string>(`
            try { m.priceFor({ version: 'x', models: {} }, 'claude-haiku-4-5'); return 'priced'; } catch { return 'refused'; }
        `);
        expect(out).toBe('refused');
    });
});

describe('cost meter: shares never pass the decided USD 5', () => {
    const TABLE = `{ models: { 'claude-haiku-4-5': ${HAIKU} } }`;
    const problems = (shares: string) => inMeter<string[]>(`return m.shareProblems(${shares}, ${TABLE});`);
    const share = (usd: number, model = 'claude-haiku-4-5') => `{ usd: ${usd}, model: '${model}' }`;

    it('accepts the decided split (D-EV-11: USD 2.50 each)', () => {
        expect(problems(`{ nightlyCapUsd: 5, shares: { garak: ${share(2.5)}, ragas: ${share(2.5)} } }`)).toEqual([]);
    });

    it('refuses shares summing a cent above the cap, and a cap above USD 5.00', () => {
        expect(problems(`{ nightlyCapUsd: 5, shares: { garak: ${share(2.5)}, ragas: ${share(2.51)} } }`).join()).toMatch(/sum to USD 5\.01/);
        expect(problems(`{ nightlyCapUsd: 4, shares: { garak: ${share(2.5)}, ragas: ${share(2.5)} } }`).join()).toMatch(/above the nightly cap of USD 4\.00/);
        expect(problems(`{ nightlyCapUsd: 6, shares: { garak: ${share(3)}, ragas: ${share(3)} } }`).join()).toMatch(/above the decided USD 5\.00/);
    });

    it('refuses a share whose model the price table does not price', () => {
        expect(problems(`{ nightlyCapUsd: 5, shares: { garak: ${share(2.5)}, ragas: ${share(2.5, 'claude-opus-4-1')} } }`).join()).toMatch(
            /"ragas" names model "claude-opus-4-1", which the price table does not price/,
        );
    });

    it('refuses a share that is not a positive whole-cent amount, or carries another key', () => {
        expect(problems(`{ nightlyCapUsd: 5, shares: { garak: ${share(0)} } }`)).not.toEqual([]);
        expect(problems(`{ nightlyCapUsd: 5, shares: { garak: ${share(2.505)} } }`)).not.toEqual([]);
        expect(problems(`{ nightlyCapUsd: 5, shares: { garak: { usd: 2.5, model: 'claude-haiku-4-5', cap: 9 } } }`)).not.toEqual([]);
        expect(problems(`{ nightlyCapUsd: 5, shares: {} }`)).not.toEqual([]);
    });

    it('jobBudget refuses to hand out a share from a split that cannot be metered', () => {
        const out = inMeter<string>(`
            try { m.jobBudget({ nightlyCapUsd: 5, shares: { garak: ${share(3)}, ragas: ${share(3)} } }, ${TABLE}, 'garak'); return 'handed out'; }
            catch { return 'refused'; }
        `);
        expect(out).toBe('refused');
    });
});

describe('cost meter: the price table is named by the hash of its exact bytes', () => {
    it('the CLI hash is the SHA-256 of the committed file', () => {
        const bytes = fs.readFileSync(path.join(ROOT, 'evals/cost-meter/prices.json'));
        const expected = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        const r = spawnSync(process.execPath, [METER, 'hash'], { encoding: 'utf-8' });
        expect(r.stdout.trim()).toBe(expected);
    });

    it('a reformatted table is a different table', () => {
        const out = inMeter<boolean>(`return m.priceTableHash(Buffer.from('{"a":1}')) !== m.priceTableHash(Buffer.from('{ "a": 1 }'));`);
        expect(out).toBe(true);
    });
});
