/**
 * The control's Checks tab says when it could not read the run history
 * (#5313). It used to read only `data`, so a failed request rendered the
 * "No automated checks yet" empty state — telling the reader the control had
 * never been checked.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) {
                cache.set(ns, (key: string) => {
                    const v = resolve(ns, key);
                    return typeof v === 'string' ? v : key;
                });
            }
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { ControlChecksTab } from '@/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/ControlChecksTab';

const EN = (jest.requireActual('../../messages/en.json') as { controls: { checksTab: Record<string, string> } }).controls.checksTab;

const fetchMock = jest.fn();
const reply = (status: number, body: unknown) =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

function mount() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <ControlChecksTab controlId="c-1" />
        </SWRConfig>,
    );
}

it('a failed read says so, with a retry, and is not the empty state', async () => {
    fetchMock.mockResolvedValue(reply(500, { error: { code: 'INTERNAL', message: 'boom' } }));
    mount();
    expect(await screen.findByText(EN.loadError)).toBeInTheDocument();
    expect(screen.queryByText(EN.emptyTitle)).toBeNull();

    fetchMock.mockResolvedValue(reply(200, { executions: [] }));
    fireEvent.click(screen.getByText(EN.retry));
    expect(await screen.findByText(EN.emptyTitle)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(EN.loadError)).toBeNull());
});

it('a control with no runs still reads as empty', async () => {
    fetchMock.mockResolvedValue(reply(200, { executions: [] }));
    mount();
    expect(await screen.findByText(EN.emptyTitle)).toBeInTheDocument();
});
