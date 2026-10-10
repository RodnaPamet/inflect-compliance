/**
 * Step 6c: the adjudication mode, and the two gates that bound it.
 *
 * The hardening list asks for "a table of mode against residency and the
 * TypeSafe constant" showing EXTERNAL is never effective under LOCAL_ONLY or
 * while the constant is false. That table is the point of this file: it is
 * enumerated exhaustively rather than sampled, because the combination that
 * matters is the one nobody thought to write a case for.
 */
import {
    LEGACY_MATCH_PROCESSOR,
    TYPESAFE_SUBPROCESSOR_ACTIVE,
    adjudicationEnabled,
    effectiveLegacyMatchAiMode,
} from '@/lib/legacy-access/adjudication-mode';
import type { AiResidency, LegacyMatchAiMode } from '@prisma/client';

const MODES: LegacyMatchAiMode[] = ['OFF', 'LOCAL_ONLY', 'EXTERNAL'];
const RESIDENCIES: AiResidency[] = ['EXTERNAL', 'LOCAL_ONLY'];

describe('the effective mode is the stricter of the two settings', () => {
    it('the full table, enumerated rather than sampled', () => {
        const table = MODES.flatMap((mode) =>
            RESIDENCIES.map((residency) => ({
                mode,
                residency,
                effective: effectiveLegacyMatchAiMode(mode, residency),
            }))
        );
        // Six rows, spelled out. A fourth mode or a third residency changes this
        // literal, which is the deliberate act — derived expectations would
        // compare the function against itself.
        expect(table).toEqual([
            { mode: 'OFF', residency: 'EXTERNAL', effective: 'OFF' },
            { mode: 'OFF', residency: 'LOCAL_ONLY', effective: 'OFF' },
            { mode: 'LOCAL_ONLY', residency: 'EXTERNAL', effective: 'LOCAL_ONLY' },
            { mode: 'LOCAL_ONLY', residency: 'LOCAL_ONLY', effective: 'LOCAL_ONLY' },
            { mode: 'EXTERNAL', residency: 'EXTERNAL', effective: 'EXTERNAL' },
            // THE ROW THIS FILE EXISTS FOR.
            { mode: 'EXTERNAL', residency: 'LOCAL_ONLY', effective: 'LOCAL_ONLY' },
        ]);
    });

    it('EXTERNAL is never effective under LOCAL_ONLY residency', () => {
        // Stated separately from the table so the invariant survives somebody
        // "simplifying" the table above.
        for (const mode of MODES) {
            expect(effectiveLegacyMatchAiMode(mode, 'LOCAL_ONLY')).not.toBe('EXTERNAL');
        }
    });

    it('LOCAL_ONLY residency caps the mode; it does not force OFF', () => {
        // A tenant wanting adjudication in-deployment is asking for something
        // coherent, and answering OFF would deny them a feature their own
        // settings permit.
        expect(effectiveLegacyMatchAiMode('EXTERNAL', 'LOCAL_ONLY')).toBe('LOCAL_ONLY');
        expect(effectiveLegacyMatchAiMode('LOCAL_ONLY', 'LOCAL_ONLY')).toBe('LOCAL_ONLY');
    });

    it('absent settings read as OFF, not as the permissive default', () => {
        // A tenant with no settings row must reach no provider. `aiResidency`
        // defaults to EXTERNAL, so reading the pair carelessly would make
        // "never configured" mean "external model allowed".
        expect(effectiveLegacyMatchAiMode(null, null)).toBe('OFF');
        expect(effectiveLegacyMatchAiMode(undefined, undefined)).toBe('OFF');
        expect(effectiveLegacyMatchAiMode(null, 'EXTERNAL')).toBe('OFF');
        expect(adjudicationEnabled(null, null)).toBe(false);
        expect(adjudicationEnabled(undefined, 'EXTERNAL')).toBe(false);
    });

    it('adjudicationEnabled agrees with the effective mode, always', () => {
        for (const mode of MODES) {
            for (const residency of RESIDENCIES) {
                expect(adjudicationEnabled(mode, residency))
                    .toBe(effectiveLegacyMatchAiMode(mode, residency) !== 'OFF');
            }
        }
    });
});

describe('the sub-processor facts', () => {
    it('TypeSafe is NOT an active sub-processor', () => {
        // The Step 6a notice window has not closed. This is the constant whose
        // flip is a DPA change rather than a configuration one, and a test
        // asserting its current value is how an accidental flip gets noticed.
        expect(TYPESAFE_SUBPROCESSOR_ACTIVE).toBe(false);
    });

    it('is the SAME binding the provider exposes — one definition, not two', async () => {
        // It moved to this leaf module in 6c so the settings usecase can read it
        // without importing the transport, and the provider re-exports it. Two
        // constants that must agree is the thing that was avoided; this asserts
        // the avoidance rather than trusting it.
        const provider = await import('@/app-layer/ai/identity-match/jev-provider');
        expect(provider.TYPESAFE_SUBPROCESSOR_ACTIVE).toBe(TYPESAFE_SUBPROCESSOR_ACTIVE);
    });

    it('every mode names a processor and a region', () => {
        for (const mode of MODES) {
            const p = LEGACY_MATCH_PROCESSOR[mode];
            expect(p.processor.length).toBeGreaterThan(3);
            expect(p.region.length).toBeGreaterThan(1);
        }
        // OFF names no processor POSITIVELY rather than with an empty string: a
        // row claiming the processor is "" reads as a missing value.
        expect(LEGACY_MATCH_PROCESSOR.OFF.processor).toMatch(/none/i);
        expect(LEGACY_MATCH_PROCESSOR.EXTERNAL.processor).toMatch(/TypeSafe/);
        expect(LEGACY_MATCH_PROCESSOR.EXTERNAL.region).toBe('EU');
    });
});

describe('the leaf stays a leaf', () => {
    it('loading it does NOT pull in the transport', () => {
        // The reason this module exists. Reading the sub-processor constant from
        // `jev-provider` would drag the transport — and so the egress stack —
        // into a settings page, which is the hazard `legacy-reconcile` already
        // names about the leaver pass.
        //
        // Proven BEHAVIOURALLY rather than by reading the import lines. A text
        // scan would assert about prose — `tests/guardrails/raw-source-assertion-ratchet`
        // caps exactly that pattern, and it caught the first version of this
        // test — and it would also miss a transitive import that arrives through
        // a third module. Mocking the transport to throw ON LOAD means the only
        // way this passes is if nothing in the graph reaches it.
        jest.isolateModules(() => {
            jest.doMock('@/app-layer/ai/identity-match/transport', () => {
                throw new Error('adjudication-mode must not import the transport');
            });
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                require('@/lib/legacy-access/adjudication-mode');
            }).not.toThrow();
        });
    });

    it('and the positive control: the PROVIDER does pull it in', () => {
        // Without this, the test above would pass just as happily against a
        // mock path that matches nothing — which is the failure mode of every
        // "assert the absence" test.
        jest.isolateModules(() => {
            jest.doMock('@/app-layer/ai/identity-match/transport', () => {
                throw new Error('loaded');
            });
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                require('@/app-layer/ai/identity-match/jev-provider');
            }).toThrow(/loaded/);
        });
    });
});
