/**
 * THE READINESS VERDICT — what the collector is allowed to conclude from a state.
 *
 * `AttachSandboxProvider` returns a persisted intent, not an installed
 * credential, so the only thing standing between a benchmark run and a
 * credential-less run is this table (#5739). Three properties, each its own case:
 *
 *   1. ONLY `READY` admits an exec. Nothing else may, including the zero value.
 *   2. The table is TOTAL over the proto's eight states, so a re-vendored proto
 *      carrying a ninth fails `tsc` rather than falling through to a default.
 *   3. An unrecognised state is REFUSED, never READY and never an endless wait.
 */
import {
    PROVIDER_READINESS_STATES,
    READINESS_VERDICT,
    describeReadiness,
    readinessVerdict,
    type ProviderReadinessState,
} from '@/lib/agentic/openshell/provider-readiness';

describe('readinessVerdict', () => {
    it('admits an exec on READY and on nothing else', () => {
        const ready = PROVIDER_READINESS_STATES.filter((s) => readinessVerdict(s) === 'READY');
        // Exact equality, not `toContain`: a second state that admitted an exec
        // would be a second way to run the benchmark without a credential.
        expect(ready).toEqual(['PROVIDER_READINESS_STATE_READY']);
    });

    it('waits on the zero value rather than reading it as ready', () => {
        // `UNSPECIFIED` is the proto's 0 — the answer a field carries while the
        // gateway has not filled it in. A zero value is not an assurance, which
        // is the same reading `DELETION_IS_SETTLED` gives its own UNSPECIFIED.
        expect(readinessVerdict('PROVIDER_READINESS_STATE_UNSPECIFIED')).toBe('WAIT');
    });

    it('waits only on the states that can still become ready', () => {
        const waiting = PROVIDER_READINESS_STATES.filter((s) => readinessVerdict(s) === 'WAIT');
        expect(waiting).toEqual([
            'PROVIDER_READINESS_STATE_UNSPECIFIED',
            'PROVIDER_READINESS_STATE_PERSISTED',
            'PROVIDER_READINESS_STATE_PENDING',
        ]);
    });

    it('refuses SUPERSEDED rather than waiting on it', () => {
        // A newer desired state replaced this receipt, so no amount of polling
        // makes THIS one ready — and whatever did win was configured by somebody
        // else, which is the shared-credential confusion #5251 is about.
        expect(readinessVerdict('PROVIDER_READINESS_STATE_SUPERSEDED')).toBe('REFUSED');
    });

    it.each(['PROVIDER_READINESS_STATE_WITHHELD', 'PROVIDER_READINESS_STATE_REVOKED', 'PROVIDER_READINESS_STATE_FAILED'])(
        'refuses %s',
        (state) => {
            expect(readinessVerdict(state)).toBe('REFUSED');
        },
    );

    it.each([null, undefined, '', 'PROVIDER_READINESS_STATE_SOMETHING_NEW'])(
        'refuses %p rather than treating it as ready or waiting forever',
        (state) => {
            expect(readinessVerdict(state as string | null | undefined)).toBe('REFUSED');
        },
    );

    it('classifies every state the proto declares, with no default to fall through', () => {
        // The population is the vendored proto's. A state missing from the table
        // would be a `tsc` failure, and this is the runtime half: the table and
        // the state list cannot drift apart silently.
        for (const state of PROVIDER_READINESS_STATES) {
            expect(READINESS_VERDICT[state as ProviderReadinessState]).toBeDefined();
        }
        expect(Object.keys(READINESS_VERDICT).sort()).toEqual([...PROVIDER_READINESS_STATES].sort());
    });

    it('is frozen, so a caller cannot reclassify a state at runtime', () => {
        expect(Object.isFrozen(READINESS_VERDICT)).toBe(true);
    });
});

describe('describeReadiness', () => {
    it('names the state, the reason and whether credentials are installed', () => {
        expect(
            describeReadiness({
                state: 'PROVIDER_READINESS_STATE_PENDING',
                reason: 'PROVIDER_READINESS_REASON_WAITING_FOR_CREDENTIALS',
                credentialsInstalled: false,
            }),
        ).toBe(
            'state=PROVIDER_READINESS_STATE_PENDING '
                + 'reason=PROVIDER_READINESS_REASON_WAITING_FOR_CREDENTIALS '
                + 'credentialsInstalled=false',
        );
    });

    it('keeps `false` distinguishable from "not reported"', () => {
        // `credentials_installed` is a bool on an observation the gateway may not
        // have made at all. Collapsing absent into false would tell an operator
        // the gateway said something it never said.
        expect(describeReadiness({ state: 'X', credentialsInstalled: false })).toContain(
            'credentialsInstalled=false',
        );
        expect(describeReadiness({ state: 'X', credentialsInstalled: null })).not.toContain(
            'credentialsInstalled',
        );
        expect(describeReadiness({ state: 'X' })).not.toContain('credentialsInstalled');
    });

    it('says ABSENT rather than printing nothing for a missing state', () => {
        expect(describeReadiness({ state: null })).toBe('state=ABSENT');
    });
});
