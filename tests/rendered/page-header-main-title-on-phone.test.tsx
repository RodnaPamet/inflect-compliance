/**
 * A MAIN page's H1 is hidden and the page leads with its subtitle. On a phone
 * the sidebar that says where the reader is sits in a closed drawer, so a main
 * page whose subtitle does not name it can ask for its title to stay visible
 * below `md` (`titleOnPhone`), while desktop keeps the subtitle-led header.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

let mockPathname = '/t/acme/controls';
jest.mock('next/navigation', () => ({
    usePathname: () => mockPathname,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => new URLSearchParams(),
}));

import { PageHeader } from '@/components/layout/PageHeader';

const title = () => screen.getByTestId('page-header-title');

describe('a main page title on a phone', () => {
    beforeEach(() => {
        mockPathname = '/t/acme/controls';
    });

    it('stays hidden everywhere by default', () => {
        render(<PageHeader title="Controls" description="Your control register." />);
        expect(title()).toHaveClass('sr-only');
    });

    it('shows below md and is hidden from md up with titleOnPhone', () => {
        render(<PageHeader title="Controls" description="Your control register." titleOnPhone />);
        expect(title()).toHaveClass('md:sr-only');
        expect(title()).not.toHaveClass('sr-only');
    });

    it('a subpage shows its title whatever the prop says', () => {
        mockPathname = '/t/acme/controls/c1';
        render(<PageHeader title="AC-1" titleOnPhone />);
        expect(title()).not.toHaveClass('sr-only');
        expect(title()).not.toHaveClass('md:sr-only');
    });
});
