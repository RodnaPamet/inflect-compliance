/**
 * #4562: the caller starts the gateway and waits for `readyz`.
 *
 * Every arm is driven without a VM, a timer or a metadata server, which is the
 * same reason `openShellToolExecutor` takes its transport as a parameter.
 *
 * @module unit/admin/gateway-start
 */

import {
    START_OUTCOMES_READY,
    gatewayIsReady,
    startGatewayAndWait,
    type StartOutcome,
} from '@/lib/sandbox-runtime/gateway-start';

const TARGET = {
    healthUrl: 'http://10.132.0.28:8081',
    project: 'p',
    zone: 'z',
    instance: 'openshell-gateway',
};

const READY_BODY = { status: 'healthy', version: '0.1.6' };

/** A fetch that answers each URL shape from a script. */
function scripted(plan: {
    readonly readyz: Array<'ok' | 'refused'>;
    readonly token?: 'ok' | 'missing' | 'throw';
    readonly start?: number;
}): { fetchImpl: typeof fetch; counts: { readyz: number; start: number } } {
    const counts = { readyz: 0, start: 0 };
    let i = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/computeMetadata/')) {
            if (plan.token === 'throw') throw new Error('no metadata server');
            if (plan.token === 'missing') return { ok: true, json: async () => ({}) } as unknown as Response;
            return { ok: true, json: async () => ({ access_token: 't' }) } as unknown as Response;
        }
        if (u.endsWith('/start') && init?.method === 'POST') {
            counts.start += 1;
            const s = plan.start ?? 200;
            return { ok: s >= 200 && s < 300, status: s, json: async () => ({}) } as unknown as Response;
        }
        // readyz
        counts.readyz += 1;
        const step = plan.readyz[Math.min(i++, plan.readyz.length - 1)];
        if (step === 'refused') throw new Error('ECONNREFUSED');
        return { ok: true, json: async () => READY_BODY } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, counts };
}

