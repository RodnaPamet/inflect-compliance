/**
 * A page header's actions on a phone: the primary, at most one more, and a
 * "⋯" menu holding the rest (owner decision, 2026-11-22; #5815).
 *
 * What a phone showed before: every action as a button, wrapped by
 * `flex-wrap-reverse` into a ragged, right-aligned stack in REVERSE reading
 * order, beside a title squeezed into half the screen — and a page that wrapped
 * its actions in its own `flex` div got no wrapping at all, so the buttons were
 * clipped at 360 px.
 *
 * jsdom has no layout, so the breakpoint behaviour is held by the classes that
 * produce it (`hidden md:contents`, `md:hidden`, `max-md:order-first`, the
 * header's `flex-col sm:flex-row`); the menu itself is driven for real.
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    usePathname: () => '/t/acme/agents/agent-1',
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => new URLSearchParams(),
}));

import {
    OverflowAction,
    PageActions,
    PrimaryAction,
} from '@/components/layout/PageActions';
import { PageHeader } from '@/components/layout/PageHeader';

/** A component that renders an overflow action — the registry must see through it. */
function WrappedOverflow({ onSelect }: { onSelect: () => void }) {
    return <OverflowAction label="Use for Ask" onSelect={onSelect} data-testid="menu-ask" />;
}

/** The menu is loaded with `next/dynamic`, a tick after mount: await it. */
async function openMenu() {
    fireEvent.click(await screen.findByTestId('page-actions-more'));
    return screen.getByTestId('page-actions-menu');
}

