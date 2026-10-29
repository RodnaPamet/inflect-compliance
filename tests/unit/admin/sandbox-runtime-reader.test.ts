/**
 * `readSandboxRuntimeDeclaration` — #3995.
 *
 * The property worth testing is NOT that the reader parses an environment
 * variable. It is that a DECLARED value can never leave this function wearing
 * an OBSERVED value's clothes, because that is the mistake the whole
 * sandbox-runtime surface exists to prevent: a v0.1.6 gateway exposes no
 * configuration read API, so anything this product reports about its running
 * configuration is a claim about a process nobody asked.
 *
 * So the load-bearing test here is the one asserting `reachableVersion` stays
 * null no matter what the environment says.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

import {
    readSandboxExecutionPlatformEnabled,
    readSandboxRuntimeDeclaration,
    sandboxedExecutionAvailability,
    REPORTING_CHANNELS,
    type ReportingChannelKey,
} from '@/app-layer/usecases/sandbox-runtime-config';

const DIGEST = 'sha256:3f1a0c9e';

/** Derived from the runtime list, never a hand-written literal. */
const ALL_KEYS: readonly ReportingChannelKey[] = REPORTING_CHANNELS.map((c) => c.key);

beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
});

describe('1. an unconfigured deploy says so, and says nothing else', () => {
    it('reports not configured when no digest is recorded', () => {
        const d = readSandboxRuntimeDeclaration();
        expect(d.configured).toBe(false);
        expect(d.configDigest).toBeNull();
    });

    it('declares nothing per channel — null, not false', () => {
        // The distinction a `boolean | null` map exists for. "This deploy
        // turned the channel off" and "this deploy never said" are different
        // answers, and collapsing them to false would report an absent
        // declaration as a positive assurance that nothing is sent.
        const d = readSandboxRuntimeDeclaration();
        for (const key of ALL_KEYS) expect(d.channels[key]).toBeNull();
    });

    it('ignores a channel list that arrives without a digest', () => {
        // A deploy that named channels but recorded no digest has not said
        // which configuration those channels belong to, so there is nothing to
        // report them against.
        mockEnv.SANDBOX_RUNTIME_CHANNELS = ALL_KEYS.join(',');
        const d = readSandboxRuntimeDeclaration();
        expect(d.configured).toBe(false);
        for (const key of ALL_KEYS) expect(d.channels[key]).toBeNull();
    });
});

describe('2. a declared value never becomes an observed one', () => {
    it('leaves reachableVersion null even when the environment supplies one', () => {
        // THE test in this file. `reachableVersion` means "the version the
        // runtime reported on its health endpoint". Nothing here probes a
        // health endpoint, so any non-null value would be a declaration
        // impersonating a reading — and would flip every channel row from
        // `unreachable` to `declared-not-observed`, telling an operator a
        // gateway confirmed something no gateway was asked.
        mockEnv.SANDBOX_RUNTIME_CONFIG_DIGEST = DIGEST;
        mockEnv.SANDBOX_RUNTIME_VERSION = '0.1.6';
        mockEnv.OPENSHELL_VERSION = '0.1.6';
        expect(readSandboxRuntimeDeclaration().reachableVersion).toBeNull();
    });

    it('is null in the configured case too, not merely when unconfigured', () => {
        // A positive control for the assertion above: if `reachableVersion`
        // were null only because nothing was configured, the test would pass
        // for the wrong reason.
        mockEnv.SANDBOX_RUNTIME_CONFIG_DIGEST = DIGEST;
        const d = readSandboxRuntimeDeclaration();
        expect(d.configured).toBe(true);
        expect(d.reachableVersion).toBeNull();
    });
});

describe('3. the channel list', () => {
    beforeEach(() => {
        mockEnv.SANDBOX_RUNTIME_CONFIG_DIGEST = DIGEST;
    });

    it('reports a named channel on and an unnamed one off', () => {
        const [first, ...rest] = ALL_KEYS;
        mockEnv.SANDBOX_RUNTIME_CHANNELS = first;
        const d = readSandboxRuntimeDeclaration();
        expect(d.channels[first]).toBe(true);
        for (const key of rest) expect(d.channels[key]).toBe(false);
    });

    it('covers exactly the runtime channel set, with no extra keys', () => {
        const d = readSandboxRuntimeDeclaration();
        expect(Object.keys(d.channels).sort()).toEqual([...ALL_KEYS].sort());
    });

    it('tolerates spacing and empty tokens', () => {
        mockEnv.SANDBOX_RUNTIME_CHANNELS = ` ${ALL_KEYS[0]} , , ${ALL_KEYS[1]} ,`;
        const d = readSandboxRuntimeDeclaration();
        expect(d.channels[ALL_KEYS[0]]).toBe(true);
        expect(d.channels[ALL_KEYS[1]]).toBe(true);
    });

    it('refuses the WHOLE declaration when a channel name is unknown', () => {
        // Not "ignore the token and report the rest". A deploy naming a channel
        // this build does not know means the list the page is about to present
        // as exhaustive is not — and an incomplete list of where data can go
        // reads exactly like a complete one.
        mockEnv.SANDBOX_RUNTIME_CHANNELS = `${ALL_KEYS[0]},syslog-firehose`;
        expect(() => readSandboxRuntimeDeclaration()).toThrow(/syslog-firehose/);
    });

    it('names the known set in the refusal, so the fix does not need this source', () => {
        mockEnv.SANDBOX_RUNTIME_CHANNELS = 'syslog-firehose';
        expect(() => readSandboxRuntimeDeclaration()).toThrow(new RegExp(ALL_KEYS[0]));
    });

    it('does NOT refuse a fully known list — the check can tell the two apart', () => {
        // The control for the two assertions above. A refusal that fired on
        // every input would satisfy them both while being useless.
        mockEnv.SANDBOX_RUNTIME_CHANNELS = ALL_KEYS.join(',');
        expect(() => readSandboxRuntimeDeclaration()).not.toThrow();
        const d = readSandboxRuntimeDeclaration();
        for (const key of ALL_KEYS) expect(d.channels[key]).toBe(true);
    });
});

