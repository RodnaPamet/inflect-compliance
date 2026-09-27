/**
 * The external-write ladder's operator surface (#2861).
 *
 * The route shipped with the storage; this is the surface that makes it settable
 * by a person rather than by curl. That gap is not hypothetical — the identity
 * ladder's route existed for months with nothing calling it, and defect #3 of the
 * 2026-09-26 chain was the external-tool approval API shipping with no UI at all.
 *
 * Each assertion here covers a commitment that passes a source scan while being
 * visibly broken, which is why they are rendered tests and not guards:
 *
 *   1. The REFUSAL is on screen beside the control it disables. A disabled button
 *      with no reason is how an operator concludes the feature is broken.
 *   2. Widening is confirmed every time; narrowing is one click and never
 *      confirmed. Narrowing removes authority and is the emergency stop.
 *   3. A rung above what the runtime honours says so ONCE — and the control is
 *      disabled by the CEILING, not only by a refusal string happening to arrive.
 *   4. A refused PUT leaves the dialog open with the server's own sentence.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', connectionId: 'conn_1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/external-write-policy/conn_1',
    useSearchParams: () => new URLSearchParams(),
}));

// Interpolating `t`. A mock returning the raw string would leave every assertion
// reading "Widen to {mode}" — passing without ever proving the label names the
// rung it moves to.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = (en as Record<string, unknown>)[ns] ?? {};
        const t = (key: string, values?: Record<string, string | number>) => {
            const v = key.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
            if (typeof v !== 'string') return key;
            return values
                ? v.replace(/\{(\w+)\}/g, (m, name) => (name in values ? String(values[name]) : m))
                : v;
        };
        t.rich = t;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

let permissions: Record<string, Record<string, boolean>> = { admin: { tenant_lifecycle: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    usePermissions: () => permissions,
    useMoneyFormatter: () => (n: number) => String(n),
}));

type Mode = 'DISABLED' | 'DRY_RUN' | 'PROPOSE_ONLY' | 'AUTOMATIC';

let payload: Record<string, unknown> | undefined;
const swrMutate = jest.fn(async () => undefined);
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: payload, error: undefined, isLoading: !payload, mutate: swrMutate }),
}));

import { ExternalWriteLadderClient } from '@/app/t/[tenantSlug]/(app)/admin/external-write-policy/[connectionId]/ExternalWriteLadderClient';

/** The shape the GET returns, with the knobs each test needs. */
function makePayload(over: {
    mode?: Mode;
    refusals?: Partial<Record<Mode, string | null>>;
    maxMode?: Mode;
    dispatchImplemented?: boolean;
    modeSince?: string | null;
} = {}): Record<string, unknown> {
    const mode = over.mode ?? 'DISABLED';
    return {
        connectionId: 'conn_1',
        connectionName: 'Entra MCP',
        mode,
        modeSince: over.modeSince ?? '2026-09-01T00:00:00.000Z',
        evidenceInWindow: 0,
        maxMode: over.maxMode ?? 'DRY_RUN',
        refusals: {
            DISABLED: null,
            DRY_RUN: null,
            PROPOSE_ONLY: null,
            AUTOMATIC: null,
            ...over.refusals,
        },
        honoured: {
            maxMode: over.maxMode ?? 'DRY_RUN',
            dispatchImplemented: over.dispatchImplemented ?? false,
            minDays: 7,
            minEvidence: { DRY_RUN: 1, PROPOSE_ONLY: 1 },
        },
    };
}

beforeEach(() => {
    permissions = { admin: { tenant_lifecycle: true } };
    payload = makePayload();
    swrMutate.mockClear();
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
});

describe('the refusal is on screen, not just a disabled button', () => {
    it('renders the server\'s reason beside the widen control', () => {
        payload = makePayload({
            refusals: { DRY_RUN: 'DISABLED has been held for 0 of the 7 required days. 7 to go.' },
        });
        render(<ExternalWriteLadderClient connectionId="conn_1" />);
        expect(screen.getByTestId('external-write-ladder-refusal')).toHaveTextContent(
            /0 of the 7 required days/,
        );
    });

    it('disables the widen control when a reason is present', () => {
        payload = makePayload({ refusals: { DRY_RUN: 'Not yet.' } });
        render(<ExternalWriteLadderClient connectionId="conn_1" />);
        expect(screen.getByRole('button', { name: /Widen to Dry run/ })).toBeDisabled();
    });

    it('enables it when there is no reason — so the disabled state means something', () => {
        // The positive control. Without this, every "is disabled" assertion above
        // could be satisfied by a button that is always disabled.
        render(<ExternalWriteLadderClient connectionId="conn_1" />);
        expect(screen.getByRole('button', { name: /Widen to Dry run/ })).toBeEnabled();
    });
});

