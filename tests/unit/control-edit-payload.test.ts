/**
 * The Control edit form → PATCH body mapping.
 *
 * `automationType` and `mitigationType` are rendered as wired Comboboxes on
 * the edit modal, seeded from the loaded control, accepted by Zod and
 * written by `updateControl` — but they were absent from the request body.
 * The modal closed, `toast.success` fired, and the stale value re-rendered
 * on refetch: a save that reported success and changed nothing.
 */
import {
    buildControlPatchBody,
    type ControlEditForm,
} from '@/app/t/[tenantSlug]/(app)/controls/[controlId]/_lib/control-edit-payload';

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
        ...overrides,
    };
}

describe('buildControlPatchBody', () => {
    it('sends automationType and mitigationType', () => {
        // The defect, in one assertion.
        const body = buildControlPatchBody(
            form({ automationType: 'AUTOMATED', mitigationType: 'PREVENTIVE' }),
        );
        expect(body.automationType).toBe('AUTOMATED');
        expect(body.mitigationType).toBe('PREVENTIVE');
    });

    it('clears them when the user empties the field', () => {
        // Not just "present when set" — the clear gesture has to reach the
        // server too, or the control keeps a value the UI shows as blank.
        const body = buildControlPatchBody(form({ automationType: '', mitigationType: '' }));
        expect(body.automationType).toBeNull();
        expect(body.mitigationType).toBeNull();
    });

    it('sends every field the edit modal renders', () => {
        // A field rendered but not sent is exactly this class of bug, so
        // pin the whole key set rather than the two that were missing.
        const body = buildControlPatchBody(form());
        expect(Object.keys(body).sort()).toEqual(
            [
                'annualCost',
                'automationType',
                'category',
                'effectiveness',
                'frequency',
                'mitigationType',
                'name',
                'objective',
                'successCriteria',
                'testingMethodology',
            ].sort(),
        );
    });

    it('trims text and maps blanks to null', () => {
        const body = buildControlPatchBody(
            form({ name: '  Access review  ', objective: '   ', category: ' Access ' }),
        );
        expect(body.name).toBe('Access review');
        expect(body.objective).toBeNull();
        expect(body.category).toBe('Access');
    });

    it('maps an empty numeric to null (clears) and a parseable one through', () => {
        expect(buildControlPatchBody(form({ annualCost: '' })).annualCost).toBeNull();
        expect(buildControlPatchBody(form({ annualCost: '1200' })).annualCost).toBe(1200);
        expect(buildControlPatchBody(form({ effectiveness: '0' })).effectiveness).toBe(0);
    });

    it('omits an unparseable numeric — a known third semantic', () => {
        // Documenting current behaviour, not endorsing it: `undefined` drops
        // the key, so the old value silently persists. The other two write
        // surfaces disagree about this; reconciling them is tracked
        // separately. Pinning it here means that change has to be
        // deliberate.
        const body = buildControlPatchBody(form({ annualCost: 'abc' }));
        expect(body.annualCost).toBeUndefined();
    });
});
