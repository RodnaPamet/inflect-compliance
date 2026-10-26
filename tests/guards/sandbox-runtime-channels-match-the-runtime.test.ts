/**
 * THE CHANNEL LIST IS EXHAUSTIVE, OR IT IS WORSE THAN NO LIST (#4001).
 *
 * `REPORTING_CHANNELS` is what the admin page renders as "the ways this runtime
 * can send data". A reader draws a conclusion from it that a list which quietly
 * stopped being complete does not support — and that is the specific failure
 * which would make the page harmful rather than merely stale, because an
 * incomplete enumeration of egress paths reads exactly like a complete one.
 *
 * So this guard holds the list against the gateway's own vocabulary, and it
 * fails in BOTH directions:
 *
 *   • a channel naming an environment variable the runtime does not define —
 *     the page would describe a control that does not exist;
 *   • a reporting variable the runtime defines that no channel claims — the
 *     page would omit an egress path, which is the dangerous direction.
 *
 * ── WHY THE VOCABULARY IS COMMITTED AND NOT PROBED ──────────────────────
 *
 * The honest source would be the gateway binary, and this guard deliberately
 * does not read it. A guard that shelled out to `strings` against a binary
 * under `~/openshell` would pass or fail on whether a developer happened to
 * have a release unpacked, which is not a property of this repository. It would
 * also be unrunnable in CI and on any machine but one.
 *
 * So the vocabulary below is COMMITTED, with the release it was read from, and
 * this guard holds the product's list against it. Re-pinning the release means
 * re-reading the vocabulary, which is the same discipline as the vendored
 * skills' manifest.
 */
import { REPORTING_CHANNELS } from '@/app-layer/usecases/sandbox-runtime-config';

/**
 * Every reporting-related `OPENSHELL_*` variable the v0.1.5 gateway defines.
 *
 * Read from `openshell-gateway` 0.1.5 (commit bdb956f2) by extracting
 * `OPENSHELL_[A-Z0-9_]+` and splitting on the prefix, because the binary's
 * string table runs adjacent names together — an unsplit scan reports
 * concatenations as if they were variables.
 *
 * SEVEN, not eight. A naive scan also yields
 * `OPENSHELL_TELEMETRY_ENABLEDI`, which is `OPENSHELL_TELEMETRY_ENABLED`
 * followed by the first character of the next string. It is recorded here
 * because the artifact is reproducible, and a future re-read that counts eight
 * has not found a new variable.
 */
const RUNTIME_REPORTING_VARS = [
    'OPENSHELL_OCSF_JSON',
    'OPENSHELL_OCSF_LOG_DIR',
    'OPENSHELL_OTLP_ENDPOINT',
    'OPENSHELL_OTLP_OCSF_ENDPOINT',
    'OPENSHELL_OTLP_OCSF_SCHEMA_VERSION',
    'OPENSHELL_TELEMETRY_ENABLED',
    'OPENSHELL_TELEMETRY_ENDPOINT',
] as const;

/** The artifact a naive scan produces, kept so a re-read can recognise it. */
const KNOWN_SCAN_ARTIFACTS = ['OPENSHELL_TELEMETRY_ENABLEDI'] as const;

describe('the reporting channels match the runtime that has them', () => {
    const claimed = REPORTING_CHANNELS.flatMap((c) => c.envVars);

    it('reads a list with channels in it', () => {
        // The denominator. Both set comparisons below are satisfied by an empty
        // list against an empty vocabulary.
        expect(REPORTING_CHANNELS.length).toBeGreaterThanOrEqual(4);
        expect(RUNTIME_REPORTING_VARS.length).toBe(7);
    });

    it('claims no variable the runtime does not define', () => {
        const unknown = claimed.filter((v) => !(RUNTIME_REPORTING_VARS as readonly string[]).includes(v));
        expect(unknown).toEqual([]);
    });

    it('leaves no reporting variable unclaimed — the dangerous direction', () => {
        const unclaimed = RUNTIME_REPORTING_VARS.filter((v) => !claimed.includes(v));
        expect(unclaimed).toEqual([]);
    });

    it('claims each variable exactly once', () => {
        // A variable governing two channels would make one row's state
        // unexplainable from its own name.
        expect(new Set(claimed).size).toBe(claimed.length);
    });

    it('does not mistake the known scan artifact for a variable', () => {
        for (const artifact of KNOWN_SCAN_ARTIFACTS) {
            expect(claimed).not.toContain(artifact);
            expect(RUNTIME_REPORTING_VARS as readonly string[]).not.toContain(artifact);
            // And it IS a prefix of a real one, which is why it fooled a scan.
            expect(RUNTIME_REPORTING_VARS.some((v) => artifact.startsWith(v))).toBe(true);
        }
    });

    it('the comparison can fail in both directions', () => {
        // The positive control. Each half is a set difference, and a set
        // difference against the wrong set is green for the wrong reason.
        expect(['OPENSHELL_MADE_UP'].filter((v) => !(RUNTIME_REPORTING_VARS as readonly string[]).includes(v))).toEqual([
            'OPENSHELL_MADE_UP',
        ]);
        expect(RUNTIME_REPORTING_VARS.filter((v) => !['OPENSHELL_OCSF_JSON'].includes(v)).length).toBe(6);
    });
});
