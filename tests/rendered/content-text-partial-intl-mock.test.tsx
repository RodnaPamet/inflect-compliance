/**
 * A component that adopts `tc` still renders in a suite whose mock of
 * next-intl has no `useLocale` (#5996): the text is shown as stored and
 * nothing is asked. Hundreds of rendered suites mock next-intl with their own
 * factory; none of them has to change for a component to show catalogue text.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import { ContentText } from '@/components/ContentText';

it('shows the stored text and asks nothing', async () => {
    const fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    window.history.pushState({}, '', '/t/acme/controls');
    render(<span data-testid="a"><ContentText text="Check the fire exits" /></span>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('a').textContent).toBe('Check the fire exits');
    expect(fetchMock).not.toHaveBeenCalled();
});
