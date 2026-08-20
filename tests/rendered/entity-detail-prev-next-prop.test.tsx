/** @jest-environment jsdom */

/**
 * `<EntityDetailLayout prevNext>` — the shell composes the record stepper
 * beside the title.
 *
 * The prop exists so the 13 detail pages due to mount this nav do not each
 * hand-roll `<span className="inline-flex …">{title}<EntityPrevNextNav/></span>`.
 * The one page that DID hand-roll it is also the page where it silently broke,
 * so the composition is worth owning in one place.
 *
 * The nav must ride WITH the title through loading/error/empty suppression —
 * arrows flashing beside an empty heading while the entity loads is the
 * regression this locks.
 */

import { render } from '@testing-library/react';
import * as React from 'react';

import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/assets/a2',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

const PREV_NEXT = {
    ids: ['a1', 'a2', 'a3'],
    currentId: 'a2',
    hrefFor: (id: string) => `/t/acme/assets/${id}`,
    labelSingular: 'asset',
};

function mount(extra: Record<string, unknown> = {}) {
    return render(
        <TooltipProvider delayDuration={0}>
            <KeyboardShortcutProvider>
                <EntityDetailLayout
                    title={<span>Laptop 001</span>}
                    prevNext={PREV_NEXT}
                    {...extra}
                >
                    <div>body</div>
                </EntityDetailLayout>
            </KeyboardShortcutProvider>
        </TooltipProvider>,
    );
}

describe('EntityDetailLayout prevNext', () => {
    it('renders the stepper beside the title', () => {
        const { queryByTestId, getByText } = mount();
        expect(getByText('Laptop 001')).toBeTruthy();
        expect(queryByTestId('entity-prev-next-nav')).not.toBeNull();
        expect(queryByTestId('entity-nav-prev')).not.toBeNull();
        expect(queryByTestId('entity-nav-next')).not.toBeNull();
    });

    it('omits the stepper entirely when the prop is not passed', () => {
        const { queryByTestId } = render(
            <TooltipProvider delayDuration={0}>
                <KeyboardShortcutProvider>
                    <EntityDetailLayout title={<span>Laptop 001</span>}>
                        <div>body</div>
                    </EntityDetailLayout>
                </KeyboardShortcutProvider>
            </TooltipProvider>,
        );
        expect(queryByTestId('entity-prev-next-nav')).toBeNull();
    });

    it('suppresses the stepper while loading, with the title', () => {
        const { queryByTestId, queryByText } = mount({ loading: true });
        expect(queryByText('Laptop 001')).toBeNull();
        expect(queryByTestId('entity-prev-next-nav')).toBeNull();
    });

    it('suppresses the stepper in the error state', () => {
        const { queryByTestId } = mount({ error: 'Could not load asset.' });
        expect(queryByTestId('entity-prev-next-nav')).toBeNull();
    });

    it('suppresses the stepper in the empty state', () => {
        const { queryByTestId } = mount({ empty: { message: 'Not found.' } });
        expect(queryByTestId('entity-prev-next-nav')).toBeNull();
    });

    it('still hides itself when the id list has nothing to step through', () => {
        const { queryByTestId } = mount({
            prevNext: { ...PREV_NEXT, ids: ['only'], currentId: 'only' },
        });
        expect(queryByTestId('entity-prev-next-nav')).toBeNull();
    });
});
