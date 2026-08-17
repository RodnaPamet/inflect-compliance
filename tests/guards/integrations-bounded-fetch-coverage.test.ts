/**
 * No integration provider may default to an unbounded `fetch`.
 *
 * The behavioural half lives in `tests/unit/integrations-bounded-fetch.test.ts`
 * and proves the deadline works. This proves it is REACHED — which is the part
 * that decays, because adding a provider means writing `?? fetch` once and
 * nothing anywhere complains.
 *
 * That decay is expensive out of proportion to how easy it is: the dispatchers
 * fan out across tenants onto a shared worker pool, so one unbounded provider
 * hitting one black-holed endpoint starves every other tenant queued behind it.
 * The blast radius of the omission is the whole fan-out, not one connection.
 *
 * Note the injectable `fetchImpl` is deliberately untouched by this rule — a
 * test that passes its own fetch SHOULD bypass the deadline. Only the DEFAULT
 * has to be bounded.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const INTEGRATIONS = path.join(ROOT, 'src/app-layer/integrations');

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
}

const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The shapes that mean "fall back to the global, unbounded fetch":
 *   `?? fetch`            `?? globalThis.fetch`         `= globalThis.fetch`
 */
const UNBOUNDED_DEFAULT =
    /(\?\?\s*(globalThis\.)?fetch\b)|(=\s*globalThis\.fetch\b)/;

const ALLOWED: Record<string, string> = {
    'src/app-layer/integrations/bounded-fetch.ts':
        'The helper itself — it is the one place allowed to call the global fetch.',
};

/**
 * `boundedFetch` alone is no longer the finished article: it bounds ONE request
 * but leaves a 429 to surface as a generic failure, which the queue then
 * answers with three full re-syncs in ~35s. `resilientFetch` wraps it. Only
 * these two may name the bounded helper directly.
 */
const BOUNDED_DIRECT_ALLOWED: Record<string, string> = {
    'src/app-layer/integrations/bounded-fetch.ts': 'Defines it.',
    'src/app-layer/integrations/http-resilience.ts':
        'Wraps it — the resilient fetch is a bounded fetch plus throttle handling.',
};

describe('every integration provider defaults to a bounded fetch', () => {
    const files = walk(INTEGRATIONS);

    it('sanity — the integrations tree was found', () => {
        // A guard over an empty file list passes vacuously.
        expect(files.length).toBeGreaterThan(10);
    });

    it('no file falls back to the global unbounded fetch', () => {
        const offenders = files
            .filter((f) => {
                const rel = path.relative(ROOT, f);
                if (ALLOWED[rel]) return false;
                return UNBOUNDED_DEFAULT.test(stripComments(fs.readFileSync(f, 'utf8')));
            })
            .map((f) => path.relative(ROOT, f));

        expect({ offenders }).toEqual({ offenders: [] });
    });

    it('the helper still combines a caller signal rather than replacing it', () => {
        // A "simplification" to `signal: deadline` would silently break
        // cancellation for every caller already passing one — and would look
        // tidier, which is what makes it likely.
        const src = fs.readFileSync(path.join(INTEGRATIONS, 'bounded-fetch.ts'), 'utf8');
        expect(src).toMatch(/AbortSignal\.any\(/);
        expect(src).toMatch(/AbortSignal\.timeout\(/);
    });

    it('the timeout is detected by name, not instanceof Error', () => {
        // Node's DOMException does not reliably inherit from Error, so an
        // instanceof guard lets every timeout through unwrapped — the deadline
        // still fires, but stops being classifiable as retryable, and nothing
        // fails to say so.
        const src = stripComments(
            fs.readFileSync(path.join(INTEGRATIONS, 'bounded-fetch.ts'), 'utf8'),
        );
        expect(src).toMatch(/name === 'TimeoutError'/);
        expect(src).not.toMatch(/err instanceof Error && err\.name === 'TimeoutError'/);
    });

    it('no provider settles for a bounded-but-throttle-blind default', () => {
        // The next omission is not `?? fetch` — that rule is already held
        // above. It is `?? boundedFetch`, which looks correct, passes the rule
        // above, and silently reinstates the amplification a 429 causes.
        const offenders = files
            .filter((f) => {
                const rel = path.relative(ROOT, f);
                if (BOUNDED_DIRECT_ALLOWED[rel]) return false;
                return /\bboundedFetch\b/.test(stripComments(fs.readFileSync(f, 'utf8')));
            })
            .map((f) => path.relative(ROOT, f));

        expect({ offenders }).toEqual({ offenders: [] });
    });

    it('the resilient fetch still layers ON the bounded one', () => {
        // If this stops being true, every provider quietly loses its deadline
        // while the rule above still reads as satisfied.
        const src = stripComments(
            fs.readFileSync(path.join(INTEGRATIONS, 'http-resilience.ts'), 'utf8'),
        );
        expect(src).toMatch(/opts\.fetchImpl \?\? boundedFetch/);
    });

    it('the queue-retry bypass covers BOTH failure modes, not just auth', () => {
        // Narrowing this to terminal errors alone would leave the 429 path
        // amplifying again — the exact defect H1-2 exists to close — and no
        // other test would notice, because the in-process retry would still
        // work perfectly.
        const src = stripComments(
            fs.readFileSync(path.join(INTEGRATIONS, 'http-resilience.ts'), 'utf8'),
        );
        const fn = src.slice(src.indexOf('export function shouldBypassQueueRetry'));
        const body = fn.slice(0, fn.indexOf('\n}'));
        expect(body).toMatch(/IntegrationTerminalError/);
        expect(body).toMatch(/IntegrationRateLimitedError/);
    });

    it('every carve-out still exists and carries a reason', () => {
        for (const [rel, reason] of Object.entries({
            ...ALLOWED,
            ...BOUNDED_DIRECT_ALLOWED,
        })) {
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
            expect(reason.length).toBeGreaterThan(10);
        }
    });
});