describe('PageActions — overflow on a phone', () => {
    it('offers every overflow action in a labelled "⋯" menu, in source order', async () => {
        const onAsk = jest.fn();
        render(
            <PageActions>
                <Button testId="amend">Amend</Button>
                <WrappedOverflow onSelect={onAsk} />
                <OverflowAction label="Connect" onSelect={jest.fn()} data-testid="menu-connect" />
                <OverflowAction label="Open on canvas" href="/t/acme/processes" data-testid="menu-canvas" />
                <Button testId="stop">Stop agent</Button>
            </PageActions>,
        );

        const trigger = await screen.findByTestId('page-actions-more');
        // Labelled, because it is an icon-only button.
        expect(trigger).toHaveAttribute('aria-label', 'More actions');

        const menu = await openMenu();
        const items = within(menu).getAllByRole('menuitem');
        expect(items.map((i) => i.textContent)).toEqual([
            'Use for Ask',
            'Connect',
            'Open on canvas',
        ]);
        // The two visible actions are not duplicated into the menu.
        expect(within(menu).queryByText('Amend')).toBeNull();
        expect(within(menu).queryByText('Stop agent')).toBeNull();
    });

    it('choosing a menu item runs the action and closes the menu', async () => {
        const onAsk = jest.fn();
        render(
            <PageActions>
                <WrappedOverflow onSelect={onAsk} />
            </PageActions>,
        );
        const menu = await openMenu();
        fireEvent.click(within(menu).getByTestId('menu-ask'));
        expect(onAsk).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('page-actions-menu')).toBeNull();
    });

    it('a navigating item is a real link', async () => {
        render(
            <PageActions>
                <OverflowAction label="Open on canvas" href="/t/acme/processes" data-testid="menu-canvas" />
            </PageActions>,
        );
        const menu = await openMenu();
        const link = within(menu).getByTestId('menu-canvas');
        expect(link.tagName).toBe('A');
        expect(link).toHaveAttribute('href', '/t/acme/processes');
    });

    it('menu items reach 44 px on touch', async () => {
        render(
            <PageActions>
                <OverflowAction label="Connect" onSelect={jest.fn()} data-testid="menu-connect" />
                <OverflowAction label="Canvas" href="/x" data-testid="menu-canvas" />
            </PageActions>,
        );
        const menu = await openMenu();
        for (const id of ['menu-connect', 'menu-canvas']) {
            expect(within(menu).getByTestId(id).className).toContain('pointer-coarse:min-h-11');
        }
    });

    it('a heading groups a run of related items', async () => {
        render(
            <PageActions>
                <OverflowAction label="NIS2 gap" href="/a" />
                <OverflowAction label="Frameworks" href="/b" group="Related" />
                <OverflowAction label="Findings" href="/c" group="Related" />
            </PageActions>,
        );
        const menu = await openMenu();
        expect(within(menu).getAllByText('Related')).toHaveLength(1);
        expect(within(menu).getAllByRole('separator')).toHaveLength(1);
    });

    it('the menu trigger exists only on a phone, and only when something overflows', async () => {
        const { rerender } = render(
            <PageActions>
                <Button testId="only">Only</Button>
            </PageActions>,
        );
        expect(screen.queryByTestId('page-actions-more')).toBeNull();

        rerender(
            <PageActions>
                <Button testId="only">Only</Button>
                <OverflowAction label="More" onSelect={jest.fn()} />
            </PageActions>,
        );
        const triggerSlot = screen.getByTestId('page-actions-more-slot');
        expect(triggerSlot).toContainElement(await screen.findByTestId('page-actions-more'));
        expect(triggerSlot.className).toContain('md:hidden');
        // And after every visible action, whatever the source order.
        expect(triggerSlot.className).toContain('max-md:order-last');
    });

    it('on desktop an overflow action is the button it always was, in place', () => {
        render(
            <PageActions>
                <OverflowAction label="Connect" onSelect={jest.fn()}>
                    <button type="button" data-testid="desktop-connect">
                        Connect
                    </button>
                </OverflowAction>
            </PageActions>,
        );
        const slot = screen.getByTestId('desktop-connect').parentElement!;
        // Hidden on a phone; `display: contents` on desktop makes the button a
        // direct item of the cluster.
        expect(slot.className.split(' ')).toEqual(['hidden', 'md:contents']);
    });

    it('outside a cluster an overflow action is just its button', () => {
        const onSelect = jest.fn();
        render(<OverflowAction label="Connect" onSelect={onSelect} />);
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('the primary leads on a phone (reading order, primary first)', () => {
        render(
            <PageActions>
                <Button testId="secondary">Secondary</Button>
                <PrimaryAction>
                    <Button testId="primary">Run test</Button>
                </PrimaryAction>
            </PageActions>,
        );
        const slot = screen.getByTestId('primary').parentElement!;
        expect(slot.className).toContain('max-md:order-first');
        // A refused permission renders nothing: the slot must not leave a gap.
        expect(slot.className).toContain('empty:hidden');
    });
});

describe('PageActions — the cluster wraps forwards on a phone', () => {
    it('wraps normally below md and keeps the desktop recipe from md up', () => {
        render(
            <PageActions>
                <Button testId="a">A</Button>
            </PageActions>,
        );
        const classes = screen.getByTestId('page-actions').className.split(' ');
        expect(classes).toEqual(expect.arrayContaining(['flex-wrap', 'md:flex-wrap-reverse', 'justify-start', 'sm:justify-end']));
        // Never reversed below md: that is what put a phone's actions in
        // reverse reading order.
        expect(classes).not.toContain('flex-wrap-reverse');
    });

    it('a page cannot defeat wrapping with its own single flex wrapper', () => {
        render(
            <PageActions>
                <div className="flex items-center gap-tight">
                    <Button testId="one">One</Button>
                    <Button testId="two">Two</Button>
                </div>
            </PageActions>,
        );
        const cluster = screen.getByTestId('page-actions');
        expect(screen.getByTestId('one').parentElement).toBe(cluster);
        expect(screen.getByTestId('two').parentElement).toBe(cluster);
    });
});

describe('PageActions — a wrapper that is a box in its own right is kept', () => {
    it('leaves a div with an id or a border alone', () => {
        render(
            <PageActions>
                <div id="theme-chip" className="flex items-center gap-compact rounded-lg border border-border-subtle px-3">
                    <Button testId="toggle">Theme</Button>
                </div>
            </PageActions>,
        );
        const chip = document.getElementById('theme-chip');
        expect(chip).not.toBeNull();
        expect(chip!.parentElement).toBe(screen.getByTestId('page-actions'));
    });
});

describe('PageHeader — the title is full width on a phone', () => {
    it('stacks title above actions below sm, and is a row from sm up', () => {
        render(
            <PageHeader
                title="Agent one"
                description="Nine tabs and five actions"
                actions={<Button testId="act">Act</Button>}
                data-testid="hdr"
            />,
        );
        const classes = screen.getByTestId('hdr').className.split(' ');
        expect(classes).toEqual(
            expect.arrayContaining(['flex-col', 'sm:flex-row', 'sm:justify-between']),
        );
        // The actions come AFTER the title block in the column.
        const header = screen.getByTestId('hdr');
        expect(header.lastElementChild).toBe(screen.getByTestId('page-header-actions'));
    });
});

function Button({ testId, children }: { testId: string; children: React.ReactNode }) {
    return (
        <button type="button" data-testid={testId}>
            {children}
        </button>
    );
}
