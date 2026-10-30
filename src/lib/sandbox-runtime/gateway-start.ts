/**
 * Start the gateway VM and wait until it answers — #4562.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE CALLER STARTS IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The gateway VM is stopped most of the time by design: its $5/month cap is a
 * runtime budget of about 38 hours, an idle timer takes it down after 20
 * minutes of no sandbox activity, and there is deliberately NO start schedule —
 * a day with no scan should cost nothing. Owner decision 2026-10-30: the caller
 * starts it and waits for `readyz`.
 *
 * The alternatives were a scheduler (which spends the budget on days with no
 * work) and leaving it manual (which means the collectors never run sandboxed
 * unattended).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS FAILS CLOSED, AND TODAY IT ALWAYS FAILS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Starting an instance needs the `compute` OAuth scope on the app VM, and the
 * app VM does not have it — scopes gate the metadata token regardless of IAM,
 * and changing them requires stopping the instance. `deploy/swap-app-service-
 * account.sh` is that operation and has not been run.
 *
 * So `not-permitted` is the expected outcome in production right now, and the
 * caller must treat it the way it treats an unreachable gateway: a refusal,
 * never a fallback to running the tool somewhere else. 4.2b settled that
 * direction — "a sandbox that cannot be created is a refusal".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FIVE OUTCOMES, BECAUSE THEY ARE NOT ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An operator debugging "the scan did not run" needs to know whether the host
 * refused, the credential refused, or nobody asked. Collapsing these into a
 * boolean is how a scope problem gets mistaken for an outage.
 *
 * @module lib/sandbox-runtime/gateway-start
 */

import { HEALTH_PATH, probeSandboxRuntime } from './health-probe';

export type StartOutcome =
    /** It was already up. No start was issued and nothing was spent. */
    | 'already-running'
    /** Start issued and `readyz` answered within the budget. */
    | 'started'
    /** The API refused — in production today this means the `compute` scope is absent. */
    | 'not-permitted'
    /** Start issued, `readyz` never answered inside the budget. */
    | 'timed-out'
    /** No metadata server, or it could not be reached. Local development. */
    | 'unavailable';

export interface StartResult {
    readonly outcome: StartOutcome;
    /** How long the caller waited, so a slow boot is visible in a log. */
    readonly waitedMs: number;
}

/** Measured on this VM: `instances start` to `readyz` 200 in about 45 seconds. */
export const START_WAIT_BUDGET_MS = 120_000;

/** How often to re-probe while waiting. */
export const START_POLL_INTERVAL_MS = 3_000;

const METADATA_TOKEN_URL =
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

export interface StartDeps {
    readonly fetchImpl?: typeof fetch;
    /** Injectable clock, so a test does not wait two minutes. */
    readonly nowMs?: () => number;
    /** Injectable sleep, same reason. */
    readonly sleep?: (ms: number) => Promise<void>;
    readonly budgetMs?: number;
}

/**
 * Start the gateway if it is not already answering, then wait for `readyz`.
 *
 * `healthUrl` absent means this deploy named no gateway, which is `unavailable`
 * rather than a failure — nobody was asked.
 */
export async function startGatewayAndWait(
    input: {
        readonly healthUrl: string | undefined;
        readonly project: string | undefined;
        readonly zone: string | undefined;
        readonly instance: string | undefined;
    },
    deps: StartDeps = {},
): Promise<StartResult> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const now = deps.nowMs ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const budget = deps.budgetMs ?? START_WAIT_BUDGET_MS;
    const began = now();

    const { healthUrl, project, zone, instance } = input;
    if (!healthUrl || !project || !zone || !instance) {
        return { outcome: 'unavailable', waitedMs: 0 };
    }

    // ALREADY RUNNING is checked first and costs one probe. Issuing a start
    // against a running instance is harmless but it also hides the common case
    // in the logs, and the common case during a burst of scans is "it is up".
    const first = await probeSandboxRuntime(healthUrl, fetchImpl);
    if (first.outcome === 'answered' || first.outcome === 'answered-without-version') {
        return { outcome: 'already-running', waitedMs: now() - began };
    }

    // The metadata token. Absent means this is not a GCE instance — local
    // development — and is reported as `unavailable`, not as a refusal.
    let token: string;
    try {
        const res = await fetchImpl(METADATA_TOKEN_URL, {
            headers: { 'Metadata-Flavor': 'Google' },
            cache: 'no-store',
        });
        if (!res.ok) return { outcome: 'unavailable', waitedMs: now() - began };
        const body = (await res.json()) as { access_token?: unknown };
        if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
            return { outcome: 'unavailable', waitedMs: now() - began };
        }
        token = body.access_token;
    } catch {
        return { outcome: 'unavailable', waitedMs: now() - began };
    }

    const startUrl =
        `https://compute.googleapis.com/compute/v1/projects/${project}` +
        `/zones/${zone}/instances/${instance}/start`;
    try {
        const res = await fetchImpl(startUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
        });
        // 403 is the expected production answer until the scope swap runs, and
        // 401 is a token the API would not take. Both are `not-permitted`: the
        // distinction is for the operator, and the reason is in the log either
        // way, but neither is something the caller can retry around.
        if (res.status === 401 || res.status === 403) {
            return { outcome: 'not-permitted', waitedMs: now() - began };
        }
        if (!res.ok) return { outcome: 'timed-out', waitedMs: now() - began };
    } catch {
        return { outcome: 'unavailable', waitedMs: now() - began };
    }

    // Poll `readyz`, not the instance's status. GCE reports RUNNING as soon as
    // the VM is scheduled, which is well before the gateway has bound its
    // ports — waiting on the instance state would hand the caller a host that
    // refuses connections. `readyz` is the thing the caller actually needs.
    while (now() - began < budget) {
        await sleep(START_POLL_INTERVAL_MS);
        const p = await probeSandboxRuntime(healthUrl, fetchImpl);
        if (p.outcome === 'answered' || p.outcome === 'answered-without-version') {
            return { outcome: 'started', waitedMs: now() - began };
        }
    }
    return { outcome: 'timed-out', waitedMs: now() - began };
}

/** The outcomes a caller may proceed on. Everything else is a refusal. */
export const START_OUTCOMES_READY: readonly StartOutcome[] = ['already-running', 'started'];

/** Does this outcome mean the gateway is answering now? */
export function gatewayIsReady(outcome: StartOutcome): boolean {
    return START_OUTCOMES_READY.includes(outcome);
}

export { HEALTH_PATH };
