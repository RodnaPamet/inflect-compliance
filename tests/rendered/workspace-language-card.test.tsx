/**
 * THE WORKSPACE LANGUAGE CARD OFFERS EVERY SUPPORTED LANGUAGE BY ITS OWN NAME,
 * SAYS WHAT IT CHANGES AND WHAT IT DOES NOT, AND SENDS WHAT IT SHOWS.
 *
 *   1. Each supported locale is a radio, named by its endonym with its `lang`,
 *      and the stored one is selected.
 *   2. The card says it does not change anyone's interface language.
 *   3. Save is offered only for a change, PUTs the chosen locale, and adopts
 *      the server's answer.
 *   4. A refused save says so and keeps the stored value as the baseline.
 *   5. On a phone the choices stack and Save fills the width.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    return { useTenantApiUrl: () => apiUrl };
});

import { WorkspaceLanguageCard } from '@/app/t/[tenantSlug]/(app)/admin/WorkspaceLanguageCard';
import { LOCALE_LABELS, SUPPORTED_LOCALES } from '@/lib/locale-constants';

const EN = (require('../../messages/en.json') as { workspaceLanguage: Record<string, string> }).workspaceLanguage;

function respond(ok: boolean, body: unknown) {
    const fetchMock = jest.fn().mockResolvedValue({ ok, status: ok ? 200 : 403, json: async () => body });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
}

afterEach(() => jest.restoreAllMocks());

describe('WorkspaceLanguageCard', () => {
    it('offers every supported language by its own name, with the stored one selected', () => {
        render(<WorkspaceLanguageCard initialLocale="en" />);
        for (const locale of SUPPORTED_LOCALES) {
            const radio = screen.getByTestId(`workspace-language-${locale}`);
            expect(radio).toHaveAttribute('role', 'radio');
            expect(screen.getByRole('radio', { name: LOCALE_LABELS[locale] })).toBe(radio);
            expect(screen.getByText(LOCALE_LABELS[locale])).toHaveAttribute('lang', locale);
        }
        expect(screen.getByTestId('workspace-language-en')).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByTestId('workspace-language-bg')).toHaveAttribute('aria-checked', 'false');
    });

    it('says what it affects, and that it is not anybody\'s interface language', () => {
        render(<WorkspaceLanguageCard initialLocale="en" />);
        expect(screen.getByText(EN.description)).toBeInTheDocument();
        expect(screen.getByTestId('workspace-language-not-interface')).toHaveTextContent(EN.notInterface);
    });

    it('offers Save only for a change, PUTs the chosen language and adopts the answer', async () => {
        const user = userEvent.setup();
        const fetchMock = respond(true, { defaultLocale: 'bg' });
        render(<WorkspaceLanguageCard initialLocale="en" />);

        const save = screen.getByTestId('workspace-language-save');
        expect(save).toBeDisabled();

        await user.click(screen.getByTestId('workspace-language-bg'));
        expect(save).toBeEnabled();
        await user.click(save);

        await waitFor(() => expect(screen.getByText(EN.saved)).toBeInTheDocument());
        expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/admin/workspace-language', expect.objectContaining({
            method: 'PUT',
            body: JSON.stringify({ defaultLocale: 'bg' }),
        }));
        // The saved value is the new baseline: nothing left to save.
        expect(screen.getByTestId('workspace-language-bg')).toHaveAttribute('aria-checked', 'true');
        expect(save).toBeDisabled();
    });

    it('a refused save says so and keeps the stored value as the baseline', async () => {
        const user = userEvent.setup();
        respond(false, {});
        render(<WorkspaceLanguageCard initialLocale="en" />);

        await user.click(screen.getByTestId('workspace-language-bg'));
        await user.click(screen.getByTestId('workspace-language-save'));

        await waitFor(() => expect(screen.getByText(EN.saveFailed)).toBeInTheDocument());
        expect(screen.queryByText(EN.saved)).not.toBeInTheDocument();
        // Still a pending change against the stored English, so Save stays offered.
        expect(screen.getByTestId('workspace-language-save')).toBeEnabled();
    });

    it('stacks the choices and fills the width with Save on a phone', () => {
        render(<WorkspaceLanguageCard initialLocale="en" />);
        const group = screen.getByRole('radiogroup');
        expect(group).toHaveClass('flex-col', 'sm:flex-row');
        expect(screen.getByTestId('workspace-language-save')).toHaveClass('max-sm:w-full');
    });
});
