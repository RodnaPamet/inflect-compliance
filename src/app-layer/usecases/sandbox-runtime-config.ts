/**
 * THE SANDBOX RUNTIME'S DECLARED CONFIGURATION — never its effective state.
 *
 * #3995. The distinction in that sentence is the whole module, and it comes
 * from a measurement rather than a preference: a running OpenShell v0.1.5
 * gateway exposes NO configuration read API. `healthz` and `readyz` are the
 * only routes on its health port; `config`, `configz`, `version` and
 * `/api/v1/config` all answer 404; none of its 39 metric lines names a
 * configuration value. Configuration is read at startup, with precedence
 * CLI > environment > file.
 *
 * So nothing in this product can ask a gateway what it is running with. What it
 * can do is report what was DECLARED to one, and say which that is. A page
 * rendering "Telemetry: off" would be asserting knowledge of a remote process's
 * internal state that no API provides — the launcher defect (#3909) at a larger
 * scale, where a control read as confirmed while nothing had verified it.
 *
 * ── THE FOUR CHANNELS ARE FOUR, NOT ONE ─────────────────────────────────
 *
 * The roadmap named `server.telemetryEnabled` and read as though it governed
 * outbound reporting. Verified against the v0.1.5 Helm chart and the gateway
 * binary, it governs one of four:
 *
 *   • anonymous telemetry — DEFAULT ON, gateway and the sandbox supervisors it
 *     launches, `server.telemetryEnabled` / `OPENSHELL_TELEMETRY_ENABLED`
 *   • OTLP traces — off, `server.otlp.endpoint` / `OPENSHELL_OTLP_ENDPOINT`
 *   • OCSF JSONL to a file — off, `server.ocsfLog.*` / `OPENSHELL_OCSF_JSON`
 *   • OCSF over OTLP — off, and WITH NO KEY ANYWHERE IN THE CHART:
 *     `OPENSHELL_OTLP_OCSF_ENDPOINT` only
 *
 * The fourth is why this page earns its place. It is an egress path for
 * security events, settable by environment variable, that cannot be found by
 * reading `values.yaml` — which is how a Helm deployment review enumerates
 * where data can go.
 *
 * Setting only the switch the roadmap named does leave a gateway that reports
 * nothing TODAY, because the other three happen to default off. They are
 * separate switches, so pointing a collector at `server.otlp.endpoint` later
 * reopens egress without touching the setting that recorded the intent.
 */
import { env } from '@/env';

/** One reporting channel the runtime can send on. */
export interface ReportingChannel {
    readonly key: ReportingChannelKey;
    /** The Helm chart key, or null when the chart has none — which is itself the finding. */
    readonly chartKey: string | null;
    /** The environment variables that govern it. The chart is not the only surface. */
    readonly envVars: readonly string[];
    /** What the channel does when nothing is configured. */
    readonly defaultsOn: boolean;
}

export type ReportingChannelKey = 'anonymous-telemetry' | 'otlp-traces' | 'ocsf-file' | 'ocsf-over-otlp';

/**
 * The four, declared once. `tests/guards` holds this list against the eight
 * environment variables the gateway binary knows, so a fifth channel in a
 * future release fails a guard rather than going unlisted — which is the
 * failure that would make this page worse than no page, because a reader
 * concludes "these are the ways data leaves" from a list that quietly stopped
 * being exhaustive.
 */
export const REPORTING_CHANNELS: readonly ReportingChannel[] = [
    {
        key: 'anonymous-telemetry',
        chartKey: 'server.telemetryEnabled',
        envVars: ['OPENSHELL_TELEMETRY_ENABLED', 'OPENSHELL_TELEMETRY_ENDPOINT'],
        defaultsOn: true,
    },
    {
        key: 'otlp-traces',
        chartKey: 'server.otlp.endpoint',
        envVars: ['OPENSHELL_OTLP_ENDPOINT'],
        defaultsOn: false,
    },
    {
        key: 'ocsf-file',
        chartKey: 'server.ocsfLog.enabled',
        envVars: ['OPENSHELL_OCSF_JSON', 'OPENSHELL_OCSF_LOG_DIR'],
        defaultsOn: false,
    },
    {
        key: 'ocsf-over-otlp',
        // No chart key exists. Not an omission here: `values.yaml` is 40,742
        // bytes with a `server:` block spanning lines 318-613 and has none.
        chartKey: null,
        envVars: ['OPENSHELL_OTLP_OCSF_ENDPOINT', 'OPENSHELL_OTLP_OCSF_SCHEMA_VERSION'],
        defaultsOn: false,
    },
] as const;

/**
 * The two settings a committed policy must carry, which this page renders
 * READ-ONLY and never offers to change.
 *
 * Phase 5 requires every committed policy to set both, checked mechanically in
 * CI. A control that could flip either here would turn that check into a
 * statement about a FILE rather than about the running system: the gate would
 * keep passing while the property it guarantees was gone, which is the worst
 * version of the failure — a guard that cannot express what it exists to catch.
 */
