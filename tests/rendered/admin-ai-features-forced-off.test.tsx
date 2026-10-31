/**
 * The admin AI-features page, with the one case that matters.
 *
 * `displayFor` is unit-tested on its own. What a unit test cannot show is that
 * this COMPONENT consults it — a page that computed the right answer and then
 * rendered a button anyway would pass every test in
 * `tests/unit/admin/ai-feature-display.test.ts`.
 *
 * That gap is exactly #3909: `isAiFeatureEnabled('assistant')` was true, the
 * master switch was false, and the launcher rendered on 151 pages while every
 * turn behind it was refused. The predicate was available and not consulted.
 *
 * So the assertions here are about what reaches the DOM:
 *   - a platform-forced row renders NO control and says why;
 *   - a tenant-off row renders a control that offers to turn it ON;
 *   - a switch that is on while the master is off renders the warning rather
 *     than reading as working.
 *
 * next-intl resolves against the real `messages/en.json`, so a missing or
 * renamed key fails here instead of shipping `admin.aiFeatures.status.on` as
 * displayed copy.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/ai-features',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns?: string) => (key: string) => {
            const dotted = ns ? `${ns}.${key}` : key;
            let cur: unknown = en;
            for (const part of dotted.split('.')) {
                cur = (cur as Record<string, unknown> | undefined)?.[part];
            }
            // Returning the KEY on a miss rather than throwing, matching the
            // other rendered suites — and the assertions below check for real
            // copy, so a miss still fails.
            return typeof cur === 'string' ? cur : dotted;
        },
    };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantContext: () => ({ tenantSlug: 'acme' }),
}));

const swrState: { data: unknown; isLoading: boolean; error: unknown; mutate: () => void } = {
    data: undefined,
    isLoading: false,
    error: undefined,
    mutate: jest.fn(),
};
jest.mock('@/lib/hooks/use-tenant-swr', () => ({ useTenantSWR: () => swrState }));

// Breadcrumbs and the back link reach for nav registries and a router; neither
// is what this suite is about.
jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import { AiFeaturesClient } from '@/app/t/[tenantSlug]/(app)/admin/ai-features/AiFeaturesClient';
import type { AiToggleState } from '@/app-layer/usecases/ai-feature-toggles';

function toggle(key: AiToggleState['key'], over: Partial<AiToggleState> = {}): AiToggleState {
    return {
        key,
        tenantEnabled: true,
        envEnabled: true,
        effective: true,
        forcedOffByEnv: false,
        ...over,
    };
}

function renderWith(toggles: AiToggleState[]) {
    swrState.data = { toggles };
    swrState.error = undefined;
    swrState.isLoading = false;
    return render(<AiFeaturesClient />);
}

const ALL_ON = [toggle('ai'), toggle('risk'), toggle('assistant'), toggle('questionnaire')];

describe('a platform-forced feature renders no control', () => {
    it('shows the reason and omits the button', () => {
        renderWith([
            toggle('ai'),
            toggle('risk'),
            toggle('assistant', { envEnabled: false, effective: false, forcedOffByEnv: true }),
            toggle('questionnaire'),
        ]);

        const row = screen.getByTestId('ai-toggle-assistant');
        expect(row).toHaveAttribute('data-display-kind', 'off-by-platform');
        // NO control. Not a disabled one: a disabled button still says "this is
        // the thing to press", and this screen is not where that decision lives.
        expect(screen.queryByTestId('toggle-assistant')).toBeNull();
        expect(screen.getByText('Not available on this deployment')).toBeInTheDocument();

        // The other three are untouched and still offer their controls.
        expect(screen.getByTestId('toggle-risk')).toBeInTheDocument();
        expect(screen.getByTestId('toggle-questionnaire')).toBeInTheDocument();
        expect(screen.getByTestId('toggle-ai')).toBeInTheDocument();
    });
});

describe('a tenant-off feature renders a control that turns it on', () => {
    it('offers "Turn on", not "Turn off"', () => {
        renderWith([
            toggle('ai'),
            toggle('risk', { tenantEnabled: false, effective: false }),
            toggle('assistant'),
            toggle('questionnaire'),
        ]);
        const row = screen.getByTestId('ai-toggle-risk');
        expect(row).toHaveAttribute('data-display-kind', 'off-by-tenant');
        expect(screen.getByTestId('toggle-risk')).toHaveTextContent('Turn on');
        // And an ON row offers the opposite, so the label is driven by the state
        // rather than being constant.
        expect(screen.getByTestId('toggle-assistant')).toHaveTextContent('Turn off');
    });
});

describe('a feature on while the master is off says so', () => {
    it('warns rather than reading as working', () => {
        renderWith([
            toggle('ai', { tenantEnabled: false, effective: false }),
            toggle('risk', { effective: false }),
            toggle('assistant', { effective: false }),
            toggle('questionnaire', { effective: false }),
        ]);
        expect(screen.getByTestId('ai-toggle-assistant')).toHaveAttribute(
            'data-display-kind',
            'off-by-master',
        );
        expect(screen.getAllByText('AI is off for this workspace').length).toBeGreaterThan(0);
        // The master row itself does not claim to be off because of itself.
        expect(screen.getByTestId('ai-toggle-master')).toHaveAttribute(
            'data-display-kind',
            'off-by-tenant',
        );
    });
});

describe('the happy path', () => {
    it('renders all four rows with controls and no notices', () => {
        renderWith(ALL_ON);
        for (const id of ['ai-toggle-master', 'ai-toggle-assistant', 'ai-toggle-risk', 'ai-toggle-questionnaire']) {
            expect(screen.getByTestId(id)).toHaveAttribute('data-display-kind', 'on');
        }
        expect(screen.queryByText('Not available on this deployment')).toBeNull();
        expect(screen.queryByText('AI is off for this workspace')).toBeNull();
    });

    it('renders the real localized copy, not key paths', () => {
        renderWith(ALL_ON);
        // A missing key would put `admin.aiFeatures.assistant.name` in the DOM.
        expect(screen.getByText('Assistant')).toBeInTheDocument();
        expect(screen.getByText('Questionnaire autofill')).toBeInTheDocument();
        expect(screen.queryByText(/^admin\.aiFeatures\./)).toBeNull();
    });
});

describe('a refused switch says why (#4814)', () => {
    afterEach(() => {
        delete (globalThis as { fetch?: unknown }).fetch;
    });

    function stubPut(status: number, body: unknown) {
        (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
            ok: false,
            status,
            json: async () => body,
        }));
    }

    it('shows the server\'s reason when it gives one', async () => {
        const { fireEvent, findByTestId } = await import('@testing-library/react');
        stubPut(403, { error: { code: 'FORBIDDEN', message: 'Only a workspace owner can change this.' } });
        renderWith(ALL_ON);
        fireEvent.click(screen.getByTestId('toggle-risk'));
        expect(await findByTestId(document.body, 'ai-toggle-save-failed')).toHaveTextContent(
            'Only a workspace owner can change this.',
        );
        expect(swrState.mutate).not.toHaveBeenCalled();
    });

    it('falls back to the fixed sentence on a server error', async () => {
        const { fireEvent, findByTestId } = await import('@testing-library/react');
        stubPut(500, { error: { message: 'stack trace' } });
        renderWith(ALL_ON);
        fireEvent.click(screen.getByTestId('toggle-risk'));
        const notice = await findByTestId(document.body, 'ai-toggle-save-failed');
        expect(notice).toHaveTextContent('The switch is unchanged.');
        expect(notice).not.toHaveTextContent('stack trace');
    });

    it('a failed load offers a retry that re-reads', async () => {
        const { fireEvent } = await import('@testing-library/react');
        swrState.data = undefined;
        swrState.error = new Error('boom');
        (swrState.mutate as jest.Mock).mockClear();
        render(<AiFeaturesClient />);
        fireEvent.click(screen.getByRole('button', { name: /try again/i }));
        expect(swrState.mutate).toHaveBeenCalledTimes(1);
    });
});
