/**
 * @jest-environment jsdom
 */
/**
 * #2222 — the app-wide lapsed-session notice.
 *
 * Three properties, each of which the alternative designs get wrong:
 *
 *   1. **It appears from a MODULE-scope write.** The writers are already-
 *      scheduled interval callbacks; they cannot reach React state. The
 *      component subscribes with `useSyncExternalStore`, so a mark that lands
 *      between renders — or before this component ever mounts — still shows.
 *   2. **ONE notice.** ~38 pollers run on a process canvas with 20 edges and
 *      15 linked nodes. Per-hook messaging would stack 38 identical banners.
 *   3. **It OFFERS `/login`; it does not go there.** The calendar badge polls
 *      every five minutes from `SidebarNav` on every page, so an automatic
 *      redirect fired by a background poll would yank a user out of a
 *      half-finished evidence upload.
 */

// next-intl is ESM (jest can't parse it). Resolve the real en.json copy so the
// test reads what ships, and support a DOTTED namespace — `panels.sessionExpired`
// is nested, and a one-level `en[ns]` lookup would silently return the key.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const dig = (obj: unknown, path: string) =>
        path
            .split('.')
            .reduce(
                (o: unknown, k) =>
                    o && typeof o === 'object'
                        ? (o as Record<string, unknown>)[k]
                        : undefined,
                obj,
            );
    return {
        useTranslations: (ns: string) => (key: string) => {
            const v = dig(en, `${ns}.${key}`);
            return typeof v === 'string' ? v : key;
        },
        useLocale: () => 'en',
    };
});

const routerPush = jest.fn();
const routerReplace = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: routerPush, replace: routerReplace }),
    usePathname: () => '/t/acme/processes',
    useSearchParams: () => new URLSearchParams(),
}));

import { render, screen, act } from '@testing-library/react';

import { SessionExpiredNotice } from '@/components/layout/session-expired-notice';
import {
    markSessionExpired,
    __resetSessionExpiryForTests,
} from '@/lib/auth/session-expiry';

const EN = require('../../messages/en.json');
const BODY: string = EN.panels.sessionExpired.body;
const ACTION: string = EN.panels.sessionExpired.action;

beforeEach(() => {
    __resetSessionExpiryForTests();
});

afterEach(() => {
    __resetSessionExpiryForTests();
});

describe('SessionExpiredNotice', () => {
    it('renders nothing while the session is live', () => {
        render(<SessionExpiredNotice />);
        expect(screen.queryByText(BODY)).toBeNull();
        // The negative above would also pass against a component that always
        // renders null, so the next test is what gives it meaning.
    });

    it('appears when a poller marks the store, with a link to /login', () => {
        render(<SessionExpiredNotice />);

        act(() => {
            markSessionExpired();
        });

        expect(screen.getByText(BODY)).toBeInTheDocument();
        const link = screen.getByRole('link', { name: ACTION });
        expect(link).toHaveAttribute('href', '/login');
    });

    it('renders exactly ONE notice however many pollers fail', () => {
        render(<SessionExpiredNotice />);

        act(() => {
            for (let i = 0; i < 38; i += 1) markSessionExpired();
        });

        expect(screen.getAllByText(BODY)).toHaveLength(1);
    });

    it('shows a mark that landed BEFORE it mounted', () => {
        // The interval that notices first is not synchronised with this
        // component's mount — a canvas poll can fail while the shell is still
        // hydrating. `useSyncExternalStore` reads the current value rather
        // than waiting for a change event.
        markSessionExpired();
        render(<SessionExpiredNotice />);
        expect(screen.getByText(BODY)).toBeInTheDocument();
    });

    it('does not navigate on its own', () => {
        render(<SessionExpiredNotice />);
        act(() => {
            markSessionExpired();
        });

        // The redirect a future edit would reach for in a Next client
        // component is `useRouter().push/replace` — mocked at the top of this
        // file — because jsdom refuses to redefine `window.location`, so a
        // location spy cannot be the check here.
        expect(routerPush).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        // Paired with the positive, so the two negatives above are not just
        // "the component rendered nothing": the way OUT is present, and it is
        // a link the user chooses to follow rather than a jump handed to them.
        expect(screen.getByRole('link', { name: ACTION })).toHaveAttribute(
            'href',
            '/login',
        );
    });
});