/** A clock that advances by the sleeps, so the budget is reached deterministically. */
function fakeClock(): { nowMs: () => number; sleep: (ms: number) => Promise<void> } {
    let t = 1_000_000;
    return { nowMs: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('starting the gateway', () => {
    it('already-running costs ONE probe and issues no start', async () => {
        // The common case during a burst of scans. Issuing a start against a
        // running instance is harmless but hides the common case in the log.
        const { fetchImpl, counts } = scripted({ readyz: ['ok'] });
        const r = await startGatewayAndWait(TARGET, { fetchImpl, ...fakeClock() });
        expect(r.outcome).toBe('already-running');
        expect(counts).toEqual({ readyz: 1, start: 0 });
    });

    it('starts it and reports `started` once readyz answers', async () => {
        const { fetchImpl, counts } = scripted({ readyz: ['refused', 'refused', 'ok'] });
        const r = await startGatewayAndWait(TARGET, { fetchImpl, ...fakeClock() });
        expect(r.outcome).toBe('started');
        expect(counts.start).toBe(1);
        // It waited rather than returning instantly.
        expect(r.waitedMs).toBeGreaterThan(0);
    });

    it('a 403 is NOT-PERMITTED — the expected production answer today', async () => {
        /*
            Starting an instance needs the `compute` OAuth scope, and the app VM
            does not have it: scopes gate the metadata token regardless of IAM,
            and changing them requires stopping the instance.
            `deploy/swap-app-service-account.sh` is that operation and has not
            been run. So this arm is the live behaviour, not a hypothetical.
        */
        const { fetchImpl } = scripted({ readyz: ['refused'], start: 403 });
        const r = await startGatewayAndWait(TARGET, { fetchImpl, ...fakeClock() });
        expect(r.outcome).toBe('not-permitted');
    });

    it('a 401 is also not-permitted — a token the API would not take', async () => {
        const { fetchImpl } = scripted({ readyz: ['refused'], start: 401 });
        expect((await startGatewayAndWait(TARGET, { fetchImpl, ...fakeClock() })).outcome).toBe(
            'not-permitted',
        );
    });

    it('no metadata server is UNAVAILABLE, not a refusal', async () => {
        // Local development. Nobody was asked, so reporting a refusal would be
        // a claim about a credential that was never offered.
        for (const token of ['throw', 'missing'] as const) {
            const { fetchImpl } = scripted({ readyz: ['refused'], token });
            expect((await startGatewayAndWait(TARGET, { fetchImpl, ...fakeClock() })).outcome).toBe(
                'unavailable',
            );
        }
    });

    it('an unnamed gateway is unavailable and costs nothing', async () => {
        // A deploy that named no gateway must not be reported as one that
        // refused — and must not even probe.
        const { fetchImpl, counts } = scripted({ readyz: ['ok'] });
        for (const missing of [
            { ...TARGET, healthUrl: undefined },
            { ...TARGET, project: undefined },
            { ...TARGET, zone: undefined },
            { ...TARGET, instance: undefined },
        ]) {
            const r = await startGatewayAndWait(missing, { fetchImpl, ...fakeClock() });
            expect(r).toEqual({ outcome: 'unavailable', waitedMs: 0 });
        }
        expect(counts).toEqual({ readyz: 0, start: 0 });
    });

    it('times out rather than waiting forever when readyz never answers', async () => {
        const { fetchImpl } = scripted({ readyz: ['refused'] });
        const r = await startGatewayAndWait(TARGET, {
            fetchImpl,
            ...fakeClock(),
            budgetMs: 15_000,
        });
        expect(r.outcome).toBe('timed-out');
        expect(r.waitedMs).toBeGreaterThanOrEqual(15_000);
    });

    it('polls readyz, NOT the instance state', async () => {
        /*
            GCE reports RUNNING as soon as the VM is scheduled, well before the
            gateway has bound its ports. Waiting on instance state would hand
            the caller a host that refuses connections — so the only state this
            module ever reads is readyz, and it never calls instances.get.
        */
        /*
            THE INPUT MUST REACH THE POLL LOOP, and the first version of this
            test did not. It let readyz answer immediately, so the function
            returned `already-running` and never entered the loop — the test
            passed while an instances.get added to that loop went unnoticed.
            Capable of failing, aimed one level off.

            So readyz REFUSES twice here, which forces the start and two poll
            iterations before it answers.
        */
        const seen: string[] = [];
        let probes = 0;
        const fetchImpl = (async (url: string, init?: RequestInit) => {
            seen.push(String(url));
            const u = String(url);
            if (u.includes('/computeMetadata/')) return { ok: true, json: async () => ({ access_token: 't' }) } as unknown as Response;
            if (u.endsWith('/start') && init?.method === 'POST') return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
            probes += 1;
            if (probes <= 2) throw new Error('ECONNREFUSED');
            return { ok: true, json: async () => READY_BODY } as unknown as Response;
        }) as unknown as typeof fetch;

        const r = await startGatewayAndWait(TARGET, { fetchImpl, ...fakeClock() });
        // The loop really ran, which is what makes the assertion below mean
        // something: `already-running` would prove nothing.
        expect(r.outcome).toBe('started');
        expect(probes).toBeGreaterThanOrEqual(3);
        // No bare instances GET anywhere — only the start POST and readyz.
        const bareGets = seen.filter(
            (u) => u.includes('/instances/') && !u.endsWith('/start'),
        );
        expect(bareGets).toEqual([]);
    });

    it('only two outcomes let a caller proceed', () => {
        // Everything else is a refusal. 4.2b settled the direction: a sandbox
        // that cannot be created is a refusal, never a fallback.
        expect([...START_OUTCOMES_READY].sort()).toEqual(['already-running', 'started']);
        const all: StartOutcome[] = [
            'already-running',
            'started',
            'not-permitted',
            'timed-out',
            'unavailable',
        ];
        expect(all.filter(gatewayIsReady).sort()).toEqual(['already-running', 'started']);
        expect(all.filter((o) => !gatewayIsReady(o)).sort()).toEqual([
            'not-permitted',
            'timed-out',
            'unavailable',
        ]);
    });
});
