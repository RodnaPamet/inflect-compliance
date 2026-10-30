/**
 * 5.6e (#4000): provenance instead of state.
 *
 * The acceptance has three parts — the deploy writes the digest, the page
 * renders provenance with the reachability probe beside it, and no rendered
 * string asserts a setting's effective value. This file covers the probe and
 * the provenance row; the digest and the no-assertion rule are guards.
 *
 * @module unit/admin/sandbox-runtime-provenance
 */

import {
    HEALTH_PATH,
    probeSandboxRuntime,
} from '@/lib/sandbox-runtime/health-probe';
import { displayForProvenance } from '@/app/t/[tenantSlug]/(app)/admin/sandbox-runtime/sandbox-runtime-display';

/** The body a real 0.1.6 gateway returns on /readyz — copied from a live probe. */
const REAL_READYZ = {
    status: 'healthy',
    version: '0.1.6',
    checks: { database: { status: 'healthy', latency_ms: 0 } },
};

const okJson = (body: unknown): typeof fetch =>
    (async () => ({ ok: true, json: async () => body }) as unknown as Response) as typeof fetch;

describe('the reachability probe', () => {
    it('reads the version from the body of the endpoint that carries one', async () => {
        // Measured on a live 0.1.6 gateway: /readyz carries the version,
        // /healthz answers 200 with an EMPTY body, /livez and /version are 404.
        // A probe pointed at /healthz would be reachable and versionless, which
        // is indistinguishable from unreachable.
        expect(HEALTH_PATH).toBe('/readyz');

        const calls: string[] = [];
        const fetchImpl = (async (url: string) => {
            calls.push(String(url));
            return { ok: true, json: async () => REAL_READYZ } as unknown as Response;
        }) as unknown as typeof fetch;

        const r = await probeSandboxRuntime('http://10.0.0.1:8081', fetchImpl);
        expect(r).toEqual({ outcome: 'answered', reachableVersion: '0.1.6' });
        expect(calls).toEqual(['http://10.0.0.1:8081/readyz']);
    });

    it('an absent URL is NOT-PROBED, which is not unreachable', async () => {
        // Reporting a gateway as unreachable because this deploy never named
        // one would be a claim about someone else's infrastructure.
        for (const url of [undefined, '']) {
            expect(await probeSandboxRuntime(url)).toEqual({
                outcome: 'not-probed',
                reachableVersion: null,
            });
        }
    });

    it('a non-200, a throw and a timeout are all unreachable', async () => {
        const nonOk = (async () => ({ ok: false, json: async () => ({}) }) as unknown as Response) as typeof fetch;
        const throws = (async () => {
            throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch;
        // A fetch that IGNORES the abort signal, which is the hard case: the
        // probe must still settle. Found by this test — the first version
        // delegated the deadline to `fetch` and hung for the full jest timeout.
        const hangsIgnoringSignal = (async () =>
            new Promise<Response>(() => {})) as unknown as typeof fetch;

        expect((await probeSandboxRuntime('http://x', nonOk)).outcome).toBe('unreachable');
        expect((await probeSandboxRuntime('http://x', throws)).outcome).toBe('unreachable');
        // 1 ms rather than the 2 s default, so the test does not wait.
        expect(
            (await probeSandboxRuntime('http://x', hangsIgnoringSignal, 1)).outcome,
        ).toBe('unreachable');
    });

    it('a body with no usable version is its OWN outcome, not unreachable', async () => {
        // The gateway DID answer. An operator debugging a blank version needs
        // that distinction; collapsing it into `unreachable` would send them to
        // look at the network.
        for (const body of [{}, { version: 42 }, { version: '' }, { version: null }]) {
            const r = await probeSandboxRuntime('http://x', okJson(body));
            expect(r).toEqual({ outcome: 'answered-without-version', reachableVersion: null });
        }
    });

    it('never invents a version from anywhere but the body', async () => {
        // No fallback to the pinned release, the digest, or an env var. A
        // version this product already knows is not an observation.
        const r = await probeSandboxRuntime('http://x', okJson({ status: 'healthy' }));
        expect(r.reachableVersion).toBeNull();
    });

    it('unparseable JSON is unreachable, not a crash', async () => {
        const badJson = (async () =>
            ({
                ok: true,
                json: async () => {
                    throw new Error('not json');
                },
            }) as unknown as Response) as typeof fetch;
        expect((await probeSandboxRuntime('http://x', badJson)).outcome).toBe('unreachable');
    });
});

describe('the provenance row', () => {
    const declared = { configured: true, configDigest: 'sha256:abc', reachableVersion: '0.1.6' };

    it('states what was sent and what answered', async () => {
        expect(displayForProvenance(declared, '2026-10-30T06:00:00.000Z', 'answered')).toEqual({
            declared: true,
            configDigest: 'sha256:abc',
            appliedAtIso: '2026-10-30T06:00:00.000Z',
            reachability: 'answered',
            reportedVersion: '0.1.6',
        });
    });

    it('only an ANSWERED outcome may carry a version', () => {
        // Guarded in the display as well as in the probe, so a future caller
        // cannot pass a version beside `unreachable` and have it rendered.
        for (const outcome of ['not-probed', 'unreachable', 'answered-without-version'] as const) {
            const row = displayForProvenance(declared, null, outcome);
            expect(row.reportedVersion).toBeNull();
            expect(row.reachability).toBe(outcome);
        }
    });

    it('shows no digest when the deploy declared nothing', () => {
        const row = displayForProvenance(
            { configured: false, configDigest: 'sha256:leftover', reachableVersion: null },
            null,
            'not-probed',
        );
        expect(row).toMatchObject({ declared: false, configDigest: null });
    });

    it('carries NO field for a setting value — the whole point of the shape', () => {
        const row = displayForProvenance(declared, null, 'answered');
        // The issue contrasts "declared, digest …, applied … — gateway
        // reachable, reporting version 0.1.6" with "Telemetry: off". The second
        // is unrepresentable here because there is nowhere to put it, and this
        // asserts the shape rather than trusting the reading.
        expect(Object.keys(row).sort()).toEqual([
            'appliedAtIso',
            'configDigest',
            'declared',
            'reachability',
            'reportedVersion',
        ]);
    });
});

describe('the probe answer is reused, and its age is visible', () => {
    /*
        #4572. The admin page is `force-dynamic` and the gateway is TERMINATED
        most of the time by design, so every load was paying the full 2-second
        timeout to learn the same thing.

        The assertions that matter are about COUNTING calls, not about speed: a
        cache that is never consulted and a cache that works both render the
        same page.
    */
    const realUrl = 'http://10.132.0.28:8081';

    beforeEach(() => {
        jest.resetModules();
        process.env.SANDBOX_RUNTIME_HEALTH_URL = realUrl;
        process.env.SANDBOX_RUNTIME_CONFIG_DIGEST = 'sha256:' + 'a'.repeat(64);
    });

    const load = async (): Promise<{
        read: (f?: typeof fetch, now?: () => number) => Promise<{ probeOutcome: string; probedAtIso: string }>;
        reset: () => void;
    }> => {
        const mod = await import('@/app-layer/usecases/sandbox-runtime-config');
        return {
            read: mod.readSandboxRuntimeDeclarationWithProbe as never,
            reset: mod.resetProbeCacheForTests,
        };
    };

    it('probes ONCE across loads inside the TTL', async () => {
        const { read, reset } = await load();
        reset();
        let calls = 0;
        const fetchImpl = (async () => {
            calls += 1;
            return { ok: true, json: async () => ({ status: 'healthy', version: '0.1.6' }) } as unknown as Response;
        }) as unknown as typeof fetch;

        const t0 = 1_000_000;
        await read(fetchImpl, () => t0);
        await read(fetchImpl, () => t0 + 5_000);
        await read(fetchImpl, () => t0 + 29_999);
        expect(calls).toBe(1);
    });

    it('probes AGAIN once the TTL has passed', async () => {
        const { read, reset } = await load();
        reset();
        let calls = 0;
        const fetchImpl = (async () => {
            calls += 1;
            return { ok: true, json: async () => ({ status: 'healthy', version: '0.1.6' }) } as unknown as Response;
        }) as unknown as typeof fetch;

        const t0 = 2_000_000;
        await read(fetchImpl, () => t0);
        await read(fetchImpl, () => t0 + 30_000);
        expect(calls).toBe(2);
    });

    it('caches a FAILED probe too — the case that costs the timeout', async () => {
        // Caching only successes would leave the stall exactly where it hurts:
        // a stopped VM is the common case and the one that waits 2 seconds.
        const { read, reset } = await load();
        reset();
        let calls = 0;
        const refuses = (async () => {
            calls += 1;
            throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch;

        const t0 = 3_000_000;
        const first = await read(refuses, () => t0);
        const second = await read(refuses, () => t0 + 1_000);
        expect(first.probeOutcome).toBe('unreachable');
        expect(second.probeOutcome).toBe('unreachable');
        expect(calls).toBe(1);
    });

    it('does not answer a NEW url from a cache built against the old one', async () => {
        const { read, reset } = await load();
        reset();
        const seen: string[] = [];
        const fetchImpl = (async (u: string) => {
            seen.push(String(u));
            return { ok: true, json: async () => ({ status: 'healthy', version: '0.1.6' }) } as unknown as Response;
        }) as unknown as typeof fetch;

        const t0 = 4_000_000;
        await read(fetchImpl, () => t0);
        process.env.SANDBOX_RUNTIME_HEALTH_URL = 'http://10.132.0.99:8081';
        jest.resetModules();
        // Same module instance keeps the cache; the URL key is what invalidates.
        await read(fetchImpl, () => t0 + 1_000);
        expect(seen.length).toBe(2);
        expect(seen[0]).not.toBe(seen[1]);
    });

    it('reports WHEN it answered, so a reused verdict is visible as one', async () => {
        const { read, reset } = await load();
        reset();
        const fetchImpl = (async () =>
            ({ ok: true, json: async () => ({ status: 'healthy', version: '0.1.6' }) }) as unknown as Response) as typeof fetch;

        const t0 = 5_000_000;
        const first = await read(fetchImpl, () => t0);
        const reused = await read(fetchImpl, () => t0 + 10_000);
        // The SAME timestamp, not the second call's clock — which is the whole
        // point: the page must not imply the check was just taken.
        expect(reused.probedAtIso).toBe(first.probedAtIso);
        expect(reused.probedAtIso).toBe(new Date(t0).toISOString());
    });
});
