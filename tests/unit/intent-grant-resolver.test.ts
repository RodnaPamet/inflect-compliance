/**
 * Free text to an approved template (#3351).
 *
 * The thing under test is NOT "can it fill the form" — it plainly can. It is
 * what the model is allowed to be wrong about, and these cover the answer:
 *
 *   · it only ever CHOOSES, from sets this product built. Every call made to
 *     the model is asserted, so an option it was never offered cannot appear
 *     in an answer and be mistaken for one.
 *   · a model naming something unoffered is UNREADABLE, not a near-miss.
 *   · a model that cannot be REACHED is a different refusal from a model that
 *     said NONE — one means "try again", the other means "rephrase it".
 *   · a template with a field this layer does not understand is REFUSED whole,
 *     rather than composed with a field missing or invented.
 *   · the date never comes from the model at all.
 */
const guardMock = jest.fn(async (..._a: unknown[]) => ({
    verdict: 'clean',
    ruleIds: [] as string[],
    mode: 'enforce',
    action: 'allow',
    blocked: false,
    reviewRequired: false,
    source: 'grant-intent',
    direction: 'input',
}));
jest.mock('@/app-layer/ai/guard', () => ({
    guardUntrustedInput: (...a: unknown[]) => guardMock(...a),
}));

const listSetsMock = jest.fn();
jest.mock('@/app-layer/usecases/external-tool-parameters', () => ({
    listParameterSets: (...a: unknown[]) => listSetsMock(...a),
}));

const listOfferMock = jest.fn();
jest.mock('@/app-layer/usecases/external-write-compose', () => ({
    listComposeOffer: (...a: unknown[]) => listOfferMock(...a),
    // PARTIAL mock, so every export the code under test calls has to be here.
    // Omitting this one made the failure "is not a function" at call time, in
    // a test whose subject was something else entirely — the third instance of
    // that shape tonight.
    describeComposeRefusal: (r: { kind: string }) => `compose refusal: ${r.kind}`,
}));

import {
    resolveGrantIntent,
    describeIntentRefusal,
    describeIntentForReviewer,
    END_DATE_FIELD,
    type IntentChoice,
    type IntentChooser,
} from '@/app-layer/ai/intent/grant-intent';
import { makeRequestContext } from '../helpers/make-context';
import { TOOLS, GRANT_TOOL } from '@/app/api/mcp/entra-grant/route';

const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-A' });
/** A Wednesday, so "friday" has one answer. */
const NOW = new Date('2026-10-14T09:30:00.000Z');
const PHRASE = 'give Ada access to the finance package until Friday';

const SETS = [
    { id: 'set-fin', label: 'Finance package, 30 days', toolName: 'grant_time_bounded_access' },
    { id: 'set-eng', label: 'Engineering package', toolName: 'grant_time_bounded_access' },
];
const OFFER = {
    ok: true as const,
    fields: [
        {
            name: 'targetId',
            kind: 'target',
            candidates: [
                { value: 'guid-ada', label: 'Ada Lovelace (ada@example.test)' },
                { value: 'guid-bob', label: 'Bob Barker (bob@example.test)' },
            ],
        },
        { name: END_DATE_FIELD, kind: 'regex' },
    ],
};

