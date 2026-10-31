/**
 * "WHERE AI RUNS" SENDS ONE KEY AND SAYS WHAT LOCAL ONLY MEANS HERE.
 *
 * The section writes `aiResidency` through the patch-shaped security-settings
 * PUT. The claims worth pinning are the ones a careless edit would quietly
 * break:
 *
 *   1. The stored value is what the section shows, and nothing is saved until
 *      the choice differs from it.
 *   2. A save sends `{ aiResidency }` and NO gateway address: the patch leaves
 *      every other column alone, and the page offers no address field (#4545).
 *   3. Choosing Local only says what it will mean in THIS deployment, from the
 *      read's `deploymentHasLocalGateway`.
 *   4. A refused save shows the server's sentence and keeps the stored state.
 *   5. A refused read says it cannot answer; it does not render External as if
 *      it knew.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

// Resolved against the real en.json, so a missing key fails rather than
// rendering its own path.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string) => {
        const v = resolve(`${ns}.${key}`);
        return typeof v === 'string' ? v : key;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// STABLE, as the real hook is: the load effect depends on it.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl };
});

import { AiResidencySection } from '@/app/t/[tenantSlug]/(app)/admin/ai-features/AiResidencySection';

const EN = (
    require('../../messages/en.json') as { admin: { aiResidency: Record<string, string> } }
).admin.aiResidency;

type Residency = 'EXTERNAL' | 'LOCAL_ONLY';
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

function stubSettings(opts: {
    stored: Residency;
    hasGateway?: boolean;
    readOk?: boolean;
    refuseWith?: string;
}): void {
    calls = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (method === 'GET') {
            if (opts.readOk === false) return { ok: false, json: async () => ({ error: { message: 'Forbidden' } }) };
            return {
                ok: true,
                json: async () => ({ aiResidency: opts.stored, deploymentHasLocalGateway: opts.hasGateway ?? false }),
            };
        }
        if (opts.refuseWith) {
            return { ok: false, json: async () => ({ error: { code: 'BAD_REQUEST', message: opts.refuseWith } }) };
        }
        return {
            ok: true,
            json: async () => ({
                aiResidency: (body as { aiResidency: Residency }).aiResidency,
                deploymentHasLocalGateway: opts.hasGateway ?? false,
            }),
        };
    }) as unknown as typeof fetch;
}

async function mount(opts: Parameters<typeof stubSettings>[0]): Promise<HTMLElement> {
    stubSettings(opts);
    render(<AiResidencySection />);
    await screen.findByTestId('ai-residency-state');
    return screen.getByTestId('ai-residency-section');
}

const puts = () => calls.filter((c) => c.method === 'PUT');

afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

describe('Where AI runs', () => {
    it('shows the stored value and offers no save until the choice differs', async () => {
        const section = await mount({ stored: 'EXTERNAL' });
        expect(within(section).getByTestId('ai-residency-state')).toHaveTextContent(EN.stateExternal);
        expect(screen.getByTestId('ai-residency-external')).toBeChecked();
        expect(screen.getByTestId('ai-residency-save')).toBeDisabled();
        expect(screen.queryByTestId('ai-residency-local-meaning')).not.toBeInTheDocument();
        // No address field anywhere in the section.
        expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('saving Local only sends aiResidency and nothing else, then reads as Local only', async () => {
        const user = userEvent.setup();
        await mount({ stored: 'EXTERNAL' });
        await user.click(screen.getByTestId('ai-residency-local-only'));
        await user.click(screen.getByTestId('ai-residency-save'));

        await screen.findByText(EN.saved);
        expect(puts()).toEqual([
            { url: '/api/t/acme/admin/security-settings', method: 'PUT', body: { aiResidency: 'LOCAL_ONLY' } },
        ]);
        expect(screen.getByTestId('ai-residency-state')).toHaveTextContent(EN.stateLocal);
        expect(screen.getByTestId('ai-residency-save')).toBeDisabled();
    });

    it('saving External from Local only sends that one key', async () => {
        const user = userEvent.setup();
        await mount({ stored: 'LOCAL_ONLY' });
        expect(screen.getByTestId('ai-residency-local-only')).toBeChecked();
        await user.click(screen.getByTestId('ai-residency-external'));
        await user.click(screen.getByTestId('ai-residency-save'));
        await screen.findByText(EN.saved);
        expect(puts().map((c) => c.body)).toEqual([{ aiResidency: 'EXTERNAL' }]);
    });

    it.each([
        [false, 'localWithoutGateway'],
        [true, 'localWithGateway'],
    ] as const)('with deploymentHasLocalGateway=%s, Local only says %s before it is saved', async (hasGateway, key) => {
        const user = userEvent.setup();
        await mount({ stored: 'EXTERNAL', hasGateway });
        await user.click(screen.getByTestId('ai-residency-local-only'));
        expect(screen.getByTestId('ai-residency-local-meaning')).toHaveTextContent(EN[key]);
        expect(puts()).toEqual([]);
    });

    it('a refused save shows the server\'s sentence and keeps the stored state', async () => {
        const user = userEvent.setup();
        const refusal = 'legacyMatchAiMode=EXTERNAL is refused under aiResidency=LOCAL_ONLY.';
        await mount({ stored: 'EXTERNAL', refuseWith: refusal });
        await user.click(screen.getByTestId('ai-residency-local-only'));
        await user.click(screen.getByTestId('ai-residency-save'));

        expect(await screen.findByText(refusal)).toBeInTheDocument();
        expect(screen.getByTestId('ai-residency-state')).toHaveTextContent(EN.stateExternal);
        expect(screen.queryByText(EN.saved)).not.toBeInTheDocument();
    });

    it('a failed read offers a retry that loads the setting (#4814)', async () => {
        stubSettings({ stored: 'EXTERNAL', readOk: false });
        render(<AiResidencySection />);
        const retry = await screen.findByTestId('ai-residency-retry');
        stubSettings({ stored: 'LOCAL_ONLY' });
        await userEvent.setup().click(retry);
        expect(await screen.findByTestId('ai-residency-state')).toHaveTextContent(EN.stateLocal);
        expect(screen.queryByText(EN.loadFailed)).not.toBeInTheDocument();
    });

    it('a refused read says it cannot answer, and offers no choice', async () => {
        stubSettings({ stored: 'EXTERNAL', readOk: false });
        render(<AiResidencySection />);
        expect(await screen.findByText(EN.loadFailed)).toBeInTheDocument();
        expect(screen.queryByTestId('ai-residency-external')).not.toBeInTheDocument();
        expect(screen.queryByTestId('ai-residency-state')).not.toBeInTheDocument();
    });
});
