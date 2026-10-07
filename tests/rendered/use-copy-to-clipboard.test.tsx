/**
 * Tests for the Epic 56 clipboard hook.
 *
 * Runs in the jsdom project so React state + effects behave realistically.
 * `navigator.clipboard` is stubbed per-test so we can exercise both the
 * Clipboard API success/error paths and the legacy execCommand fallback.
 */

import { act, renderHook } from '@testing-library/react';

import { useCopyToClipboard } from '@inflect/ui/components/ui/hooks/use-copy-to-clipboard';

const realClipboard = Object.getOwnPropertyDescriptor(
    window.navigator,
    'clipboard',
);

function mockClipboard(impl: {
    writeText?: (value: string) => Promise<void>;
    write?: (items: ClipboardItem[]) => Promise<void>;
} | null) {
    Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: impl,
    });
}

afterEach(() => {
    if (realClipboard) {
        Object.defineProperty(window.navigator, 'clipboard', realClipboard);
    } else {
        // @ts-expect-error: deleting the polyfilled descriptor is fine in jsdom.
        delete window.navigator.clipboard;
    }
});

describe('useCopyToClipboard', () => {
    it('writes via navigator.clipboard and flags `copied` on success', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        mockClipboard({ writeText });
        const { result } = renderHook(() => useCopyToClipboard({ timeout: 0 }));

        expect(result.current.copied).toBe(false);
        await act(async () => {
            const ok = await result.current.copy('hello');
            expect(ok).toBe(true);
        });
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(result.current.copied).toBe(true);
        expect(result.current.error).toBeNull();
    });

    it('resets `copied` after the timeout elapses', async () => {
        jest.useFakeTimers();
        mockClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });
        const { result } = renderHook(() =>
            useCopyToClipboard({ timeout: 1000 }),
        );

        await act(async () => {
            await result.current.copy('value');
        });
        expect(result.current.copied).toBe(true);

        act(() => {
            jest.advanceTimersByTime(1001);
        });
        expect(result.current.copied).toBe(false);
        jest.useRealTimers();
    });

    it('captures the error and returns false when the clipboard write rejects', async () => {
        const writeText = jest
            .fn()
            .mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
        mockClipboard({ writeText });
        const onError = jest.fn();
        const { result } = renderHook(() => useCopyToClipboard({ timeout: 0 }));

        let ok = true;
        await act(async () => {
            ok = await result.current.copy('secret', { onError });
        });
        expect(ok).toBe(false);
        expect(result.current.copied).toBe(false);
        expect(result.current.error).toBeInstanceOf(Error);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('reset() clears both `copied` and `error`', async () => {
        mockClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });
        const { result } = renderHook(() => useCopyToClipboard({ timeout: 0 }));

        await act(async () => {
            await result.current.copy('v');
        });
        expect(result.current.copied).toBe(true);

        act(() => {
            result.current.reset();
        });
        expect(result.current.copied).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('falls back to execCommand when Clipboard API is unavailable', async () => {
        mockClipboard(null);
        const execSpy = jest.fn(() => true);
        Object.defineProperty(document, 'execCommand', {
            configurable: true,
            value: execSpy,
        });

        const { result } = renderHook(() => useCopyToClipboard({ timeout: 0 }));

        let ok = false;
        await act(async () => {
            ok = await result.current.copy('legacy');
        });
        expect(ok).toBe(true);
        expect(execSpy).toHaveBeenCalledWith('copy');
    });

    it('returns an error when no clipboard path is available', async () => {
        mockClipboard(null);
        const execSpy = jest.fn(() => false);
        Object.defineProperty(document, 'execCommand', {
            configurable: true,
            value: execSpy,
        });

        const { result } = renderHook(() => useCopyToClipboard({ timeout: 0 }));

        let ok = true;
        await act(async () => {
            ok = await result.current.copy('v');
        });
        expect(ok).toBe(false);
        expect(result.current.error).toBeInstanceOf(Error);
    });

    it('fires onSuccess once per successful copy', async () => {
        mockClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });
        const onSuccess = jest.fn();
        const { result } = renderHook(() => useCopyToClipboard({ timeout: 0 }));

        await act(async () => {
            await result.current.copy('v', { onSuccess });
            await result.current.copy('v', { onSuccess });
        });
        expect(onSuccess).toHaveBeenCalledTimes(2);
    });
});
