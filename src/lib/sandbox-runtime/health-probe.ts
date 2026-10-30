/**
 * Ask the gateway what version answered — 5.6e (#4000).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROBE THE DECLARATION READER WAS WAITING FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `readSandboxRuntimeDeclaration` has carried `reachableVersion: null` with a
 * note saying why: "populating it from an environment variable would dress a
 * DECLARED value in an OBSERVED one's clothes… When a real health probe lands
 * it supplies this field; until then `null` is not a gap, it is the
 * measurement." This is that probe.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `/readyz`, NOT `/healthz` — MEASURED, AND THE DIFFERENCE IS THE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both answer 200 on a healthy gateway. Only one carries a version:
 *
 *     GET /readyz   200  {"status":"healthy","version":"0.1.6",
 *                         "checks":{"database":{"status":"healthy",...}}}
 *     GET /healthz   200  (empty body)
 *     GET /livez     404
 *     GET /version   404
 *
 * So a probe pointed at `/healthz` would establish reachability and report no
 * version — and `reachableVersion: null` is indistinguishable from an
 * unreachable gateway, which would turn a working probe into a silent one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE VERSION COMES FROM THE BODY OR NOWHERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No fallback to a pinned constant, an env var, or the digest. A version this
 * product already knows is not an observation, and the one failure this whole
 * surface exists to prevent is a declared value wearing an observed one's
 * clothes. If the body does not carry a string `version`, the answer is `null`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNREACHABLE IS THE NORMAL CASE, NOT AN ERROR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The gateway VM is deliberately stopped most of the time — its $5/month cap is
 * a runtime budget of about 38 hours a month, so an idle timer shuts it down
 * (#4448). A probe that treated absence as a fault would make the admin page
 * cry wolf once a day. `null` renders as the existing `unreachable` kind, which
 * is the true statement: nobody asked, or nobody answered.
 *
 * @module lib/sandbox-runtime/health-probe
 */

/** What a probe can conclude. Four outcomes, because they are not one. */
export type ProbeOutcome =
    /** No health URL is configured, so no probe was attempted. */
    | 'not-probed'
    /** Answered, and the body carried a version. */
    | 'answered'
    /** Answered, but no usable `version` in the body — a gateway we cannot name. */
    | 'answered-without-version'
    /** Did not answer in time, refused, or returned a non-200. */
    | 'unreachable';

export interface ProbeResult {
    readonly outcome: ProbeOutcome;
    /** The version the gateway reported. `null` for every outcome but `answered`. */
    readonly reachableVersion: string | null;
}

/** The health path that carries a version. See the module docblock. */
export const HEALTH_PATH = '/readyz';

/** Short on purpose: an admin page must not block on a stopped VM. */
export const PROBE_TIMEOUT_MS = 2_000;

const NOT_PROBED: ProbeResult = { outcome: 'not-probed', reachableVersion: null };
const UNREACHABLE: ProbeResult = { outcome: 'unreachable', reachableVersion: null };

/**
 * Probe the gateway's health endpoint.
 *
 * `fetchImpl` and `timeoutMs` are parameters so a test can drive every arm
 * without a gateway and without a timer, which is the same reason
 * `openShellToolExecutor` takes its transport.
 */
export async function probeSandboxRuntime(
    baseUrl: string | undefined,
    fetchImpl: typeof fetch = fetch,
    timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
    // An absent URL is NOT unreachable. Nobody was asked, and reporting a
    // gateway as unreachable because this deploy never named one would be a
    // claim about someone else's infrastructure.
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) return NOT_PROBED;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    /*
        THE DEADLINE IS ENFORCED HERE, NOT DELEGATED TO `fetch`.

        Passing `signal` alone is not enough, and a test found it: a `fetch`
        that ignores the signal never settles, so the probe never settles, and
        an admin page waits forever on a stopped VM. The real `fetch` does
        honour it — but "the callee cooperates" is an assumption, and this is
        the one call on a page whose whole subject is a host that is usually
        off.

        So the signal is still sent (it lets a cooperating fetch release its
        socket immediately) and the race is what guarantees the page returns.
    */
    const deadline = new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(UNREACHABLE);
        }, timeoutMs);
    });

    const attempt = async (): Promise<ProbeResult> => {
        const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${HEALTH_PATH}`, {
            signal: controller.signal,
            // No credentials: the health port is the UNAUTHENTICATED one by
            // design, and sending anything would be the wrong habit on a port
            // whose whole character is that it needs nothing.
            cache: 'no-store',
        });
        if (!res.ok) return UNREACHABLE;

        const body: unknown = await res.json();
        const version =
            typeof body === 'object' && body !== null && 'version' in body
                ? (body as { version: unknown }).version
                : undefined;

        // A non-string, or an empty string, is not a version. Reported as its
        // own outcome rather than as unreachable: the gateway DID answer, and
        // an operator debugging a blank version needs to know the difference.
        if (typeof version !== 'string' || version.length === 0) {
            return { outcome: 'answered-without-version', reachableVersion: null };
        }
        return { outcome: 'answered', reachableVersion: version };
    };

    try {
        // Timeout, DNS, refused connection, unparseable JSON — all the same
        // conclusion, and none of them a reason to fail the page.
        return await Promise.race([attempt().catch(() => UNREACHABLE), deadline]);
    } finally {
        clearTimeout(timer);
    }
}
