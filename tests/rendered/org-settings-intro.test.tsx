/**
 * The org Settings page says WHOSE settings they are (#4850): the
 * organization's name and its address, from the org provider.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as { org: { settings: { intro: string } } };
    return {
        useTranslations: () => ({
            rich: (
                key: string,
                params: Record<string, string> & { b: (chunks: React.ReactNode) => React.ReactNode },
            ) => {
                const template = key === 'intro' ? en.org.settings.intro : key;
                const [before, rest] = template.split('<b>');
                const [bold, after] = rest.split('</b>');
                const fill = (text: string) => text.replace(/\{(\w+)\}/g, (_m, name: string) => params[name] ?? '');
                return (
                    <>
                        {fill(before)}
                        {params.b(fill(bold))}
                        {fill(after)}
                    </>
                );
            },
        }),
    };
});

jest.mock('@/lib/org-context-provider', () => ({
    useOrgContext: () => ({ orgName: 'Acme Group', orgSlug: 'acme-group' }),
}));

import { OrgSettingsIntro } from '@/app/org/[orgSlug]/(app)/settings/OrgSettingsIntro';

it('names the organization and its address', () => {
    render(<OrgSettingsIntro />);
    expect(screen.getByTestId('org-settings-intro')).toHaveTextContent(
        'Settings for Acme Group (/org/acme-group). They apply to every workspace in the organization.',
    );
    expect(screen.getByText('Acme Group')).toHaveClass('font-medium');
});
