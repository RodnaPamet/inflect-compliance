/**
 * Binding the sandbox runtime's declared configuration to THIS deploy's
 * environment (#3995).
 *
 * The declarations, their vocabulary and the parsing live in
 * `@/lib/sandbox-runtime/declarations` — pure, and safe in a browser bundle,
 * which is what the admin page's client island needs. This module is the thin
 * env-reading layer on top, and re-exports the vocabulary so existing importers
 * and the guards that range over it keep one import path.
 */
import { env } from '@/env';
import {
    parseDeclaredChannels,
    type SandboxRuntimeDeclaration,
} from '@/lib/sandbox-runtime/declarations';

export {
    ENFORCEMENT_SETTINGS,
    REPORTING_CHANNELS,
    parseDeclaredChannels,
} from '@/lib/sandbox-runtime/declarations';
export type {
    ReportingChannel,
    ReportingChannelKey,
    SandboxRuntimeDeclaration,
} from '@/lib/sandbox-runtime/declarations';

/**
 * What this deploy DECLARED, read from its own validated environment.
 *
 * ═══ WHY `reachableVersion` IS ALWAYS null HERE ═══
 *
 * Because nothing in this product observes it. The field means "the version the
 * runtime reported on its health endpoint", and populating it from an
 * environment variable would dress a DECLARED value in an OBSERVED one's
 * clothes — the single failure this whole surface exists to prevent, and the
 * one `declared-not-observed` was added to the display vocabulary for.
 *
 * A reader that returned a version from env would make every channel row render
 * `declared-not-observed` instead of `unreachable`, which tells an operator that
 * a gateway confirmed something no gateway was asked. When a real health probe
 * lands it supplies this field; until then `null` is not a gap, it is the
 * measurement.
 */
export function readSandboxRuntimeDeclaration(): SandboxRuntimeDeclaration {
    const digest = env.SANDBOX_RUNTIME_CONFIG_DIGEST;
    const appliedAtRaw = env.SANDBOX_RUNTIME_APPLIED_AT;

    // The DIGEST is what makes a deploy "configured". Not the channel list: a
    // deploy that named channels but recorded no digest has not told us what
    // configuration those channels belong to, so there is nothing to report
    // them against.
    const configured = typeof digest === 'string' && digest.length > 0;

    // An unparseable date is null, not today. A wrong timestamp on "when this
    // configuration was applied" is worse than no timestamp: it would let a
    // reader date an audit finding to a configuration never applied then.
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
        channels: parseDeclaredChannels(env.SANDBOX_RUNTIME_CHANNELS, configured),
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
