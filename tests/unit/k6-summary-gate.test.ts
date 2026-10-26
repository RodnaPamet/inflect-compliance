/**
 * The k6 summary gate fails a load test that measured nothing (#4307).
 *
 * The nightly k6 steps are `continue-on-error`, so for at least a month a run
 * in which 99.7% of the list requests failed was green. And k6 passes a
 * threshold that matched no sample: `checks{check:controls_ok}` matched none,
 * because k6 writes its own `check` tag over a custom one.
 *
 * These tests drive the real script on summaries shaped like the ones k6
 * writes in `handleSummary`, including the 2026-10-25 nightly's numbers.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const GATE = path.resolve(__dirname, '../../scripts/k6-summary-gate.mjs');

type Metric = { type: string; contains?: string; values: Record<string, number>; thresholds?: Record<string, { ok: boolean }> };

const rate = (passes: number, fails: number, thresholds?: Metric['thresholds']): Metric => ({
    type: 'rate',
    contains: 'default',
    values: { rate: passes + fails === 0 ? 0 : passes / (passes + fails), passes, fails },
    ...(thresholds ? { thresholds } : {}),
});

const trend = (values: Record<string, number>, thresholds?: Metric['thresholds']): Metric => ({
    type: 'trend',
    contains: 'time',
    values,
    ...(thresholds ? { thresholds } : {}),
});

/** A healthy lists run: every thresholded metric has samples. */
function healthy(): Record<string, Metric> {
    return {
        checks: rate(3000, 0),
        'checks{probe:controls}': rate(1000, 0, { 'rate>0.99': { ok: true } }),
        list_success_rate: rate(1500, 0, { 'rate>0.99': { ok: true } }),
        'http_req_duration{endpoint:controls}': trend(
            { avg: 40, min: 10, med: 35, max: 200, 'p(90)': 70, 'p(95)': 90, 'p(99)': 150 },
            { 'p(95)<800': { ok: true } },
        ),
        iterations: { type: 'counter', contains: 'default', values: { count: 500, rate: 8 } },
        vus: { type: 'gauge', contains: 'default', values: { value: 0, min: 0, max: 25 } },
    };
}

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'k6-gate-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(metrics: Record<string, Metric> | null, ...args: string[]) {
    const file = path.join(dir, 'summary.json');
    if (metrics) writeFileSync(file, JSON.stringify({ metrics }));
    const r = spawnSync(process.execPath, [GATE, file, ...args], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('k6 summary gate', () => {
    it('passes a run whose thresholded metrics all have samples and whose floors hold', () => {
        const r = run(healthy(), '--min', 'list_success_rate=0.95', '--min', 'checks=0.95');
        expect(r.out).toMatch(/^PASS/);
        expect(r.status).toBe(0);
    });

    it('fails a threshold that matched no sample, naming it', () => {
        const m = healthy();
        m['checks{check:controls_ok}'] = rate(0, 0, { 'rate>0.99': { ok: true } });
        const r = run(m);
        expect(r.status).toBe(1);
        expect(r.out).toContain('checks{check:controls_ok}: its threshold passed over no samples');
    });

    it('fails a thresholded trend that holds no sample', () => {
        const m = healthy();
        m['http_req_duration{endpoint:none}'] = trend(
            { avg: 0, min: 0, med: 0, max: 0, 'p(90)': 0, 'p(95)': 0, 'p(99)': 0 },
            { 'p(95)<800': { ok: true } },
        );
        const r = run(m);
        expect(r.status).toBe(1);
        expect(r.out).toContain('http_req_duration{endpoint:none}: its threshold passed over no samples');
    });

    it('ignores an empty metric that carries no threshold', () => {
        const m = healthy();
        m['checks{probe:unused}'] = rate(0, 0);
        expect(run(m).status).toBe(0);
    });

    it("fails the 2026-10-25 nightly's list run: 0.32% of list requests succeeded", () => {
        const m = healthy();
        m.list_success_rate = rate(75, 23421, { 'rate>0.99': { ok: false } });
        const r = run(m, '--min', 'list_success_rate=0.95');
        expect(r.status).toBe(1);
        expect(r.out).toContain('list_success_rate: 0.32%, below the 95% floor');
    });

    it('fails a floor on a rate with no samples, and on a metric that is not there', () => {
        const m = healthy();
        m.list_success_rate = rate(0, 0);
        const r = run(m, '--min', 'list_success_rate=0.95', '--min', 'auth_success_rate=0.95');
        expect(r.status).toBe(1);
        expect(r.out).toContain('list_success_rate: no samples');
        expect(r.out).toContain('auth_success_rate: not in the summary');
    });

    it('refuses a floor on a metric that is not a rate', () => {
        const r = run(healthy(), '--min', 'iterations=0.5');
        expect(r.status).toBe(1);
        expect(r.out).toContain('iterations: is a counter, not a rate');
    });

    it('fails when k6 wrote no summary', () => {
        const r = run(null);
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/no readable summary, so k6 measured nothing/);
    });

    it('rejects a malformed floor before reading anything', () => {
        expect(run(healthy(), '--min', 'checks=95').status).toBe(2);
        expect(run(healthy(), '--min', 'checks').status).toBe(2);
        expect(run(healthy(), '--floor', 'checks=0.9').status).toBe(2);
    });
});
