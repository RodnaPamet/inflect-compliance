/**
 * The write ladder's operator surface.
 *
 * The PUT route has existed since the ladder shipped and nothing in the product
 * called it, so a tenant could only be moved off DISABLED by a hand-made request
 * from an OWNER session. These tests cover the surface that was missing, and they
 * assert the three commitments that make it more than a settings form — each of
 * which passes a source scan while being visibly broken, which is why they are
 * here and not in tests/guards.
 *
 *   1. The REFUSAL is on screen next to the control it disables. A disabled
 *      button with no reason is how an operator concludes the feature is broken.
 *   2. Widening is confirmed every time; narrowing is one click and never
 *      confirmed. Narrowing is the emergency stop — a dialog in front of it is a
 *      reason to hesitate at the moment nobody should.
 *   3. A rung above what the runtime honours says so. The leaver pass clamps
 *      itself and the joiner has no implementation. Neither is settable-and-
 *      inert any more: #2187 raised the leaver clamp to AUTOMATIC, and the
 *      joiner is refused at both ends since 2026-09-01. Silence there would
 *      still be worse than a refusal, which is why both now refuse.
 *
 * Plus the failure path, which the primitive's contract makes easy to get wrong:
 * `Modal.Confirm` closes on resolve, so a swallowed refusal would close the
 * dialog over a message the operator never read.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/identity-write-policy',
    useSearchParams: () => new URLSearchParams(),
}));

// Interpolating `t`. The sibling identity test's mock returns the raw string,
// which would leave every assertion reading "Widen to {mode}" — i.e. passing
// without ever proving the label names the rung it moves to.
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

let permissions = { admin: { tenant_lifecycle: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    usePermissions: () => permissions,
}));

type Mode = 'DISABLED' | 'DRY_RUN' | 'PROPOSE' | 'AUTOMATIC';

let payload: Record<string, unknown> | undefined;
const swrMutate = jest.fn(async () => undefined);
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: payload, error: undefined, isLoading: !payload, mutate: swrMutate }),
}));

import { WriteLadderClient } from '@/app/t/[tenantSlug]/(app)/admin/identity-write-policy/WriteLadderClient';
import IdentityWritePolicyPage from '@/app/t/[tenantSlug]/(app)/admin/identity-write-policy/page';

function state(mode: Mode, over: Record<string, unknown> = {}) {
    const ladder: Mode[] = ['DISABLED', 'DRY_RUN', 'PROPOSE', 'AUTOMATIC'];
    const i = ladder.indexOf(mode);
    return { mode, dryRunSince: null, nextMode: ladder[i + 1] ?? null, blockedReason: null, ...over };
}

function setPayload(leaver: Record<string, unknown>, over: Record<string, unknown> = {}) {
    payload = {
        directions: { leaver, joiner: state('DISABLED') },
        dryRunMinDays: 7,
        honoured: {
            leaver: { maxMode: 'DRY_RUN', implemented: true },
            joiner: { maxMode: 'DISABLED', implemented: false },
        },
        ...over,
    };
}

/** Returns the PUT bodies the component actually sent. */
function mockFetch(response: { ok: boolean; error?: string } = { ok: true }) {
    const bodies: Array<Record<string, unknown>> = [];
    const fn = jest.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return {
            ok: response.ok,
            json: async () => (response.ok ? {} : { error: response.error }),
        } as Response;
    });
    global.fetch = fn as unknown as typeof fetch;
    return bodies;
}

/**
 * One direction's labelled region. Both directions render structurally
 * identical controls with the SAME words on them — "Widen to Dry run" is in
 * both when both sit at Off — so an unscoped locator matches two nodes and the
 * test either explodes or, worse, silently drives the wrong direction.
 */
function card(name: RegExp) {
    return screen.getByRole('region', { name });
}

beforeEach(() => {
    jest.clearAllMocks();
    permissions = { admin: { tenant_lifecycle: true } };
    setPayload(state('DISABLED'));
});