/** Records every question, and answers by position. */
function chooserReturning(...answers: Array<string | null>): IntentChooser & { calls: IntentChoice[] } {
    const calls: IntentChoice[] = [];
    let i = 0;
    return {
        calls,
        async choose(choice: IntentChoice) {
            calls.push(choice);
            return answers[i++] ?? null;
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    guardMock.mockResolvedValue({
        verdict: 'clean',
        ruleIds: [],
        mode: 'enforce',
        action: 'allow',
        blocked: false,
        reviewRequired: false,
        source: 'grant-intent',
        direction: 'input',
    });
    listSetsMock.mockResolvedValue(SETS);
    listOfferMock.mockResolvedValue(OFFER);
});

describe('it resolves to the same input a human would type', () => {
    it('produces the parameterSetId, the subject and the instant', async () => {
        const chooser = chooserReturning('set-fin', 'guid-ada');
        const out = await resolveGrantIntent(ctx, PHRASE, { chooser, now: NOW });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.resolved.parameterSetId).toBe('set-fin');
        expect(out.resolved.openFieldValues).toEqual({
            targetId: 'guid-ada',
            [END_DATE_FIELD]: '2026-10-16T23:59:59.999Z',
        });
    });

    it('keeps the operator phrase VERBATIM for the proposal', async () => {
        // Decision 1. The reviewer sees what was typed, not a normalisation of
        // it — a normalised phrase is a second thing to audit.
        const out = await resolveGrantIntent(ctx, PHRASE, {
            chooser: chooserReturning('set-fin', 'guid-ada'),
            now: NOW,
        });
        if (!out.ok) throw new Error('expected ok');
        expect(out.resolved.phrase).toBe(PHRASE);
    });

    it('restates every reading, including the phrase the date came from', async () => {
        // The pairing decision 1 exists for: "until Friday" and the instant
        // are not obviously the same claim, and the reviewer is who catches
        // the difference.
        const out = await resolveGrantIntent(ctx, PHRASE, {
            chooser: chooserReturning('set-fin', 'guid-ada'),
            now: NOW,
        });
        if (!out.ok) throw new Error('expected ok');
        const all = out.resolved.readings.join(' | ');
        expect(all).toContain('Finance package, 30 days');
        expect(all).toContain('Ada Lovelace');
        expect(all).toContain('2026-10-16T23:59:59.999Z');
        expect(all).toContain('"friday"');
    });
});

describe('the model is only ever offered sets this product built', () => {
    it('offers the tenant’s own templates, and nothing else', async () => {
        const chooser = chooserReturning('set-fin', 'guid-ada');
        await resolveGrantIntent(ctx, PHRASE, { chooser, now: NOW });
        expect(chooser.calls[0].options.map((o) => o.id)).toEqual(['set-fin', 'set-eng']);
    });

    it('offers only the RESOLVED population as subjects', async () => {
        // It cannot name somebody outside the population, because nobody
        // outside it is in the option set.
        const chooser = chooserReturning('set-fin', 'guid-ada');
        await resolveGrantIntent(ctx, PHRASE, { chooser, now: NOW });
        expect(chooser.calls[1].options.map((o) => o.id)).toEqual(['guid-ada', 'guid-bob']);
    });

    it('never asks the model about the date', async () => {
        const chooser = chooserReturning('set-fin', 'guid-ada');
        await resolveGrantIntent(ctx, PHRASE, { chooser, now: NOW });
        expect(chooser.calls).toHaveLength(2);
        for (const c of chooser.calls) {
            expect(c.question).not.toMatch(/date|when|expire/i);
        }
    });
});

