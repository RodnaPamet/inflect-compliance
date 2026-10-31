/** @jest-environment jsdom */

/**
 * A sidebar click the client router drops is clicked once more (#3099).
 *
 * The sidebar's own viewport prefetch puts ~60 requests in flight in the
 * hydration window, and a `<Link>` click issued inside it can get its 200 and
 * never commit: the URL stays put and the click does nothing. A CI trace of
 * `agent-ask-surface.spec.ts` showed exactly that on a sidebar row.
 * `useDroppedLinkClickGuard` watches the click with the same predicate as
 * `useGuardedPush` and, when nothing moved, clicks the link once more.
 *
 * The router is not involved: `<Link>` is mocked as a bare anchor, and the
 * three worlds are produced by moving `location.pathname` by hand, as in
 * use-guarded-push.test.tsx.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Settings } from 'lucide-react';
import * as React from 'react';

jest.mock('next/link', () => ({
    __esModule: true,
    default: ({ children, href, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: unknown }) => {
        delete (props as { prefetch?: unknown }).prefetch;
        return (
            // As `next/link` does: the caller's onClick first, then the link
            // prevents the document navigation to navigate client-side.
            <a href={href} onClick={(e) => { onClick?.(e); e.preventDefault(); }} {...props}>
                {children}
            </a>
        );
    },
}));

import { NavItem } from '@/components/layout/nav-item';
import { DROPPED_PUSH_GRACE_MS, useDroppedLinkClickGuard } from '@/lib/hooks/use-dropped-link-click-guard';

const FROM = '/t/acme/controls';
const TO = '/t/acme/agents/ask';

function setPathname(pathname: string) {
    window.history.replaceState({}, '', pathname);
}

function renderRow(onClick?: () => void) {
    const clicks = jest.fn();
    render(<NavItem href={TO} icon={Settings} label="Ask" active={false} onClick={() => { clicks(); onClick?.(); }} />);
    return { link: screen.getByTestId('nav-ask'), clicks };
}

beforeEach(() => {
    jest.useFakeTimers();
    setPathname(FROM);
});

afterEach(() => {
    jest.useRealTimers();
});

describe('a sidebar click', () => {
    it('is clicked once more when the router dropped it, and only once', () => {
        const { link, clicks } = renderRow();
        fireEvent.click(link);
        expect(clicks).toHaveBeenCalledTimes(1);

        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));
        expect(clicks).toHaveBeenCalledTimes(2);

        // The retry's own click arms nothing.
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS * 5));
        expect(clicks).toHaveBeenCalledTimes(2);
    });

    it('is not repeated when it navigated', () => {
        const { link, clicks } = renderRow();
        fireEvent.click(link);
        setPathname(TO);
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));
        expect(clicks).toHaveBeenCalledTimes(1);
    });

    it('is not repeated when the person went somewhere else meanwhile', () => {
        const { link, clicks } = renderRow();
        fireEvent.click(link);
        setPathname('/t/acme/assets');
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));
        expect(clicks).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a modified click (new tab)', { ctrlKey: true }],
        ['a middle click', { button: 1 }],
    ])('arms nothing for %s', (_label, init) => {
        const { link, clicks } = renderRow();
        fireEvent.click(link, init);
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));
        expect(clicks).toHaveBeenCalledTimes(1);
    });

    it('arms nothing for the page already open', () => {
        setPathname(TO);
        const { link, clicks } = renderRow();
        fireEvent.click(link);
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));
        expect(clicks).toHaveBeenCalledTimes(1);
    });

    it('still runs the row’s own onClick first', () => {
        const order: string[] = [];
        const { link } = renderRow(() => order.push('row'));
        fireEvent.click(link);
        expect(order).toEqual(['row']);
    });
});

describe('useDroppedLinkClickGuard', () => {
    it('tells the host through onRetry, with the page the click started on', () => {
        const onRetry = jest.fn();
        function Row() {
            const guard = useDroppedLinkClickGuard(TO, onRetry);
            return (
                <a href={TO} data-testid="row" onClick={(e) => { guard(e); e.preventDefault(); }}>
                    Ask
                </a>
            );
        }
        render(<Row />);
        fireEvent.click(screen.getByTestId('row'));
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onRetry.mock.calls[0][0]).toMatchObject({ route: FROM });
        expect(onRetry.mock.calls[0][0].elapsedMs).toBeGreaterThanOrEqual(DROPPED_PUSH_GRACE_MS);
    });
});