describe('identity write ladder — the operator surface', () => {
    it('shows the refusal beside the control it disables', () => {
        setPayload(
            state('DRY_RUN', {
                dryRunSince: '2026-08-19T00:00:00.000Z',
                blockedReason: 'Must remain in DRY_RUN for 7 days before widening.',
            }),
        );
        render(<WriteLadderClient />);

        const widen = screen.getByRole('button', { name: /Widen to Propose/i });
        expect(widen).toBeDisabled();
        // The reason is the whole point: a greyed button that explains nothing
        // sends the operator hunting for a bug that is not there.
        expect(
            screen.getByText('Must remain in DRY_RUN for 7 days before widening.'),
        ).toBeInTheDocument();
    });

    it('confirms a widen and writes nothing until the operator confirms', async () => {
        const bodies = mockFetch();
        render(<WriteLadderClient />);

        fireEvent.click(within(card(/Leavers/i)).getByRole('button', { name: /Widen to Dry run/i }));
        expect(bodies).toHaveLength(0);

        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: /Widen to Dry run/i }));

        await waitFor(() => expect(bodies).toEqual([{ direction: 'leaver', mode: 'DRY_RUN' }]));
        expect(swrMutate).toHaveBeenCalled();
    });

    it('narrows on one click, with no dialog in front of the emergency stop', async () => {
        setPayload(state('PROPOSE'));
        const bodies = mockFetch();
        render(<WriteLadderClient />);

        fireEvent.click(within(card(/Leavers/i)).getByRole('button', { name: /Narrow to Dry run/i }));

        await waitFor(() => expect(bodies).toEqual([{ direction: 'leaver', mode: 'DRY_RUN' }]));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('keeps the dialog open on a refused widen and shows the refusal in it', async () => {
        mockFetch({ ok: false, error: 'Cannot widen more than one rung at a time.' });
        render(<WriteLadderClient />);

        fireEvent.click(within(card(/Leavers/i)).getByRole('button', { name: /Widen to Dry run/i }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: /Widen to Dry run/i }));

        // Closing over the refusal would leave the operator with no idea why
        // nothing changed — `Modal.Confirm` only stays open if onConfirm rejects.
        await waitFor(() =>
            expect(
                within(screen.getByRole('dialog')).getByText(
                    'Cannot widen more than one rung at a time.',
                ),
            ).toBeInTheDocument(),
        );
    });

    it('warns when the rung is above what the runtime will act on', () => {
        setPayload(state('PROPOSE'));
        render(<WriteLadderClient />);
        // Written when the leaver pass clamped itself at DRY_RUN, which made
        // PROPOSE settable-and-inert. #2187 raised that clamp to AUTOMATIC, so
        // PROPOSE now runs — and refuses every candidate for a different reason
        // (no approval queue; issue #2241). The principle the case exists for is
        // unchanged: a control that accepts a value the system ignores is the bug.
        expect(within(card(/Leavers/i)).getByText(/above what the product will act on/i))
            .toBeInTheDocument();
    });

    it('says the joiner direction is not built, rather than pretending it works', () => {
        render(<WriteLadderClient />);
        expect(within(card(/Joiners/i)).getByText(/not built yet/i)).toBeInTheDocument();
    });

    it('disables the joiner widen control, and says why, while the joiner is unbuilt', () => {
        render(<WriteLadderClient />);
        const joiner = card(/Joiners/i);

        // The fixture gives the joiner `blockedReason: null` DELIBERATELY. If the
        // button only ever consulted that field the assertion below would be
        // satisfied by nothing at all, so this test binds specifically to the
        // component reading `honoured.implemented` — the flag that was already in
        // scope, already false, and already unread.
        expect(payload).toBeDefined();
        expect(
            (payload as { directions: Record<string, { blockedReason: string | null }> })
                .directions.joiner.blockedReason,
        ).toBeNull();

        expect(joiner.querySelector('button')).not.toBeNull();
        expect(within(joiner).getByRole('button', { name: /Widen to Dry run/i })).toBeDisabled();
        // Disabled AND explained. A greyed control with nothing beside it is the
        // failure mode this page exists to avoid.
        expect(within(joiner).getByText(/not built yet/i)).toBeInTheDocument();
    });

    it('leaves the leaver widen control enabled in the same render', () => {
        // The half that keeps the previous test honest: a component that disabled
        // every widen button would pass it while breaking the only direction with
        // a runtime behind it.
        render(<WriteLadderClient />);
        expect(
            within(card(/Leavers/i)).getByRole('button', { name: /Widen to Dry run/i }),
        ).toBeEnabled();
    });

    it('refuses the page to an admin who is not an owner', () => {
        permissions = { admin: { tenant_lifecycle: false } };
        render(<IdentityWritePolicyPage />);
        expect(screen.getByText(/Only an owner can/i)).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: /Leavers/i })).not.toBeInTheDocument();
    });
});