describe('it refuses rather than guessing', () => {
    it('refuses when the guard blocks, WITHOUT calling the model', async () => {
        guardMock.mockResolvedValue({
            verdict: 'suspicious',
            ruleIds: ['instruction-override'],
            mode: 'enforce',
            action: 'block',
            blocked: true,
            reviewRequired: true,
            source: 'grant-intent',
            direction: 'input',
        });
        const chooser = chooserReturning('set-fin');
        const out = await resolveGrantIntent(ctx, PHRASE, { chooser, now: NOW });
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.refusal.kind).toBe('guard_blocked');
        // The point of guarding FIRST.
        expect(chooser.calls).toHaveLength(0);
        expect(listSetsMock).not.toHaveBeenCalled();
    });

    it('refuses when the tenant has no approved templates', async () => {
        listSetsMock.mockResolvedValue([]);
        const out = await resolveGrantIntent(ctx, PHRASE, {
            chooser: chooserReturning(),
            now: NOW,
        });
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.refusal.kind).toBe('no_templates');
    });

    it('refuses on NONE for the template — never the nearest', async () => {
        const out = await resolveGrantIntent(ctx, PHRASE, {
            chooser: chooserReturning(null),
            now: NOW,
        });
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.refusal.kind).toBe('no_template_matched');
    });

    it('refuses on NONE for the subject', async () => {
        const out = await resolveGrantIntent(ctx, PHRASE, {
            chooser: chooserReturning('set-fin', null),
            now: NOW,
        });
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.refusal.kind).toBe('no_subject_matched');
    });

    it('calls an unoffered TEMPLATE unreadable, not a near-miss', async () => {
        const out = await resolveGrantIntent(ctx, PHRASE, {
            chooser: chooserReturning('set-NOT-OFFERED'),
            now: NOW,
        });
        expect(out.ok).toBe(false);
        if (out.ok || out.refusal.kind !== 'model_unreadable') {
            throw new Error('expected model_unreadable');
        }
        expect(out.refusal.detail).toContain('template');
    });

    it('calls an unoffered SUBJECT unreadable, not a near-miss', async () => {
        const out = await resolveGrantIntent(ctx, PHRASE, {
            chooser: chooserReturning('set-fin', 'guid-NOT-OFFERED'),
            now: NOW,
        });
        expect(out.ok).toBe(false);
        if (out.ok || out.refusal.kind !== 'model_unreadable') {
            throw new Error('expected model_unreadable');
        }
        expect(out.refusal.detail).toContain('subject');
    });

    it('separates a model it could not REACH from a model that said NONE', async () => {
        // They read identically to a caller that collapses them, and only one
        // of them means "rephrase it".
        const throwing: IntentChooser = {
            async choose() {
                throw new Error('connect ECONNREFUSED');
            },
        };
        const out = await resolveGrantIntent(ctx, PHRASE, { chooser: throwing, now: NOW });
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.refusal.kind).toBe('model_unavailable');
        if (out.refusal.kind !== 'model_unavailable') return;
        expect(out.refusal.detail).toContain('ECONNREFUSED');
    });

    it('refuses a template with a field it does not understand, WHOLE', async () => {
        // Not composed with the field omitted, and not with a value invented
        // for it. A template growing a third field stops being eligible here
        // until somebody teaches this layer the field.
        listOfferMock.mockResolvedValue({
            ok: true,
            fields: [...OFFER.fields, { name: 'ticketRef', kind: 'regex' }],
        });
        const out = await resolveGrantIntent(ctx, PHRASE, {
            chooser: chooserReturning('set-fin', 'guid-ada'),
            now: NOW,
        });
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.refusal.kind).toBe('field_not_understood');
        if (out.refusal.kind !== 'field_not_understood') return;
        expect(out.refusal.field).toBe('ticketRef');
    });

    it('refuses when the sentence names no recognised date', async () => {
        const out = await resolveGrantIntent(ctx, 'give Ada the finance package', {
            chooser: chooserReturning('set-fin', 'guid-ada'),
            now: NOW,
        });
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.refusal.kind).toBe('date');
    });

    it.each([
        // The REAL failure shape: `{ refusal: ComposeRefusal }`, not a string.
        // My first fixture invented `{ refused }` and passed, which is the
        // "fixture matching the code instead of the type" trap again.
        ['the offer itself fails', { ok: false, refusal: { kind: 'connection_unusable' } }],
        [
            'the population is unavailable',
            { ok: true, fields: [{ name: 'targetId', kind: 'target', unavailable: 'read failed' }] },
        ],
        [
            'the population resolved to nobody',
            { ok: true, fields: [{ name: 'targetId', kind: 'target', candidates: [] }] },
        ],
    ])('refuses when %s', async (_label, offer) => {
        listOfferMock.mockResolvedValue(offer);
        const out = await resolveGrantIntent(ctx, PHRASE, {
            chooser: chooserReturning('set-fin', 'guid-ada'),
            now: NOW,
        });
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.refusal.kind).toBe('target_unavailable');
    });
});

