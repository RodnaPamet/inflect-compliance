/**
 * THE WORKSPACE LANGUAGE TOGGLE, ON ITS OWN (#5965). The admin hub's own
 * test covers where it sits and who sees it; this one covers the control.
 *
 *   1. Each supported language is a radio showing its short code, whose
 *      accessible name is its endonym in its own `lang`.
 *   2. The help icon beside the label says what it affects, and that it is
 *      not anybody's interface language.
 *   3. While a save runs the group is busy and the other language cannot be
 *      chosen; once it answers both are offered again.
 */
import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    return { useTenantApiUrl: () => apiUrl };
});

const toast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn() };
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({
    __esModule: true,
    useToast: () => toast,
}));

import { WorkspaceLanguageToggle } from '@/app/t/[tenantSlug]/(app)/admin/WorkspaceLanguageToggle';
import { LOCALE_LABELS, LOCALE_SHORT_LABELS, SUPPORTED_LOCALES } from '@/lib/locale-constants';
import { TooltipProvider } from '@/components/ui/tooltip';

const EN = (require('../../messages/en.json') as { workspaceLanguage: Record<string, string> }).workspaceLanguage;

afterEach(() => {
    jest.restoreAllMocks();
    Object.values(toast).forEach((f) => f.mockClear());
});

describe('WorkspaceLanguageToggle', () => {
    it('names every language by its endonym, in its own lang, behind its short code', () => {
        const { container } = render(<WorkspaceLanguageToggle initialLocale="en" />);
        expect(screen.getByRole('radiogroup', { name: EN.title })).toBeInTheDocument();
        for (const locale of SUPPORTED_LOCALES) {
            const radio = screen.getByRole('radio', { name: LOCALE_LABELS[locale] });
            expect(radio).toHaveAttribute('id', `workspace-language-${locale}`);
            expect(radio).toHaveTextContent(LOCALE_SHORT_LABELS[locale]);
            expect(screen.getByText(LOCALE_LABELS[locale])).toHaveAttribute('lang', locale);
        }
        expect(screen.getByRole('radio', { name: LOCALE_LABELS.en })).toHaveAttribute('aria-checked', 'true');
        expect(container.querySelector('#workspace-language-toggle')).toHaveTextContent(EN.title);
    });

    it('its help icon says what it affects, and that it is not anybody\'s interface language', async () => {
        const user = userEvent.setup();
        // No open delay, so the tooltip does not race the query's timeout.
        render(
            <TooltipProvider delayDuration={0}>
                <WorkspaceLanguageToggle initialLocale="en" />
            </TooltipProvider>,
        );
        await user.hover(screen.getByRole('button', { name: `More info about ${EN.title}` }));
        const tip = await screen.findByRole('tooltip');
        expect(tip).toHaveTextContent(EN.description);
        expect(tip).toHaveTextContent(EN.notInterface);
    });

    it('is busy while a save runs, and the other language cannot be chosen until it answers', async () => {
        const user = userEvent.setup();
        let answer!: (v: unknown) => void;
        const fetchMock = jest.fn(
            () => new Promise((resolve) => { answer = resolve; }),
        );
        global.fetch = fetchMock as unknown as typeof fetch;
        const { container } = render(<WorkspaceLanguageToggle initialLocale="en" />);
        const box = container.querySelector('#workspace-language-toggle')!;

        await user.click(screen.getByRole('radio', { name: LOCALE_LABELS.bg }));

        expect(box).toHaveAttribute('aria-busy', 'true');
        expect(screen.getByRole('radio', { name: LOCALE_LABELS.bg })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('radio', { name: LOCALE_LABELS.en })).toBeDisabled();
        expect(screen.getByRole('radio', { name: LOCALE_LABELS.bg })).toBeEnabled();
        await user.click(screen.getByRole('radio', { name: LOCALE_LABELS.en }));
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            answer({ ok: true, status: 200, json: async () => ({ defaultLocale: 'bg' }) });
        });
        await waitFor(() => expect(box).not.toHaveAttribute('aria-busy'));
        expect(screen.getByRole('radio', { name: LOCALE_LABELS.en })).toBeEnabled();
        expect(toast.success).toHaveBeenCalledWith(EN.saved);
    });
});