describe('4. appliedAt is a record, not a guess', () => {
    beforeEach(() => {
        mockEnv.SANDBOX_RUNTIME_CONFIG_DIGEST = DIGEST;
    });

    it('parses a recorded timestamp', () => {
        mockEnv.SANDBOX_RUNTIME_APPLIED_AT = '2026-10-24T09:30:00.000Z';
        expect(readSandboxRuntimeDeclaration().appliedAt?.toISOString()).toBe(
            '2026-10-24T09:30:00.000Z',
        );
    });

    it('is null for an unparseable value rather than falling back to now', () => {
        // A wrong timestamp on "when this configuration was applied" is worse
        // than no timestamp: it would let a reader date an audit finding to a
        // configuration that was never applied then.
        mockEnv.SANDBOX_RUNTIME_APPLIED_AT = 'last Tuesday';
        expect(readSandboxRuntimeDeclaration().appliedAt).toBeNull();
    });
});

describe('5. the platform execution flag', () => {
    it("is true only for '1'", () => {
        mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
        expect(readSandboxExecutionPlatformEnabled()).toBe(true);
    });

    it("is false for '0'", () => {
        mockEnv.SANDBOX_EXECUTION_ENABLED = '0';
        expect(readSandboxExecutionPlatformEnabled()).toBe(false);
    });

    it('is false when absent, which is the safe direction', () => {
        // A deploy that has said nothing about sandboxed execution does not
        // have it. Reporting it as available would put an affordance over a
        // capability that is not installed.
        expect(readSandboxExecutionPlatformEnabled()).toBe(false);
    });

    it("does not treat the string 'false' as true", () => {
        // The `z.coerce.boolean()` trap, asserted at the reader as well as
        // avoided in the schema: coercion maps any non-empty string to true,
        // so a deploy writing "false" would enable the thing it disabled.
        mockEnv.SANDBOX_EXECUTION_ENABLED = 'false';
        expect(readSandboxExecutionPlatformEnabled()).toBe(false);
    });
});


describe('6. the availability gate — #3996, platform-only', () => {
    const DIGEST_SET = () => {
        mockEnv.SANDBOX_RUNTIME_CONFIG_DIGEST = DIGEST;
    };

    it('is not available when the platform has not enabled it', () => {
        DIGEST_SET();
        expect(sandboxedExecutionAvailability()).toEqual({
            available: false,
            reason: 'not-enabled',
        });
    });

    it('is not available when enabled with NO runtime declared', () => {
        mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
        expect(sandboxedExecutionAvailability()).toEqual({
            available: false,
            reason: 'no-runtime-declared',
        });
    });

    it('is available only when both the flag and a declared runtime are present', () => {
        mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
        DIGEST_SET();
        expect(sandboxedExecutionAvailability()).toEqual({ available: true, reason: null });
    });

    it('does not collapse the two unavailable reasons into one answer', () => {
        // The requirement #3996 states: a failure must say availability could
        // not be confirmed rather than that the feature is off. Asserted as a
        // DIFFERENCE, so it cannot be satisfied by relabelling one of them.
        mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
        const enabledNoRuntime = sandboxedExecutionAvailability();
        delete mockEnv.SANDBOX_EXECUTION_ENABLED;
        const notEnabled = sandboxedExecutionAvailability();

        expect(enabledNoRuntime.available).toBe(false);
        expect(notEnabled.available).toBe(false);
        expect(enabledNoRuntime.reason).not.toBe(notEnabled.reason);
        expect(enabledNoRuntime.reason).toBe('no-runtime-declared');
    });

    it('fails CLOSED across every combination — never a hopeful true', () => {
        // Derived rather than listed, so a future fourth input cannot slip
        // past by not being enumerated here.
        for (const flag of [undefined, '0', '1'] as const) {
            for (const digest of [undefined, DIGEST] as const) {
                for (const k of Object.keys(mockEnv)) delete mockEnv[k];
                if (flag !== undefined) mockEnv.SANDBOX_EXECUTION_ENABLED = flag;
                if (digest !== undefined) mockEnv.SANDBOX_RUNTIME_CONFIG_DIGEST = digest;

                const got = sandboxedExecutionAvailability();
                const shouldBeAvailable = flag === '1' && digest !== undefined;
                expect(got.available).toBe(shouldBeAvailable);
                // An available answer carries no reason; an unavailable one always does.
                expect(got.reason === null).toBe(shouldBeAvailable);
            }
        }
    });

    it('is SYNCHRONOUS, so there is no await to forget', () => {
        // #3996 asks that the prologue stay synchronous so a missing `await`
        // cannot weaken the gate. Platform-only lets the WHOLE function be
        // synchronous, and this asserts that rather than trusting the
        // signature: a Promise here would be truthy and `.available` would be
        // undefined, which reads as unavailable and would hide the mistake in
        // the safe direction — the worst place for it to hide.
        mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
        DIGEST_SET();
        const got: unknown = sandboxedExecutionAvailability();
        expect(got).not.toBeInstanceOf(Promise);
        expect(typeof (got as { then?: unknown }).then).toBe('undefined');
    });
});
