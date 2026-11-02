/**
 * Branch coverage for the shared mutation error helper.
 *
 * `extractMutationError` is the single funnel every mutation surface uses
 * to turn an arbitrary thrown value into a string the user sees — its
 * branch table (Error / string / object-with-error / object-with-message /
 * object-with-envelope / fallback) is the contract. (The former
 * `optimisticListUpdate` React Query patcher was removed with the SWR
 * migration — optimistic updates now go through `useTenantMutation`.)
 */
import { ApiClientError } from '@/lib/api-client';
import { extractMutationError } from '@/lib/mutations';

describe('extractMutationError', () => {
    it('returns the message of an Error instance', () => {
        expect(extractMutationError(new Error('boom'))).toBe('boom');
    });

    it('returns a thrown string verbatim', () => {
        expect(extractMutationError('plain failure')).toBe('plain failure');
    });

    it('reads the `error` field of an object', () => {
        expect(extractMutationError({ error: 'server said no' })).toBe(
            'server said no',
        );
    });

    it('falls back to the `message` field when `error` is absent', () => {
        expect(extractMutationError({ message: 'message field' })).toBe(
            'message field',
        );
    });

    it('prefers `error` over `message` when both are present', () => {
        expect(
            extractMutationError({ error: 'E', message: 'M' }),
        ).toBe('E');
    });

    it('reads the message of the API error envelope (#4691)', () => {
        expect(
            extractMutationError({ error: { code: 'FORBIDDEN', message: 'Not yours to change' } }, 'fb'),
        ).toBe('Not yours to change');
    });

    it('falls back, rather than printing JSON, for an `error` object with no message', () => {
        // It used to JSON-stringify the object, so `{"code":"X",…}` reached the screen.
        expect(
            extractMutationError({ error: { code: 'X', detail: 'y' } }, 'fallback sentence'),
        ).toBe('fallback sentence');
    });

    it('uses the default fallback for an object with neither field', () => {
        expect(extractMutationError({ unrelated: 1 })).toBe(
            'An error occurred',
        );
    });

    it('honours a custom fallback for an object with neither field', () => {
        expect(extractMutationError({}, 'custom fallback')).toBe(
            'custom fallback',
        );
    });

    it('uses the fallback for null', () => {
        expect(extractMutationError(null, 'nil fallback')).toBe(
            'nil fallback',
        );
    });

    it('uses the fallback for undefined', () => {
        expect(extractMutationError(undefined)).toBe('An error occurred');
    });

    it('uses the fallback for a bare number', () => {
        expect(extractMutationError(42, 'numeric')).toBe('numeric');
    });

    // #4987 — a page shows the server's sentence or its own, never a status.
    it("shows an ApiClientError's server reason", () => {
        const err = new ApiClientError('Not yours', 'FORBIDDEN', 403, undefined, 'r1', 'Not yours');
        expect(extractMutationError(err, 'fb')).toBe('Not yours');
    });

    it('uses the fallback, not the synthesised status line, when the server gave no reason', () => {
        const err = new ApiClientError('Request failed with status 502', 'UNKNOWN', 502);
        expect(extractMutationError(err, 'Could not save')).toBe('Could not save');
    });

    it("uses the fallback for a failed fetch's TypeError, whose text is the browser's", () => {
        expect(extractMutationError(new TypeError('Failed to fetch'), 'Could not save')).toBe(
            'Could not save',
        );
    });

    it('uses the fallback for an Error with no message', () => {
        expect(extractMutationError(new Error(''), 'Could not save')).toBe('Could not save');
    });
});
