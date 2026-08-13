/**
 * ONE empty-value rule across all three Control write surfaces.
 *
 * They disagreed, so the same "clear this field" gesture had three different
 * outcomes:
 *
 *   detail page       '' -> null      unparseable -> undefined (KEY OMITTED,
 *                                     old value silently kept)
 *   ControlEditPanel  '' -> null
 *   NewControlModal   '' -> undefined (key omitted, so clearing no-opped)
 *
 * The rule now: '' clears (null), an absent field is unchanged (key absent),
 * and an unparseable value is REJECTED rather than dropped.
 */
import {
    buildControlPatchBody,
    choiceOrNull,
    numberOrNull,
    textOrNull,
    type ControlEditForm,
} from '@/app/t/[tenantSlug]/(app)/controls/_lib/control-write-values';

describe('textOrNull — empty clears', () => {
    it('trims and returns the value', () => {
        expect(textOrNull('  Access review  ')).toBe('Access review');
    });

    it('maps empty and whitespace to null', () => {
        expect(textOrNull('')).toBeNull();
        expect(textOrNull('   ')).toBeNull();
    });

    it('maps null/undefined to null — never to undefined', () => {
        // `undefined` would OMIT the key, which means "unchanged". A field
        // the user cleared must not be read as a field they did not touch.
        expect(textOrNull(null)).toBeNull();
        expect(textOrNull(undefined)).toBeNull();
    });
});

describe('choiceOrNull — empty selection clears', () => {
    it('passes a selection through', () => {
        expect(choiceOrNull('QUARTERLY')).toBe('QUARTERLY');
    });

    it('maps the empty selection to null', () => {
        // This is the NewControlModal defect: '' became undefined, so
        // clearing a dropdown on create silently did nothing.
        expect(choiceOrNull('')).toBeNull();
        expect(choiceOrNull(null)).toBeNull();
        expect(choiceOrNull(undefined)).toBeNull();
    });
});

describe('numberOrNull — empty clears, unparseable is rejected', () => {
    it('parses a numeric string', () => {
        expect(numberOrNull('1200')).toBe(1200);
        expect(numberOrNull('0')).toBe(0);
        expect(numberOrNull(' 42 ')).toBe(42);
    });

    it('maps empty to null', () => {
        expect(numberOrNull('')).toBeNull();
        expect(numberOrNull('   ')).toBeNull();
    });

    it('returns the RAW STRING for an unparseable value, so the server rejects it', () => {
        // The old behaviour returned undefined, which omitted the key: the
        // user was told the save succeeded while the previous value stayed.
        // Sending the raw string makes Zod fail it, and the caller's
        // existing `if (!res.ok)` path surfaces the error.
        expect(numberOrNull('abc')).toBe('abc');
        expect(numberOrNull('12abc')).toBe('12abc');
        // Explicitly NOT undefined — that is the regression this guards.
        expect(numberOrNull('abc')).not.toBeUndefined();
    });
});

describe('buildControlPatchBody applies the rule uniformly', () => {
    function form(overrides: Partial<ControlEditForm> = {}): ControlEditForm {
        return {
            name: 'Access review',
            objective: '',
            successCriteria: '',
            testingMethodology: '',
            category: '',
            frequency: '',
            automationType: '',
            mitigationType: '',
            annualCost: '',
            effectiveness: '',
            automationKey: '',
            evidenceSource: '',
            ...overrides,
        };
    }

    it('clears every emptied field with null, never undefined', () => {
        const body = buildControlPatchBody(form());
        for (const [key, value] of Object.entries(body)) {
            if (key === 'name') continue; // required, always a string
            expect({ key, value }).toEqual({ key, value: null });
        }
    });

    /**
     * U5 — the two fields that decide whether a control gets automated checks.
     *
     * `automation-runner.ts` selects a control only when `automationKey` is
     * non-null AND `evidenceSource === 'INTEGRATION'`. Both were accepted by
     * Zod on create and update, and written by `updateControl`, long before
     * any UI sent them — `evidenceSource` had ZERO occurrences across
     * `src/app` and `src/components`. The feature was complete on the server
     * and unreachable from the product, while the checks empty state told
     * users to configure it.
     *
     * This is the same defect shape the docblock on the module records for
     * `automationType`: rendered, seeded, accepted, written — and absent from
     * the request. That one is why this file exists.
     */
    it('sends the automated-checks pair so the feature can be switched on', () => {
        const body = buildControlPatchBody(
            form({
                automationKey: 'aws.s3.public-access-block',
                evidenceSource: 'INTEGRATION',
            }),
        );
        expect(body.automationKey).toBe('aws.s3.public-access-block');
        expect(body.evidenceSource).toBe('INTEGRATION');
    });

    it('clears the automation key with null, so a control can be un-automated', () => {
        const body = buildControlPatchBody(
            form({ automationKey: '', evidenceSource: 'MANUAL' }),
        );
        // null, never undefined — an omitted key silently keeps the old value
        // and the runner would carry on firing for a control the operator
        // believes they detached.
        expect(body.automationKey).toBeNull();
        expect(body.evidenceSource).toBe('MANUAL');
    });

    it('still sends automationType and mitigationType', () => {
        const body = buildControlPatchBody(
            form({ automationType: 'AUTOMATED', mitigationType: 'PREVENTIVE' }),
        );
        expect(body.automationType).toBe('AUTOMATED');
        expect(body.mitigationType).toBe('PREVENTIVE');
    });

    it('sends every field the edit modal renders', () => {
        expect(Object.keys(buildControlPatchBody(form())).sort()).toEqual(
            [
                'annualCost',
                // U5 — the automated-checks pair. This list IS the ratchet
                // for the defect this module was extracted to prevent: a
                // field the modal renders that the request never carries.
                'automationKey',
                'automationType',
                'category',
                'effectiveness',
                'evidenceSource',
                'frequency',
                'mitigationType',
                'name',
                'objective',
                'successCriteria',
                'testingMethodology',
            ].sort(),
        );
    });
});