describe('the ceiling this build honours', () => {
    it('says so once, and does NOT also echo a per-rung refusal', () => {
        // Two sentences making the same point in different words is the
        // two-messages-one-card shape the identity page exists to avoid.
        payload = makePayload({
            mode: 'DRY_RUN',
            refusals: { PROPOSE_ONLY: 'PROPOSE_ONLY is above the ceiling this build honours (DRY_RUN).' },
        });
        render(<ExternalWriteLadderClient connectionId="conn_1" />);
        expect(screen.getByText(/capped at Dry run/)).toBeInTheDocument();
        expect(screen.queryByTestId('external-write-ladder-refusal')).not.toBeInTheDocument();
    });

    it('disables the widen control by the CEILING even when no refusal string arrives', () => {
        // The property that matters: the control must not depend on a derived
        // STRING. If the server changes how it words a refusal, a button gated
        // only on `blockedReason` sits enabled above a rung nothing honours.
        payload = makePayload({ mode: 'DRY_RUN', refusals: { PROPOSE_ONLY: null } });
        render(<ExternalWriteLadderClient connectionId="conn_1" />);
        expect(screen.getByRole('button', { name: /Widen to Proposals only/ })).toBeDisabled();
    });
});

describe('widening is confirmed; narrowing is not', () => {
    it('widening opens a dialog and does not PUT until it is confirmed', async () => {
        render(<ExternalWriteLadderClient connectionId="conn_1" />);
        fireEvent.click(screen.getByRole('button', { name: /Widen to Dry run/ }));

        // Scoped to the dialog. The title renders in two nodes (Radix emits a
        // visually-hidden copy), and the page's own widen button shares the
        // confirm label — so an unscoped query matches more than one element and
        // the failure reads like a broken component rather than a broken query.
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getAllByText(/Widen to Dry run\?/).length).toBeGreaterThan(0);
        expect(global.fetch).not.toHaveBeenCalled();

        fireEvent.click(within(dialog).getByRole('button', { name: /^Widen to Dry run$/ }));
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        const [, init] = (global.fetch as jest.Mock).mock.calls[0];
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({ mode: 'DRY_RUN' });
    });

    it('narrowing PUTs immediately, with NO dialog — it is the emergency stop', async () => {
        payload = makePayload({ mode: 'DRY_RUN' });
        render(<ExternalWriteLadderClient connectionId="conn_1" />);

        fireEvent.click(screen.getByRole('button', { name: /Narrow to Off/ }));
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        // No confirmation was rendered at any point.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({
            mode: 'DISABLED',
        });
    });
});

describe('a refused PUT', () => {
    it('surfaces the SERVER\'s sentence rather than a generic failure', async () => {
        global.fetch = jest.fn(async () => ({
            ok: false,
            json: async () => ({ error: 'DRY_RUN has recorded 0 of the 1 required dry-run intents.' }),
        })) as unknown as typeof fetch;

        render(<ExternalWriteLadderClient connectionId="conn_1" />);
        fireEvent.click(screen.getByRole('button', { name: /Widen to Dry run/ }));
        const dialog = screen.getByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: /^Widen to Dry run$/ }));

        // The dialog must STAY OPEN over the refusal — `ConfirmDialog` closes on
        // resolve, so a swallowed rejection would close it over a message the
        // operator never read.
        await waitFor(() =>
            expect(screen.getAllByText(/recorded 0 of the 1 required/).length).toBeGreaterThan(0),
        );
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(swrMutate).not.toHaveBeenCalled();
    });
});

describe('the top of the ladder', () => {
    it('offers no widen control at AUTOMATIC', () => {
        payload = makePayload({ mode: 'AUTOMATIC', maxMode: 'AUTOMATIC', dispatchImplemented: true });
        render(<ExternalWriteLadderClient connectionId="conn_1" />);
        expect(screen.getByText(/widest rung/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Widen to/ })).not.toBeInTheDocument();
    });
});
