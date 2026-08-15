/**
 * The in-app half of the unsaved-work guard.
 *
 * `beforeunload` covers tab close, refresh and leaving the origin. It does
 * NOT fire for App Router client-side transitions — so on the process canvas
 * a sidebar click discarded unsaved work with no prompt at all, which is the
 * commoner case: closing a tab is deliberate, clicking away is a reflex.
 *
 * These exercise the decision the hook actually makes, because the interesting
 * part is everything it must NOT intercept. A guard that prompts on a
 * new-tab click or an anchor to the current page is worse than none — users
 * learn to dismiss it, and then it fails when it matters.
 */
import * as React from 'react';
import { render, cleanup } from '@testing-library/react';
import { useUnsavedNavigationGuard } from '@/lib/hooks';

const MESSAGE = 'Leave and lose them?';

function Harness({ dirty, href, target, download }: {
    dirty: boolean;
    href: string;
    target?: string;
    download?: boolean;
}) {
    useUnsavedNavigationGuard(dirty, MESSAGE);
    return (
        <a
            href={href}
            {...(target ? { target } : {})}
            {...(download ? { download: '' } : {})}
            data-testid="link"
        >
            go
        </a>
    );
}

/** Dispatch a real capture-phase-visible click and report whether it survived. */
function clickLink(el: Element, init: MouseEventInit = {}): boolean {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    el.dispatchEvent(ev);
    return !ev.defaultPrevented;
}

describe('useUnsavedNavigationGuard', () => {
    const confirmSpy = jest.spyOn(window, 'confirm');
    afterEach(() => {
        confirmSpy.mockReset();
        cleanup();
    });

    it('blocks an in-app link when the user declines', () => {
        confirmSpy.mockReturnValue(false);
        const { getByTestId } = render(<Harness dirty href="/t/acme/dashboard" />);
        expect(clickLink(getByTestId('link'))).toBe(false);
        expect(confirmSpy).toHaveBeenCalledWith(MESSAGE);
    });

    it('allows it when the user accepts', () => {
        confirmSpy.mockReturnValue(true);
        const { getByTestId } = render(<Harness dirty href="/t/acme/dashboard" />);
        expect(clickLink(getByTestId('link'))).toBe(true);
    });

    it('does not prompt at all when there is nothing to lose', () => {
        const { getByTestId } = render(<Harness dirty={false} href="/t/acme/dashboard" />);
        expect(clickLink(getByTestId('link'))).toBe(true);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    // ─── The cases it must NOT intercept ───────────────────────────────

    it('ignores a modified click — it opens a new tab, this document keeps its state', () => {
        const { getByTestId } = render(<Harness dirty href="/t/acme/dashboard" />);
        expect(clickLink(getByTestId('link'), { metaKey: true })).toBe(true);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('ignores target=_blank for the same reason', () => {
        const { getByTestId } = render(<Harness dirty href="/t/acme/x" target="_blank" />);
        expect(clickLink(getByTestId('link'))).toBe(true);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('ignores a download link — the page does not go anywhere', () => {
        const { getByTestId } = render(<Harness dirty href="/api/export.csv" download />);
        expect(clickLink(getByTestId('link'))).toBe(true);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('ignores a hash link — same page, nothing lost', () => {
        const { getByTestId } = render(<Harness dirty href="#section" />);
        expect(clickLink(getByTestId('link'))).toBe(true);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('ignores an anchor to the CURRENT path — no navigation happens', () => {
        const { getByTestId } = render(
            <Harness dirty href={window.location.pathname} />,
        );
        expect(clickLink(getByTestId('link'))).toBe(true);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('ignores an external origin — beforeunload owns that exit', () => {
        const { getByTestId } = render(<Harness dirty href="https://example.com/x" />);
        expect(clickLink(getByTestId('link'))).toBe(true);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('removes the listener when the work becomes clean', () => {
        confirmSpy.mockReturnValue(false);
        const { getByTestId, rerender } = render(<Harness dirty href="/t/acme/dashboard" />);
        expect(clickLink(getByTestId('link'))).toBe(false);

        rerender(<Harness dirty={false} href="/t/acme/dashboard" />);
        confirmSpy.mockClear();
        expect(clickLink(getByTestId('link'))).toBe(true);
        expect(confirmSpy).not.toHaveBeenCalled();
    });
});
