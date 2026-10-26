/**
 * The sandbox-runtime admin rows (#3995, #3997, #3998, #3999).
 *
 *   1. EVERY KIND IS REACHABLE from some input. A kind no input can produce is
 *      a branch that cannot be wrong, which is the defect the AI-page ancestor
 *      of this module was written to avoid.
 *   2. NOTHING IS ACTIONABLE except the one switch this product owns. The other
 *      rows are another process's startup configuration or a value a CI gate
 *      holds in committed code.
 *   3. THE ORDER IS THE CONTRACT: a row un-actionable for two reasons reports
 *      the one that decides what to do.
 *   4. THE FOUR CHANNELS ARE FOUR, and the fourth has no chart key — which is
 *      the fact that makes this page better than reading `values.yaml`.
 */
import {
    displayForChannel,
    displayForEnforcement,
    displayForExecutionSwitch,
    RUNTIME_ROW_KINDS,
    type RuntimeRowKind,
    type RuntimeRowDisplay,
} from '../../../src/app/t/[tenantSlug]/(app)/admin/sandbox-runtime/sandbox-runtime-display';
import {
    ENFORCEMENT_SETTINGS,
    REPORTING_CHANNELS,
    type SandboxRuntimeDeclaration,
} from '@/app-layer/usecases/sandbox-runtime-config';

const declaration = (over: Partial<SandboxRuntimeDeclaration> = {}): SandboxRuntimeDeclaration => ({
    configured: true,
    configDigest: `sha256:${'a'.repeat(64)}`,
    appliedAt: new Date('2026-10-24T20:00:00.000Z'),
    reachableVersion: '0.1.5',
    channels: {
        'anonymous-telemetry': false,
        'otlp-traces': false,
        'ocsf-file': false,
        'ocsf-over-otlp': false,
    },
    ...over,
});

describe('1. every kind is reachable, and the set is exhausted', () => {
    it('each of the five kinds is produced by some input', () => {
        const produced = new Set<RuntimeRowKind>([
            displayForChannel('otlp-traces', declaration({ configured: false })).kind,
            displayForChannel('otlp-traces', declaration({ reachableVersion: null })).kind,
            displayForChannel('otlp-traces', declaration()).kind,
            displayForEnforcement().kind,
            displayForExecutionSwitch(true, false).kind,
        ]);
        expect([...produced].sort()).toEqual([...RUNTIME_ROW_KINDS].sort());
    });

    it('the declared set has no kind the functions cannot produce', () => {
        // The other direction. A kind listed for the renderer to exhaust but
        // unreachable from any input is a branch that cannot be wrong.
        expect(RUNTIME_ROW_KINDS).toHaveLength(5);
        expect(new Set(RUNTIME_ROW_KINDS).size).toBe(RUNTIME_ROW_KINDS.length);
    });
});

describe('2. nothing on this page is actionable', () => {
    it.each(REPORTING_CHANNELS.map((c) => c.key))('the %s channel is never actionable', (key) => {
        for (const d of [declaration(), declaration({ configured: false }), declaration({ reachableVersion: null })]) {
            expect(displayForChannel(key, d).actionable).toBe(false);
        }
    });

    it('an enforcement setting is never actionable, in any state', () => {
        expect(displayForEnforcement()).toEqual({ kind: 'set-in-code', actionable: false });
        expect(ENFORCEMENT_SETTINGS.map((s) => s.required)).toEqual(['enforce', 'hard_requirement']);
    });

    it('the execution row reports the platform state and offers no control', () => {
        // Owner ruling 2026-10-25: platform-only. Not a tenant switch, so not
        // actionable in ANY of its three states.
        expect(displayForExecutionSwitch(false, false)).toEqual({
            kind: 'not-configured',
            actionable: false,
        });
        expect(displayForExecutionSwitch(true, false)).toEqual({
            kind: 'unconfirmable',
            actionable: false,
        });
        expect(displayForExecutionSwitch(true, true)).toEqual({
            kind: 'declared-not-observed',
            actionable: false,
        });
    });

    it('"turned on with no runtime" is NOT reported as the feature being off', () => {
        // The distinction #3996 asks for, asserted as a difference rather than
        // as a label: the two un-available states must not collapse, because
        // "off" is the reassuring half of a contradiction and the half an
        // operator would act on.
        const enabledNoRuntime = displayForExecutionSwitch(true, false);
        const notEnabled = displayForExecutionSwitch(false, false);
        expect(enabledNoRuntime.kind).not.toBe(notEnabled.kind);
        expect(enabledNoRuntime.kind).toBe('unconfirmable');
    });

    it('NO row kind is actionable, in any state — this page is read-only', () => {
        // Inverted deliberately. `actionable` is now false everywhere, which
        // would make it dead weight if nothing asserted it; this turns the
        // always-false field into a guarded property, so adding a control to
        // this page fails here and forces the conversation rather than
        // shipping a button over a decision the page does not own.
        const every: RuntimeRowDisplay[] = [
            ...REPORTING_CHANNELS.flatMap((c) => [
                displayForChannel(c.key, declaration()),
                displayForChannel(c.key, declaration({ configured: false })),
                displayForChannel(c.key, declaration({ reachableVersion: null })),
            ]),
            displayForEnforcement(),
            displayForExecutionSwitch(false, false),
            displayForExecutionSwitch(true, false),
            displayForExecutionSwitch(true, true),
        ];
        expect(every.map((r) => r.actionable)).toEqual(every.map(() => false));
        // And the vocabulary itself no longer names a flippable kind.
        expect(RUNTIME_ROW_KINDS).not.toContain('tenant-switch');
    });
});

