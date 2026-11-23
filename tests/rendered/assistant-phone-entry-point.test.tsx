/**
 * On a phone the assistant opens from the top bar, and there is one sheet
 * (#5813, owner decision 2026-11-22).
 *
 * Below `md` a floating button covered the last row of a list, a select, a
 * form's primary action — and showed on the MFA gate. What this holds:
 *
 *   · the floating launcher is hidden below `md` and unchanged from `md` up;
 *   · the top-bar icon is phone-only, at least 44px to a finger, and named;
 *   · it opens the SAME sheet the launcher mounts — one instance, shared state;
 *   · it follows the launcher's gate (a reader, the sign-in gate) rather than
 *     a copy of it;
 *   · closing the sheet puts focus back on the icon that opened it.
 *
 * Asserted on classes for the breakpoints, because jsdom applies no media
 * queries; the behaviour is asserted by driving the real components.
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

// The sheet is a marker with a close button: this suite is about who opens
// it and how many there are, and the sheet's own behaviour has its suite.
jest.mock('@/components/assistant/AssistantSheet', () => ({
    AssistantSheet: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
        <div data-testid="assistant-sheet-stub" data-open={String(open)}>
            <button type="button" data-testid="assistant-sheet-stub-close" onClick={onClose}>
                close
            </button>
        </div>
    ),
}));

let mockPathname = '/t/acme/controls';
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => mockPathname,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
}));

import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { AssistantOpenProvider } from '@/components/assistant/assistant-open-context';
import { AssistantLauncher } from '@/components/assistant/AssistantLauncher';
import { AssistantTopBarButton } from '@/components/assistant/AssistantTopBarButton';
import { TenantProvider, type TenantContextValue } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const TENANT: TenantContextValue = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as TenantContextValue['role'],
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: true },
};

/** The two entry points as the tenant layout mounts them: bar icon + launcher. */
function mount({ canWrite = true }: { canWrite?: boolean } = {}) {
    const ctx = { ...TENANT, permissions: { ...TENANT.permissions, canWrite } };
    return render(
        <KeyboardShortcutProvider>
            <AssistantOpenProvider>
                <TenantProvider value={ctx}>
                    <header>
                        <AssistantTopBarButton />
                    </header>
                    <AssistantLauncher />
                </TenantProvider>
            </AssistantOpenProvider>
        </KeyboardShortcutProvider>,
    );
}

beforeEach(() => {
    mockPathname = '/t/acme/controls';
});

describe('below md the floating button is gone; from md up it is unchanged', () => {
    it('the launcher wrapper is hidden below md and shown from md', () => {
        const { container } = mount();
        const wrapper = container.querySelector('.fixed.bottom-0.right-0');
        expect(wrapper).not.toBeNull();
        const cls = wrapper!.className.split(/\s+/);
        expect(cls).toContain('hidden');
        expect(cls).toContain('md:block');
        // POSITIVE CONTROL for "unchanged from md": the button inside is the
        // same 48px round launcher it was.
        expect(screen.getByTestId('assistant-launcher').className).toContain('h-12 w-12 rounded-full');
    });

    it('the top-bar icon is phone-only, 44px to a finger, and named', () => {
        mount();
        const icon = screen.getByTestId('assistant-top-bar-button');
        const cls = icon.className.split(/\s+/);
        expect(cls).toContain('md:hidden');
        expect(cls).toContain('pointer-coarse:min-h-11');
        expect(cls).toContain('pointer-coarse:min-w-11');
        // Real English, through the catalogue — the icon has no text.
        expect(icon).toHaveAttribute('aria-label', 'Ask the assistant');
        expect(icon).toHaveAttribute('aria-haspopup', 'dialog');
        expect(icon).toHaveAttribute('aria-expanded', 'false');
    });
});

describe('one sheet, whichever entry point opens it', () => {
    it('the top-bar icon opens the sheet the launcher mounts', async () => {
        mount();
        expect(screen.queryByTestId('assistant-sheet-stub')).toBeNull();

        fireEvent.click(screen.getByTestId('assistant-top-bar-button'));

        const sheets = await screen.findAllByTestId('assistant-sheet-stub');
        expect(sheets).toHaveLength(1);
        expect(sheets[0]).toHaveAttribute('data-open', 'true');
        // Both entry points read the same state.
        expect(screen.getByTestId('assistant-launcher')).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByTestId('assistant-top-bar-button')).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByTestId('assistant-top-bar-button')).toHaveAttribute(
            'aria-label',
            'Close the assistant',
        );
    });

    it('a second tap on the icon closes it, and the conversation stays mounted', async () => {
        mount();
        const icon = screen.getByTestId('assistant-top-bar-button');
        fireEvent.click(icon);
        await screen.findByTestId('assistant-sheet-stub');
        fireEvent.click(screen.getByTestId('assistant-top-bar-button'));
        const sheets = screen.getAllByTestId('assistant-sheet-stub');
        expect(sheets).toHaveLength(1);
        expect(sheets[0]).toHaveAttribute('data-open', 'false');
    });

    it('closing the sheet returns focus to the top-bar icon, not the hidden launcher', async () => {
        mount();
        const icon = screen.getByTestId('assistant-top-bar-button');
        fireEvent.click(icon);
        const close = await screen.findByTestId('assistant-sheet-stub-close');
        act(() => {
            close.focus();
        });
        // POSITIVE CONTROL: focus starts somewhere else, so the assertion
        // below is the close moving it.
        expect(document.activeElement).toBe(close);
        fireEvent.click(close);
        expect(document.activeElement).toBe(screen.getByTestId('assistant-top-bar-button'));
    });

    it('opened from the launcher, focus still returns to the launcher', async () => {
        mount();
        // Open from the bar first, so a stale "return here" would be wrong.
        fireEvent.click(screen.getByTestId('assistant-top-bar-button'));
        fireEvent.click(await screen.findByTestId('assistant-sheet-stub-close'));

        fireEvent.click(screen.getByTestId('assistant-launcher'));
        fireEvent.click(screen.getByTestId('assistant-sheet-stub-close'));
        expect(document.activeElement).toBe(screen.getByTestId('assistant-launcher'));
    });
});

describe('the icon follows the launcher\'s gate rather than a copy of it', () => {
    it('a reader gets neither entry point', () => {
        mount({ canWrite: false });
        expect(screen.queryByTestId('assistant-top-bar-button')).toBeNull();
        expect(screen.queryByTestId('assistant-launcher')).toBeNull();
    });

    it('the MFA gate shows no assistant entry at all', () => {
        mockPathname = '/t/acme/auth/mfa';
        mount();
        expect(screen.queryByTestId('assistant-top-bar-button')).toBeNull();
        expect(screen.queryByTestId('assistant-launcher')).toBeNull();
    });

    it('a page whose path merely CONTAINS "auth" keeps both — the control', () => {
        // `/admin/auth-settings`-shaped paths are ordinary pages; only the
        // `/t/<slug>/auth/` segment is the gate.
        mockPathname = '/t/acme/admin/auth-settings';
        mount();
        expect(screen.getByTestId('assistant-top-bar-button')).toBeInTheDocument();
        expect(screen.getByTestId('assistant-launcher')).toBeInTheDocument();
    });

    it('without a launcher mounted (kill switch off) the icon renders nothing', () => {
        render(
            <AssistantOpenProvider>
                <AssistantTopBarButton />
            </AssistantOpenProvider>,
        );
        expect(screen.queryByTestId('assistant-top-bar-button')).toBeNull();
    });
});