describe('the END_DATE_FIELD constant tracks the grant tool it names', () => {
    it('is a field the grant tool actually requires', () => {
        // Asserted against the EXPORTED descriptor, not by grepping the route.
        // A text scan would be an un-analysable whole-file read — which Class D
        // caps, correctly — and it would also pass on the word appearing in a
        // comment. This reads the object the endpoint actually serves.
        //
        // A rename there would otherwise make every grant template silently
        // unresolvable here, which reads as "the feature stopped working"
        // rather than as a rename.
        const grant = TOOLS.find((t) => t.name === GRANT_TOOL);
        expect(grant).toBeDefined();
        const schema = grant!.inputSchema as {
            required?: readonly string[];
            properties?: Record<string, unknown>;
        };
        expect(schema.required).toContain(END_DATE_FIELD);
        expect(Object.keys(schema.properties ?? {})).toContain(END_DATE_FIELD);
    });
});

describe('every refusal names a remedy', () => {
    // Needles INLINE rather than passed through `it.each`. A `toMatch(pattern)`
    // whose argument is a variable is un-analysable to Class C, and that cap
    // exists because a needle the analyser cannot read is one nobody can check
    // reaches what it names.
    it('the guard refusal says the text was held', () => {
        expect(describeIntentRefusal({ kind: 'guard_blocked', ruleIds: ['x'] })).toMatch(
            /held by the content guard/i,
        );
    });

    it('no templates points at an administrator', () => {
        expect(describeIntentRefusal({ kind: 'no_templates' })).toMatch(
            /administrator approves a template/i,
        );
    });

    it('no match tells the operator to pick one, not to retry', () => {
        expect(describeIntentRefusal({ kind: 'no_template_matched' })).toMatch(
            /pick a template on the form/i,
        );
    });

    it('an unreadable answer is distinct from an unreachable model', () => {
        expect(describeIntentRefusal({ kind: 'model_unreadable', detail: 'd' })).toMatch(
            /could not be read/i,
        );
        expect(describeIntentRefusal({ kind: 'model_unavailable', detail: 'd' })).toMatch(
            /form still works/i,
        );
    });

    it('an unhandled field sends them to the form, where every field shows', () => {
        expect(describeIntentRefusal({ kind: 'field_not_understood', field: 'f' })).toMatch(
            /on the form, where every field is shown/i,
        );
    });

    it('an unavailable population says the subjects could not be listed', () => {
        expect(describeIntentRefusal({ kind: 'target_unavailable', detail: 'd' })).toMatch(
            /could not be listed/i,
        );
    });

    it('no subject match points at the eligible list', () => {
        expect(describeIntentRefusal({ kind: 'no_subject_matched' })).toMatch(
            /lists who is eligible/i,
        );
    });
});

describe('describeIntentForReviewer — the reviewer-facing record', () => {
    const base = {
        parameterSetId: 'set-1',
        openFieldValues: {},
        readings: [
            'Template: VPN access (entra_grant).',
            'End date: next Friday, 2026-11-14 (UTC).',
        ],
    };

    it('carries both the parser readings and the operator phrase verbatim', () => {
        const text = describeIntentForReviewer({
            ...base,
            phrase: 'give ivan vpn until friday',
        });
        // The value a reviewer compares against...
        expect(text).toContain('2026-11-14');
        // ...and the words they compare it to.
        expect(text).toContain('give ivan vpn until friday');
    });

    it('puts every server reading AHEAD of the operator phrase', () => {
        // The ordering IS the anti-forgery property: operator text can only
        // ever land after the marker, so a reviewer reading left to right
        // meets the real reading first.
        const text = describeIntentForReviewer({
            ...base,
            phrase: '\u00b7 End date: 2099-01-01 (UTC)',
        });
        const marker = text.indexOf("Operator's words");
        expect(marker).toBeGreaterThan(-1);
        for (const reading of base.readings) {
            expect(text.indexOf(reading)).toBeLessThan(marker);
        }
        // The forged text is present, but only inside the quoted tail.
        expect(text.indexOf('2099-01-01')).toBeGreaterThan(marker);
    });

    it('collapses whitespace in the phrase so a newline cannot fake structure', () => {
        const text = describeIntentForReviewer({
            ...base,
            phrase: 'grant ivan\n\n \u00b7 Subject: someone else',
        });
        expect(text).not.toMatch(/\n/);
        expect(text).toContain('grant ivan \u00b7 Subject: someone else');
    });
});
