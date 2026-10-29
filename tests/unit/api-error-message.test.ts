/**
 * `src/lib/api-error.ts` — coercing an API error body to a renderable string.
 *
 * WHAT BREAKS IF THIS IS WRONG
 * ----------------------------
 * The canonical envelope is `{ error: { code, message, requestId } }`, so
 * `setError(body.error ?? fallback)` puts an OBJECT into React state. Rendering
 * it throws "objects are not valid as a React child" and the page error
 * boundary swallows the real message behind "Something went wrong". It only
 * fires on a 4xx/5xx, which is exactly when the operator needs to read what
 * went wrong — so the bug hides until the worst moment.
 *
 * This helper is the fix, and it had no test. The three body shapes below are
 * the ones that actually reach it.
 */
import { apiErrorMessage, apiRefusalMessage, validationIssueMessages } from '@/lib/api-error';

describe('apiErrorMessage', () => {
    const FALLBACK = 'Failed to save';

    it('reads the canonical { error: { message } } envelope', () => {
        expect(
            apiErrorMessage(
                { error: { code: 'conflict', message: 'Risk key already exists', requestId: 'r1' } },
                FALLBACK,
            ),
        ).toBe('Risk key already exists');
    });

    it('reads a flat { error: string } body', () => {
        expect(apiErrorMessage({ error: 'Risk key already exists' }, FALLBACK)).toBe(
            'Risk key already exists',
        );
    });

    it('reads a bare { message: string } body', () => {
        expect(apiErrorMessage({ message: 'Not found' }, FALLBACK)).toBe('Not found');
    });

    it('prefers the envelope message over a sibling top-level message', () => {
        expect(
            apiErrorMessage({ error: { message: 'inner' }, message: 'outer' }, FALLBACK),
        ).toBe('inner');
    });

    it('falls back when the envelope carries no message string', () => {
        // The shape that caused the original bug: an object with no `message`.
        expect(apiErrorMessage({ error: { code: 'conflict' } }, FALLBACK)).toBe(FALLBACK);
    });

    it('never returns a non-string, whatever the body is', () => {
        for (const body of [
            null,
            undefined,
            'a string body',
            42,
            [],
            { error: 42 },
            { error: { message: 99 } },
            { message: { nested: true } },
        ]) {
            expect(typeof apiErrorMessage(body, FALLBACK)).toBe('string');
        }
    });

    it('treats a blank message as absent at every shape, and keeps looking', () => {
        // #3984 — a whitespace-only sentence renders an EMPTY alert, which a
        // reader cannot tell apart from a broken page. Each shape is tried in
        // order, so a blank at one must fall through rather than end the
        // search: the third case carries a real message behind two blanks.
        expect(apiErrorMessage({ error: '   ' }, FALLBACK)).toBe(FALLBACK);
        expect(apiErrorMessage({ error: { code: 'X', message: '' } }, FALLBACK)).toBe(FALLBACK);
        expect(apiErrorMessage({ error: '', message: '\t' }, FALLBACK)).toBe(FALLBACK);
        expect(apiErrorMessage({ error: { message: '  ' }, message: 'outer' }, FALLBACK)).toBe(
            'outer',
        );
    });

    it('returns the fallback for an unparseable or empty body', () => {
        expect(apiErrorMessage(null, FALLBACK)).toBe(FALLBACK);
        expect(apiErrorMessage({}, FALLBACK)).toBe(FALLBACK);
        expect(apiErrorMessage('plain text', FALLBACK)).toBe(FALLBACK);
    });
});

describe('apiRefusalMessage (#4471)', () => {
    const FALLBACK = 'Could not register the agent.';
    // What `toApiErrorResponse` sends for a ZodError: the reason is in
    // `details`, and the message is the same generic sentence for every one.
    const zodRefusal = (...messages: string[]) => ({
        error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request payload',
            details: messages.map((message, i) => ({ path: [`field${i}`], code: 'custom', message })),
        },
    });

    it('shows a validation refusal’s reasons instead of "Invalid request payload"', () => {
        expect(apiRefusalMessage(zodRefusal('A THIRD_PARTY agent must name the vendor that supplies it'), FALLBACK)).toBe(
            'A THIRD_PARTY agent must name the vendor that supplies it',
        );
    });

    it('joins several reasons, once each', () => {
        expect(apiRefusalMessage(zodRefusal('Name is required', 'Name is required', 'Pick an owner'), FALLBACK)).toBe(
            'Name is required; Pick an owner',
        );
    });

    it('falls back to the envelope message when the details carry no readable reason', () => {
        const body = { error: { code: 'VALIDATION_ERROR', message: 'Invalid request payload', details: [{ path: [] }] } };
        expect(validationIssueMessages(body)).toEqual([]);
        expect(apiRefusalMessage(body, FALLBACK)).toBe('Invalid request payload');
    });

    it('reads every other refusal as apiErrorMessage does', () => {
        expect(apiRefusalMessage({ error: { code: 'BAD_REQUEST', message: 'The cap must be 0 to 1000' } }, FALLBACK)).toBe(
            'The cap must be 0 to 1000',
        );
        // The edge's flat refusal.
        expect(apiRefusalMessage({ error: 'Admin access required' }, FALLBACK)).toBe('Admin access required');
        expect(apiRefusalMessage(null, FALLBACK)).toBe(FALLBACK);
    });

    it('ignores `details` on an error that is not a validation error', () => {
        const body = { error: { code: 'CONFLICT', message: 'Already registered', details: [{ message: 'raw' }] } };
        expect(validationIssueMessages(body)).toEqual([]);
        expect(apiRefusalMessage(body, FALLBACK)).toBe('Already registered');
    });
});
