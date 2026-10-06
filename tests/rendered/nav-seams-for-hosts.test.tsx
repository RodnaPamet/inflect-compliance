/** @jest-environment jsdom */

/**
 * Four host seams on the shell, found by projectZ while building its phone
 * navigation (projectZ #362): a club admin's bottom tab bar whose "More" tab
 * opens this drawer, a drawer whose last row is "Sign out", and a profile
 * page that keeps the language on the user record.
 *
 *   1. `NavItem` without `href` is an ACTION row: a `<button>`, same recipe.
 *   2. `AppShellFrame` tells `topChrome` whether the drawer is open, so a
 *      second opener can carry `aria-expanded`.
 *   3. `MobileNavDrawer` takes a `title`; the default stays the hamburger's
 *      label.
 *   4. `LocaleSwitcher` takes `onLocaleChange`, awaited before the cookie and
 *      the refresh; a rejection abandons the switch.
 *
 * Every new branch is paired with the unchanged default, so a seam that
 * swallowed the default (a NavItem that was ALWAYS a button, a drawer that
 * ignored its default) fails here too.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
    usePathname: () => '/t/acme/dashboard',
    useRouter: () => ({ refresh: mockRefresh }),
}));

import { AppShellFrame } from '@/components/layout/AppShellFrame';
import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';
import { MobileNavDrawer } from '@/components/layout/MobileNavDrawer';
import { NavItem } from '@/components/layout/nav-item';
import { LOCALE_COOKIE, LOCALE_LABELS } from '@/lib/locale-constants';

function Glyph(props: React.SVGProps<SVGSVGElement>) {
    return <svg {...props} />;
}

describe('NavItem — an action row', () => {
    it('without href it is a button that runs onClick, and no link', () => {
        const onClick = jest.fn();
        render(<NavItem icon={Glyph} label="Sign out" active={false} onClick={onClick} />);

        expect(screen.queryByRole('link')).toBeNull();
        const row = screen.getByRole('button', { name: 'Sign out' });
        expect(row.getAttribute('type')).toBe('button');
        // Fills the rail as the link rows do.
        expect(row.className).toContain('w-full');

        fireEvent.click(row);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('with href it is still the link it always was', () => {
        render(<NavItem href="/t/acme/dashboard" icon={Glyph} label="Board" active />);

        expect(screen.queryByRole('button')).toBeNull();
        expect(screen.getByRole('link', { name: 'Board' }).getAttribute('href')).toBe(
            '/t/acme/dashboard',
        );
    });

    it('both shapes paint the same row recipe', () => {
        render(
            <>
                <NavItem href="/t/acme/risks" icon={Glyph} label="Risks" active={false} />
                <NavItem icon={Glyph} label="Sign out" active={false} onClick={jest.fn()} />
            </>,
        );
        const link = screen.getByRole('link', { name: 'Risks' }).className;
        const button = screen.getByRole('button', { name: 'Sign out' }).className;
        expect(button.replace(/\s*w-full text-left$/, '')).toBe(link);
    });
});

describe('AppShellFrame — topChrome sees the drawer state', () => {
    it('is false until the opener runs, then true, then false again', () => {
        render(
            <AppShellFrame
                sidebar={() => null}
                mobileNav={({ open, onClose }) =>
                    open ? (
                        <button type="button" onClick={onClose}>
                            close
                        </button>
                    ) : null
                }
                topChrome={({ onMobileMenuClick, mobileNavOpen }) => (
                    <button type="button" aria-expanded={mobileNavOpen} onClick={onMobileMenuClick}>
                        More
                    </button>
                )}
            >
                <p>content</p>
            </AppShellFrame>,
        );

        const more = screen.getByRole('button', { name: 'More' });
        expect(more.getAttribute('aria-expanded')).toBe('false');

        fireEvent.click(more);
        expect(more.getAttribute('aria-expanded')).toBe('true');

        fireEvent.click(screen.getByRole('button', { name: 'close' }));
        expect(more.getAttribute('aria-expanded')).toBe('false');
    });
});

describe('MobileNavDrawer — title', () => {
    it('defaults to the hamburger label, as before', () => {
        render(
            <MobileNavDrawer open onClose={jest.fn()}>
                <a href="/dashboard">Board</a>
            </MobileNavDrawer>,
        );
        expect(screen.getByRole('dialog', { name: 'Open navigation menu' })).toBeTruthy();
    });

    it('names the dialog and its visible heading with the host title', () => {
        render(
            <MobileNavDrawer open onClose={jest.fn()} title="Menu">
                <a href="/dashboard">Board</a>
            </MobileNavDrawer>,
        );
        expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy();
        expect(screen.queryByText('Open navigation menu')).toBeNull();
    });
});

describe('LocaleSwitcher — onLocaleChange', () => {
    beforeEach(() => {
        mockRefresh.mockClear();
        document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0`;
    });

    it('awaits the host before writing the cookie and refreshing', async () => {
        let release: () => void = () => {};
        const onLocaleChange = jest.fn(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        render(<LocaleSwitcher onLocaleChange={onLocaleChange} />);

        fireEvent.click(screen.getByRole('radio', { name: LOCALE_LABELS.bg }));
        expect(onLocaleChange).toHaveBeenCalledWith('bg');
        // Still pending: nothing written yet.
        expect(document.cookie).not.toContain(`${LOCALE_COOKIE}=bg`);
        expect(mockRefresh).not.toHaveBeenCalled();

        await act(async () => {
            release();
        });
        await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
        expect(document.cookie).toContain(`${LOCALE_COOKIE}=bg`);
    });

    it('abandons the switch when the host rejects', async () => {
        const onLocaleChange = jest.fn(() => Promise.reject(new Error('offline')));
        render(<LocaleSwitcher onLocaleChange={onLocaleChange} />);

        await act(async () => {
            fireEvent.click(screen.getByRole('radio', { name: LOCALE_LABELS.bg }));
        });

        expect(onLocaleChange).toHaveBeenCalledWith('bg');
        expect(document.cookie).not.toContain(`${LOCALE_COOKIE}=bg`);
        expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('without the hook, writes the cookie and refreshes at once, as before', () => {
        render(<LocaleSwitcher />);
        fireEvent.click(screen.getByRole('radio', { name: LOCALE_LABELS.bg }));
        expect(document.cookie).toContain(`${LOCALE_COOKIE}=bg`);
        expect(mockRefresh).toHaveBeenCalled();
    });
});