export const ENFORCEMENT_SETTINGS = [
    { key: 'enforcement', required: 'enforce', policyPath: 'network_policies.*.endpoints[].enforcement' },
    { key: 'landlock-compatibility', required: 'hard_requirement', policyPath: 'landlock.compatibility' },
] as const;

/** What the deploy declared, and whether the runtime answered. Never what it is using. */
export interface SandboxRuntimeDeclaration {
    /** Whether this deploy declares a sandbox runtime at all. */
    readonly configured: boolean;
    /** `sha256:` over the configuration the deploy applied, recorded at deploy time. */
    readonly configDigest: string | null;
    /** When that configuration was applied. */
    readonly appliedAt: Date | null;
    /** The version the runtime reported on its health endpoint, if it answered. */
    readonly reachableVersion: string | null;
    /** Declared value per channel: true, false, or null when the deploy declares nothing. */
    readonly channels: Readonly<Record<ReportingChannelKey, boolean | null>>;
}

/**
 * What this deploy DECLARED, read from its own validated environment.
 *
 * ═══ WHY `reachableVersion` IS ALWAYS null HERE ═══
 *
 * Because nothing in this product observes it. The field means "the version the
 * runtime reported on its health endpoint", and populating it from an
 * environment variable would dress a DECLARED value in an OBSERVED one's
 * clothes — the single failure this whole module exists to prevent, and the one
 * `declared-not-observed` was added to the display vocabulary for.
 *
 * A reader that returned a version from env would make every channel row render
 * `declared-not-observed` instead of `unreachable`, which tells an operator that
 * a gateway confirmed something no gateway was asked. When a real health probe
 * lands it supplies this field; until then `null` is not a gap, it is the
 * measurement.
 *
 * ═══ AN UNKNOWN CHANNEL KEY REFUSES EVERYTHING ═══
 *
 * Not "ignore the token and report the rest". A deploy naming a channel this
 * build does not know is either a newer runtime or a typo, and both mean the
 * list this page is about to present as exhaustive is not. Refusing is the same
 * rule the harness report applies to an unknown criterion.
 */
export function readSandboxRuntimeDeclaration(): SandboxRuntimeDeclaration {
    const digest = env.SANDBOX_RUNTIME_CONFIG_DIGEST;
    const appliedAtRaw = env.SANDBOX_RUNTIME_APPLIED_AT;
    const channelsRaw = env.SANDBOX_RUNTIME_CHANNELS;

    // The DIGEST is what makes a deploy "configured". Not the channel list: a
    // deploy that named channels but recorded no digest has not told us what
    // configuration those channels belong to, so there is nothing to report
    // them against.
    const configured = typeof digest === 'string' && digest.length > 0;

    const declaredOn = new Set<string>(
        typeof channelsRaw === 'string'
            ? channelsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
            : [],
    );
    const known = new Set<string>(REPORTING_CHANNELS.map((c) => c.key));
    const unknown = [...declaredOn].filter((k) => !known.has(k));
    if (unknown.length > 0) {
        throw new Error(
            `SANDBOX_RUNTIME_CHANNELS names ${unknown.length} channel(s) this build does not know: ` +
                `${unknown.sort().join(', ')}. Known: ${[...known].sort().join(', ')}.`,
        );
    }

    // `null` where the deploy declares NOTHING about a channel, distinct from
    // an explicit false. A reader must be able to tell "this deploy turned the
    // channel off" from "this deploy never said" — proto3's zero-value problem,
    // and the reason this map is `boolean | null` rather than `boolean`.
    const channels = Object.fromEntries(
        REPORTING_CHANNELS.map((c) => [c.key, configured ? declaredOn.has(c.key) : null]),
    ) as Record<ReportingChannelKey, boolean | null>;

    // An unparseable date is null, not today. A wrong timestamp on "when this
    // configuration was applied" is worse than no timestamp.
    let appliedAt: Date | null = null;
    if (typeof appliedAtRaw === 'string' && appliedAtRaw.length > 0) {
        const parsed = new Date(appliedAtRaw);
        if (!Number.isNaN(parsed.getTime())) appliedAt = parsed;
    }

    return {
        configured,
        configDigest: configured ? digest : null,
        appliedAt,
        reachableVersion: null,
        channels,
    };
}

/**
 * Whether the DEPLOY permits sandboxed execution at all — the platform half of
 * the switch #3996 owns.
 *
 * Absent reads as false, and that is the safe direction here: a deploy that has
 * said nothing about sandboxed execution does not have it, and reporting it as
 * available would put an affordance over a capability that is not installed.
 */
export function readSandboxExecutionPlatformEnabled(): boolean {
    return env.SANDBOX_EXECUTION_ENABLED === '1';
}
