/**
 * The root error and 404 pages, and the legacy /dashboard shim, send a user
 * to the workspace picker at /tenants (#5093).
 *
 * /dashboard used to redirect to the OLDEST membership, without an ACTIVE
 * filter and without reading an SSO-scoped session, so the edge refused it
 * or opened the wrong workspace. /tenants resolves where a session may land.
 */
import { render, screen } from '@testing-library/react';

const redirectMock = jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
});
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirectMock(url) }));
jest.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));

import NotFound from '@/app/not-found';
import DashboardRedirect from '@/app/dashboard/page';

it('the 404 page links to the workspace picker', async () => {
    render(await NotFound());
    expect(screen.getByRole('link', { name: 'returnToDashboard' })).toHaveAttribute('href', '/tenants');
});

it('the legacy /dashboard shim delegates to the picker', () => {
    expect(() => DashboardRedirect()).toThrow('NEXT_REDIRECT /tenants');
    expect(redirectMock).toHaveBeenCalledWith('/tenants');
});
