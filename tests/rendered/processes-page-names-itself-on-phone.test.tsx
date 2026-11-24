/**
 * @jest-environment jsdom
 *
 * The processes page names itself on a phone.
 *
 * Its CRUD header was retired for the canvas (the canvas's document bar says
 * what is open, the sidebar says where the reader is). On a phone neither is
 * on screen: the canvas becomes a list and the sidebar a closed drawer, so the
 * page showed tabs with no name above them. It now carries one H1, visible
 * below `md` and only an a11y landmark from `md` up, so desktop is unchanged.
 */
import { render, screen } from '@testing-library/react';

import { ProcessesClient } from '@/app/t/[tenantSlug]/(app)/processes/ProcessesClient';

jest.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/processes',
}));

jest.mock('@/components/processes/TldrawProcessWorkspace', () => ({
    TldrawProcessWorkspace: () => <div data-testid="tldraw-workspace" />,
}));

describe('the processes page title', () => {
    it('is the one H1, shown on a phone and hidden from md up', () => {
        render(<ProcessesClient tenantSlug="acme" initialProcesses={[]} />);
        const headings = screen.getAllByRole('heading', { level: 1 });
        expect(headings).toHaveLength(1);
        expect(headings[0]).toBe(screen.getByTestId('processes-page-title'));
        expect(headings[0]).toHaveClass('md:sr-only');
        expect(headings[0]).not.toHaveClass('sr-only');
        expect(headings[0].textContent).not.toBe('');
    });

    it('comes before the tab strip, so it heads the page', () => {
        render(<ProcessesClient tenantSlug="acme" initialProcesses={[]} />);
        const title = screen.getByTestId('processes-page-title');
        const tabs = screen.getByRole('tablist');
        expect(title.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