describe('3. the order is the contract', () => {
    it('an unconfigured deploy reports that, not the declaration or the reachability', () => {
        const d = declaration({ configured: false, reachableVersion: null, configDigest: null });
        expect(displayForChannel('ocsf-file', d).kind).toBe('not-configured');
    });

    it('an unreachable runtime is reported BEFORE what was declared to it', () => {
        // A reader must not be told what was declared to something that may not
        // be running.
        const d = declaration({ reachableVersion: null });
        expect(displayForChannel('ocsf-file', d).kind).toBe('unreachable');
    });

    it('a configured, reachable runtime reports declared-not-observed — never "on" or "off"', () => {
        const d = declaration({ channels: { ...declaration().channels, 'anonymous-telemetry': true } });
        const row = displayForChannel('anonymous-telemetry', d);
        expect(row.kind).toBe('declared-not-observed');
        // The channel's declared value is true, and the row still does not
        // claim the runtime is using it. That is the whole point.
        expect(d.channels['anonymous-telemetry']).toBe(true);
        expect(row.kind).not.toBe('unconfirmable');
    });

    it('enforcement stays set-in-code even when the runtime is unreachable', () => {
        // The one departure from the channel ordering, and it is deliberate:
        // the gateway is not the authority on where that value lives.
        expect(displayForEnforcement().kind).toBe('set-in-code');
    });
});

describe('4. the four reporting channels, and the one with no chart key', () => {
    it('declares exactly four', () => {
        expect(REPORTING_CHANNELS).toHaveLength(4);
        expect(REPORTING_CHANNELS.map((c) => c.key)).toEqual([
            'anonymous-telemetry',
            'otlp-traces',
            'ocsf-file',
            'ocsf-over-otlp',
        ]);
    });

    it('only anonymous telemetry defaults ON — which is why the page exists', () => {
        const on = REPORTING_CHANNELS.filter((c) => c.defaultsOn).map((c) => c.key);
        expect(on).toEqual(['anonymous-telemetry']);
    });

    it('OCSF-over-OTLP has NO chart key, and every other channel has one', () => {
        const byKey = Object.fromEntries(REPORTING_CHANNELS.map((c) => [c.key, c]));
        expect(byKey['ocsf-over-otlp'].chartKey).toBeNull();
        for (const k of ['anonymous-telemetry', 'otlp-traces', 'ocsf-file'] as const) {
            expect(byKey[k].chartKey).toMatch(/^server\./);
        }
        // It is reachable by environment variable only — the reason a reader of
        // `values.yaml` cannot find this egress path.
        expect(byKey['ocsf-over-otlp'].envVars).toContain('OPENSHELL_OTLP_OCSF_ENDPOINT');
    });

    it('every channel names at least one environment variable, and none is shared', () => {
        const all = REPORTING_CHANNELS.flatMap((c) => c.envVars);
        /*
            SEVEN, not eight. The first version of this assertion said eight,
            carried from a `strings` scan of the gateway binary that reported
            eight reporting-related `OPENSHELL_*` names — one of which,
            `OPENSHELL_TELEMETRY_ENABLEDI`, is a trailing character from an
            adjacent string rather than a variable. I had already identified it
            as an artifact when I made that measurement and then reused the
            inflated total anyway.

            The seven real ones: TELEMETRY_ENABLED, TELEMETRY_ENDPOINT,
            OTLP_ENDPOINT, OCSF_JSON, OCSF_LOG_DIR, OTLP_OCSF_ENDPOINT,
            OTLP_OCSF_SCHEMA_VERSION.
        */
        expect(all.length).toBe(7);
        // A variable governing two channels would make one row's state
        // unexplainable from its own name.
        expect(new Set(all).size).toBe(all.length);
        for (const c of REPORTING_CHANNELS) expect(c.envVars.length).toBeGreaterThan(0);
    });
});
