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
import { apiErrorMessage } from '@/lib/api-error';

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

    it('returns the fallback for an unparseable or empty body', () => {
        expect(apiErrorMessage(null, FALLBACK)).toBe(FALLBACK);
        expect(apiErrorMessage({}, FALLBACK)).toBe(FALLBACK);
        expect(apiErrorMessage('plain text', FALLBACK)).toBe(FALLBACK);
    });
});
