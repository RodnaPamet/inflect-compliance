/**
 * Risk mutation errors go through `extractMutationError`.
 *
 * B2-1 — nine call sites across the Risks surface hand-rolled
 * `err instanceof Error ? err.message : <fallback>`. That ternary is not
 * merely verbose: it is WRONG for a thrown value that is neither an Error
 * nor a string, which is exactly what an API error body deserialises to.
 * `{ error: 'Risk key already exists' }` hit the `else` branch and rendered
 * the generic fallback, so the user was told "Failed to save" while the
 * server had said precisely what was wrong.
 *
 * These cases pin the difference rather than the refactor.
 */
import { extractMutationError } from '@/lib/mutations';

describe('extractMutationError — what the hand-rolled ternary got wrong', () => {
    it('surfaces an API error body that the ternary would have discarded', () => {
        // The regression that motivated the change. `err instanceof Error`
        // is false here, so every one of the nine sites rendered its
        // fallback and threw away the server's message.
        expect(extractMutationError({ error: 'Risk key already exists' }, 'Failed to save'))
            .toBe('Risk key already exists');
    });

    it('surfaces a `message`-shaped body too', () => {
        expect(extractMutationError({ message: 'Validation failed' }, 'Failed to save'))
            .toBe('Validation failed');
    });

    it('still prefers `error` when a body carries both', () => {
        expect(extractMutationError({ error: 'specific', message: 'generic' }, 'fb'))
            .toBe('specific');
    });

    it('keeps the Error path the ternary already handled', () => {
        expect(extractMutationError(new Error('boom'), 'fb')).toBe('boom');
    });

    it('accepts a bare string, which the ternary turned into the fallback', () => {
        expect(extractMutationError('plain failure', 'fb')).toBe('plain failure');
    });

    it('falls back for a shapeless throw', () => {
        // The translated fallback each call site passes must survive — this
        // is what keeps the copy localised.
        expect(extractMutationError(null, 'Failed to save')).toBe('Failed to save');
        expect(extractMutationError(undefined, 'Failed to save')).toBe('Failed to save');
    });

    it('stringifies a non-string error value rather than rendering [object Object]', () => {
        expect(extractMutationError({ error: { code: 409 } }, 'fb')).toBe('{"code":409}');
    });

    it('falls back for an object carrying neither key', () => {
        expect(extractMutationError({ status: 500 }, 'Failed to save')).toBe('Failed to save');
    });
});
