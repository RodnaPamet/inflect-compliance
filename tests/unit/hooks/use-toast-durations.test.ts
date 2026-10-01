/** @jest-environment jsdom */
/**
 * `useToast()` applies its documented durations — including when the
 * caller passes no options at all.
 *
 * (The environment pragma is the FIRST docblock on purpose: Jest reads
 * pragmas only from the first comment block in the file, so putting it
 * below this one silently left the suite in the `node` project, where
 * `renderHook` has no DOM.)
 *
 * The hook's header documents four locked durations: success 3000,
 * info 4000, warning 5000, error `Infinity` ("sticky-with-dismiss; the
 * user must acknowledge"). The implementation forwarded them only when
 * the caller supplied an `opts` object, on the stated grounds that the
 * `<Toaster>` mount's `toastOptions` set the default per variant.
 *
 * It does not. `src/app/providers.tsx` mounts
 * `<Toaster theme="dark" position="top-right" richColors closeButton
 * duration={3000} />` — one flat number, no `toastOptions` key
 * anywhere. So on the single-argument call (the common one across the
 * app) three of the four documented durations were fiction, and the
 * consequential one was `error`: a failure the user had not
 * acknowledged vanished after three seconds, which is the exact thing
 * `Infinity` was chosen to prevent.
 *
 * Both halves are asserted here, because the fix is only meaningful as
 * a pair: the locked value arrives when nothing is passed, AND an
 * explicit `opts.duration` still overrides it.
 */
import { renderHook } from '@testing-library/react';

/** What the hook is expected to hand sonner. */
type ToastArgs = [message: string, opts?: { duration?: number }];

const success = jest.fn((..._args: ToastArgs) => 'id-success');
const error = jest.fn((..._args: ToastArgs) => 'id-error');
const info = jest.fn((..._args: ToastArgs) => 'id-info');
const warning = jest.fn((..._args: ToastArgs) => 'id-warning');
const dismiss = jest.fn((_id?: string | number) => undefined);

jest.mock('sonner', () => ({
    toast: {
        success: (...args: ToastArgs) => success(...args),
        error: (...args: ToastArgs) => error(...args),
        info: (...args: ToastArgs) => info(...args),
        warning: (...args: ToastArgs) => warning(...args),
        dismiss: (id?: string | number) => dismiss(id),
    },
}));

import { useToast } from '@/components/ui/hooks/use-toast';

/** The table the hook's own docstring publishes. */
const DOCUMENTED: ReadonlyArray<
    readonly [
        'success' | 'error' | 'info' | 'warning',
        jest.Mock<string, ToastArgs>,
        number,
    ]
> = [
    ['success', success, 3000],
    ['info', info, 4000],
    ['warning', warning, 5000],
    ['error', error, Infinity],
];

beforeEach(() => {
    for (const mock of [success, error, info, warning, dismiss]) {
        mock.mockClear();
    }
});

function api() {
    return renderHook(() => useToast()).result.current;
}

describe('the locked durations reach sonner', () => {
    it.each(DOCUMENTED.map(([name, , ms]) => [name, ms] as const))(
        '%s() with NO options forwards duration %p',
        (name, ms) => {
            const mock = DOCUMENTED.find(([n]) => n === name)![1];
            api()[name]('Something happened');
            expect(mock).toHaveBeenCalledTimes(1);
            expect(mock).toHaveBeenCalledWith('Something happened', {
                duration: ms,
            });
        },
    );

    it('error is sticky, not merely long — the value is Infinity', () => {
        // Called out separately because this is the one with a
        // user-visible consequence, and because a finite "very large"
        // number would satisfy a `>= 3000` style assertion while still
        // dismissing itself eventually.
        api().error('Save failed');
        const [, opts] = error.mock.calls[0]!;
        expect(opts?.duration).toBe(Infinity);
        expect(Number.isFinite(opts?.duration)).toBe(false);
    });

    it('the four durations are DISTINCT — not one value four times', () => {
        // The negative control. The pre-fix behaviour was effectively a
        // single flat 3000 for every variant; a fix that forwarded the
        // same number everywhere would pass a per-variant assertion
        // written with the wrong expectation and is worth excluding
        // explicitly.
        for (const [name] of DOCUMENTED) api()[name]('m');
        const forwarded = DOCUMENTED.map(
            ([, mock]) => mock.mock.calls[0]![1]?.duration,
        );
        expect(new Set(forwarded).size).toBe(DOCUMENTED.length);
    });
});

describe('an explicit duration still overrides the lock', () => {
    it('forwards the caller value and keeps the other options', () => {
        api().error('Upload failed', {
            duration: 12_000,
            description: 'Retrying in the background',
        });
        expect(error).toHaveBeenCalledWith('Upload failed', {
            duration: 12_000,
            description: 'Retrying in the background',
        });
    });

    it('a caller-supplied 0 survives — `??`, not `||`', () => {
        // `0` is a legitimate sonner duration and is falsy, so a `||`
        // would silently replace it with the locked value. Nothing else
        // in the suite distinguishes the two operators.
        api().success('Saved', { duration: 0 });
        expect(success).toHaveBeenCalledWith('Saved', { duration: 0 });
    });

    it('opts with no duration key falls back to the lock', () => {
        api().info('Settings updated', { description: 'All members' });
        expect(info).toHaveBeenCalledWith('Settings updated', {
            description: 'All members',
            duration: 4000,
        });
    });
});

describe('the rest of the hook contract is unchanged', () => {
    it('returns the id sonner handed back', () => {
        expect(api().success('Saved')).toBe('id-success');
    });

    it('dismiss passes through, with and without an id', () => {
        api().dismiss('abc');
        api().dismiss();
        expect(dismiss.mock.calls).toEqual([['abc'], [undefined]]);
    });

    it('hands back a stable object across re-renders', () => {
        const hook = renderHook(() => useToast());
        const first = hook.result.current;
        hook.rerender();
        expect(hook.result.current).toBe(first);
    });
});
