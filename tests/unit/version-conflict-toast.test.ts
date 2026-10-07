/** @jest-environment jsdom */
/**
 * Coverage for the version-conflict (HTTP 409 / STALE_DATA) toast
 * helper. The helper only touches `toast.error` + a Reload action,
 * so a minimal `ToastApi` mock exercises every branch.
 */
import { surfaceVersionConflict } from '@/lib/processes/version-conflict-toast';
import type { ToastApi } from '@inflect/ui/components/ui/hooks/use-toast';

function makeToast(): jest.Mocked<ToastApi> {
    return {
        success: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        dismiss: jest.fn(),
    } as unknown as jest.Mocked<ToastApi>;
}

// jsdom does not expose the WHATWG `Response` global. The helper only
// reads `.status` and `.json()`, so a minimal stand-in is sufficient.
function makeResponse(
    status: number,
    body: unknown,
    opts: { jsonThrows?: boolean } = {},
): Response {
    return {
        status,
        json: async () => {
            if (opts.jsonThrows) throw new SyntaxError('Unexpected token');
            return body;
        },
    } as unknown as Response;
}

describe('surfaceVersionConflict', () => {
    it('returns false and shows no toast for a non-409 response', async () => {
        const toast = makeToast();
        const onReload = jest.fn();
        const res = makeResponse(200, {});

        const handled = await surfaceVersionConflict(res, toast, onReload);

        expect(handled).toBe(false);
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('surfaces a versioned toast when the body carries currentVersion', async () => {
        const toast = makeToast();
        const onReload = jest.fn();
        const res = makeResponse(409, {
            error: { code: 'STALE_DATA', details: { currentVersion: 7 } },
        });

        const handled = await surfaceVersionConflict(res, toast, onReload);

        expect(handled).toBe(true);
        expect(toast.error).toHaveBeenCalledTimes(1);
        const [message, opts] = toast.error.mock.calls[0];
        expect(message).toMatch(/Someone else saved this map/);
        expect(opts?.description).toBe(
            'Server version is now v7; your edits will be lost on reload.',
        );
        expect(opts?.action).toEqual({ label: 'Reload', onClick: onReload });

        // The wired action invokes the supplied reload callback.
        (opts?.action as unknown as { onClick: () => void }).onClick();
        expect(onReload).toHaveBeenCalledTimes(1);
    });

    it('falls back to the generic description when currentVersion is absent', async () => {
        const toast = makeToast();
        const res = makeResponse(409, { error: {} });

        const handled = await surfaceVersionConflict(res, toast, jest.fn());

        expect(handled).toBe(true);
        const [, opts] = toast.error.mock.calls[0];
        expect(opts?.description).toBe('Your edits will be lost on reload.');
    });

    it('is fail-soft on an unparseable 409 body (json throws)', async () => {
        const toast = makeToast();
        // A 409 whose body is not valid JSON — res.json() rejects.
        const res = makeResponse(409, null, { jsonThrows: true });

        const handled = await surfaceVersionConflict(res, toast, jest.fn());

        expect(handled).toBe(true);
        expect(toast.error).toHaveBeenCalledTimes(1);
        const [, opts] = toast.error.mock.calls[0];
        expect(opts?.description).toBe('Your edits will be lost on reload.');
    });
});
