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
