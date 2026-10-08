/**
 * The saved-parameters operator surface (#3124).
 *
 * The API shipped in #2906 with four verbs, five usecases and a database trigger
 * enforcing four eyes, and NOTHING in the product called it — so creating a
 * baseline, proposing an edit, signing one and approving one were reachable only
 * by a hand-written request. These are rendered tests rather than guards because
 * every claim below is one a source scan would pass while the screen was visibly
 * wrong or actively misleading:
 *
 *   1. The four STATES each render their own thing — empty, populated baseline,
 *      pending edit with no signature, pending edit with one. An empty register
 *      and a register not yet read are different facts.
 *   2. A BASELINE says it has no approver. It is the one row on the page whose
 *      content nobody reviewed, and the API refuses open fields on it for that
 *      reason.
 *   3. The DIFF covers the UNION of keys, so a removed argument is as loud as an
 *      added one.
 *   4. An open field renders its KIND and its bound, from the vocabulary in
 *      `parameter-constraints.ts`.
 *   5. SIGN posts to the signatures path, and APPROVE puts to the collection —
 *      each carrying `expectedPendingHash` read from what is on screen. A
 *      control that sent only the id would act on whatever the row says when the
 *      request lands.
 *   6. The signature COUNT appears beside the DIGEST it is against. A count with
 *      no hash reads as "one of one, go ahead" on content the signer never saw.
 *   7. A refused sign or approve renders the SERVER's sentence — the four-eyes
 *      refusals are mapped from the database by `fourEyesRefusal` in the
 *      usecase, so re-wording them here would be a second place to drift.
 *   8. Every DIGEST is reachable from the keyboard (#3154). The line shows a
 *      12-char head; the whole hash is the control's accessible name and goes
 *      to the clipboard on Enter. This belongs here for the same reason as the
 *      rest: #3150's hints passed every ratchet — including the one that
 *      forced them — while being hover-only, because `<Tooltip>` over a `<p>`
 *      is a source shape a scan approves and a focus a keyboard cannot make.
 *   9. Focus OPENS the hint and the hint names the whole 64-char digest
 *      (#3163). Shipped since #3159 and unprovable until the jsdom tooltip
 *      module mock started delegating to the real primitive — `<CopyText>`
 *      imports it as `./tooltip`, a spelling `jest.config.js` redirected to a
 *      pass-through. That test also carries the nwsapi `:focus-visible`
 *      canary; its docblock says what to read when a dependabot bump reddens
 *      it.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(120_000);

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/parameter-sets',
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

// INTERPOLATING `t`. A mock returning the raw key would leave every assertion
// below reading "parameterSets.signatureCount" — passing without ever proving
// the sentence names the count and the digest it is about.
//
// CACHED PER NAMESPACE, which is not tidiness. `useTranslations` and
// `useTenantApiUrl` both return MEMOISED callbacks in production, and this
// component's mount effect lists them as dependencies — a mock that minted a
// fresh function per render would re-run that effect on every render, blank the
// list mid-flight and invent a defect the real provider cannot produce.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const cache = new Map<string, (key: string, values?: Record<string, string | number>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const dict = ns
            .split('.')
            .reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en,
            ) ?? {};
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
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => {
    // Module-level constants, for the reason the next-intl mock states:
    // `useTenantApiUrl` is a `useCallback` keyed on the tenant slug in
    // production, so its identity is stable across renders.
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    const tenantHref = (path: string) => `/t/acme${path}`;
    const money = (n: number) => String(n);
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => tenantHref,
        usePermissions: () => ({ admin: { agent_registry: true } }),
        useMoneyFormatter: () => money,
    };
});

// The digest controls are `<CopyText>`, which toasts through `useToast` →
// sonner. Mocked rather than left live so the success path is an assertable
// call instead of a queued render into a `<Toaster>` this harness never mounts.
const toastMock = { success: jest.fn(), error: jest.fn() };
jest.mock('sonner', () => ({
    toast: toastMock,
    Toaster: () => null,
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { ParameterSetsClient } from '@/app/t/[tenantSlug]/(app)/agents/parameter-sets/ParameterSetsClient';

const CONNECTIONS = [{ id: 'conn_1', name: 'Entra MCP' }] as const;

const POPULATIONS = [
    {
        key: 'terminated_employee_work_emails',
        description: 'Work email addresses of terminated employees',
        bound: 'Employee rows for this tenant whose status is TERMINATED, capped at 5000.',
    },
] as const;

const TOOL = 'mcp__conn_1__update_user';

type Row = Record<string, unknown>;

/** The hash a digest-bearing control must carry. Distinct per fixture, on purpose. */
const PENDING_HASH = 'aaaaaaaabbbbbbbbccccccccdddddddd11112222333344445555666677778888';
const IN_FORCE_HASH = '9999999988888888777777776666666655554444333322221111000099990000';

function baseline(over: Row = {}): Row {
    return {
        id: 'set_1',
        toolName: TOOL,
        label: 'Nightly roster push',
        parameters: { host: 'a.test', limit: 10 },
        parametersHash: IN_FORCE_HASH,
        openFields: null,
        targetPopulation: null,
        revision: 1,
        approvalSource: 'BASELINE',
        approvedByUserId: null,
        approvedAt: '2026-09-01T00:00:00.000Z',
        pending: null,
        signatures: [],
        ...over,
    };
}

/** The same row with an edit waiting — a template, which is what needs four eyes. */
function withPending(signatures: Row[] = []): Row {
    return baseline({
        pending: {
            parameters: { host: 'b.test', page: 2 },
            openFields: { q: { kind: 'regex', pattern: '^[a-z]{1,10}$' } },
            targetPopulation: 'terminated_employee_work_emails',
            hash: PENDING_HASH,
            byUserId: 'user_proposer',
            at: '2026-09-20T00:00:00.000Z',
            requiredApprovals: 1,
        },
        signatures,
    });
}

/** What each fetch answers, by path and method. */
let listBody: Row[] = [];
let catalogue: { ok: boolean; body: unknown } = {
    ok: true,
    body: { tools: [{ toolName: TOOL, advertisedName: 'update_user' }] },
};
let mutationResponse: { ok: boolean; body: unknown } = { ok: true, body: {} };
let calls: Array<{ url: string; method: string; body: unknown }> = [];

function installFetch() {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        // The SIGNATURES path is a prefix-extension of the collection path, so it
        // is matched FIRST — the other order would route every signature POST to
        // the collection and the sign assertions would pass on the wrong call.
        if (u.includes('/admin/agents/parameter-sets/signatures')) {
            return { ok: mutationResponse.ok, json: async () => mutationResponse.body };
        }
        if (u.includes('/admin/agents/external-tools')) {
            return { ok: catalogue.ok, json: async () => catalogue.body };
        }
        if (u.includes('/admin/agents/parameter-sets')) {
            if (method === 'GET') return { ok: true, json: async () => listBody };
            return { ok: mutationResponse.ok, json: async () => mutationResponse.body };
        }
        throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;
}

beforeEach(() => {
    listBody = [];
    catalogue = {
        ok: true,
        body: { tools: [{ toolName: TOOL, advertisedName: 'update_user' }] },
    };
    mutationResponse = { ok: true, body: {} };
    calls = [];
    installFetch();
    toastMock.success.mockClear();
    toastMock.error.mockClear();

    // jsdom's `matchMedia` answers `false` for every query, so `useMediaQuery`
    // resolves to MOBILE and `Popover` swaps in the Vaul drawer — which is not
    // the surface a desktop operator sees, and not the one whose option list
    // these tests drive. Reported as DESKTOP here deliberately.
    window.matchMedia = ((query: string) => ({
        matches: /min-width:\s*(640|1024)px/.test(query),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
});

const realClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');

afterEach(() => {
    if (realClipboard) {
        Object.defineProperty(window.navigator, 'clipboard', realClipboard);
    } else {
        // @ts-expect-error: jsdom-only cleanup of an ad-hoc descriptor
        delete window.navigator.clipboard;
    }
});

/**
 * Stub `navigator.clipboard.writeText` and return a `userEvent` bound to it.
 *
 * jsdom ships no Clipboard API, and `useCopyToClipboard` then falls through to
 * `document.execCommand('copy')`, which jsdom does not implement either — so
 * an unstubbed copy FAILS and the assertion would be about the stub's absence
 * rather than about the control.
 *
 * ORDER IS LOAD-BEARING: `userEvent.setup()` installs its OWN clipboard stub
 * (`attachClipboardStubToView`), so a descriptor written before the session is
 * created is silently replaced and the mock records nothing. The same note
 * sits on `setupUserWithClipboard` in `copy-primitives.test.tsx`; it cost a
 * round here before it was read.
 */
function clipboardUser() {
    const user = userEvent.setup();
    const writeText = jest.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
    });
    return { user, writeText };
}

function mount() {
    // `TooltipProvider` is mounted because this tree reaches Radix Tooltip
    // through the `@/components/ui/tooltip` alias (Button, StatusBadge and the
    // Combobox chrome all do), and a Radix consumer throws outside a provider.
    // In production it is mounted once in `src/app/providers.tsx`.
    //
    // The three digest controls are `<CopyText>`, which reaches its Tooltip by
    // the relative `./tooltip`. That spelling is no longer special: the
    // primitive supplies its own provider when a suite mounts none, so a
    // digest's hint really opens here. Two earlier states are worth knowing,
    // because each made this file's assertions mean something different: the
    // spelling was once mapped to a pass-through stub, under which no focus or
    // hover anywhere here could produce a `role="tooltip"` node at all, and
    // then to a delegate (#3163) that rendered the real primitive.
    return render(
        <TooltipProvider delayDuration={0}>
            <ParameterSetsClient
                connections={CONNECTIONS}
                targetPopulations={POPULATIONS}
                initialConnectionId="conn_1"
            />
        </TooltipProvider>,
    );
}

describe('the four states each render their own thing', () => {
    it('an EMPTY register says so — after the read completes, not before', async () => {
        mount();
        await waitFor(() =>
            expect(screen.getByText(/No saved parameters for this server/)).toBeInTheDocument(),
        );
        // …and no set card was rendered, so the empty state is a real answer
        // rather than one rendered beside a populated list.
        expect(screen.queryByTestId('parameter-sets-list')).not.toBeInTheDocument();
    });

    it('a POPULATED register renders the set, and NOT the empty state', async () => {
        listBody = [baseline()];
        mount();
        await waitFor(() => expect(screen.getByTestId('parameter-sets-list')).toBeInTheDocument());
        expect(screen.getByTestId('parameter-set-Nightly roster push')).toBeInTheDocument();
        expect(screen.queryByText(/No saved parameters for this server/)).not.toBeInTheDocument();
    });

    it('a BASELINE says it has NO APPROVER — the one row nobody reviewed', async () => {
        listBody = [baseline()];
        mount();
        const card = await screen.findByTestId('parameter-set-Nightly roster push');
        expect(within(card).getByText(/trust on first use, so no approver/)).toBeInTheDocument();
        // The exact-value half of the same claim: no open field, no open target.
        // TWO lines since the empty-state voice locked titles to a declarative
        // phrase (`empty-state-tone`) — the title and the consequence it used to
        // carry as a tail. Both are asserted, because dropping the consequence
        // to satisfy the tone ratchet would lose the half that matters.
        expect(within(card).getByText(/No open fields/)).toBeInTheDocument();
        expect(within(card).getByText(/Every value is exact, so the agent chooses nothing/)).toBeInTheDocument();
        expect(within(card).getByText(/No open target/)).toBeInTheDocument();
    });

    it('an APPROVED row names who approved it instead', async () => {
        // The positive control for the assertion above: without it, the
        // "no approver" sentence could be the only one this component can render.
        listBody = [
            baseline({ approvalSource: 'APPROVED', approvedByUserId: 'user_approver', revision: 2 }),
        ];
        mount();
        const card = await screen.findByTestId('parameter-set-Nightly roster push');
        expect(within(card).getByText(/Approved by user_approver/)).toBeInTheDocument();
        expect(within(card).queryByText(/trust on first use/)).not.toBeInTheDocument();
    });

    it('a PENDING EDIT renders as pending and says it is not in force', async () => {
        listBody = [withPending()];
        mount();
        const pending = await screen.findByTestId('parameter-set-pending-Nightly roster push');
        expect(within(pending).getByText(/An edit is waiting for a human/)).toBeInTheDocument();
        expect(within(pending).getByText(/keeps dispatching what is approved/)).toBeInTheDocument();
        expect(within(pending).getByText(/Proposed by user_proposer/)).toBeInTheDocument();
    });

    it('a row with NO pending edit offers Propose and no Sign/Approve', async () => {
        listBody = [baseline()];
        mount();
        await screen.findByTestId('parameter-set-Nightly roster push');
        expect(screen.getByRole('button', { name: /Propose a change/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Sign this edit/ })).not.toBeInTheDocument();
    });
});

describe('the diff is over the UNION of keys', () => {
    it('renders changed, removed and added arguments each as its own state', async () => {
        listBody = [withPending()];
        mount();
        const diff = await screen.findByTestId('parameter-set-diff-Nightly roster push');
        // `host` changed, `limit` is gone, `page` is new. A diff that iterated
        // only the proposal would render the deletion as nothing at all.
        expect(within(diff).getByText('host')).toBeInTheDocument();
        expect(within(diff).getByText('limit')).toBeInTheDocument();
        expect(within(diff).getByText('page')).toBeInTheDocument();
        expect(within(diff).getAllByText('changed').length).toBe(1);
        expect(within(diff).getAllByText('removed').length).toBe(1);
        expect(within(diff).getAllByText('added').length).toBe(1);
        // Both sides of the changed row, so the approver reads what it was.
        expect(within(diff).getByText('"a.test"')).toBeInTheDocument();
        expect(within(diff).getByText('"b.test"')).toBeInTheDocument();
    });

    it('says so explicitly when NO argument changed — the edit is in the bounds', async () => {
        // The same parameters either side. Rendering nothing here would read as
        // "no change", while the open fields and the target are both moving.
        const row = withPending();
        (row.pending as Record<string, unknown>).parameters = { host: 'a.test', limit: 10 };
        listBody = [row];
        mount();
        const diff = await screen.findByTestId('parameter-set-diff-Nightly roster push');
        expect(
            within(diff).getByText(/No argument changed/),
        ).toBeInTheDocument();
    });
});

describe('an open field renders its KIND and its bound', () => {
    it('names the field, the constraint kind, and the pattern', async () => {
        listBody = [withPending()];
        mount();
        const bounds = await screen.findByTestId(
            'parameter-set-pending-open-fields-Nightly roster push',
        );
        expect(within(bounds).getByText('q')).toBeInTheDocument();
        expect(within(bounds).getByText('regex')).toBeInTheDocument();
        expect(within(bounds).getByText(/\^\[a-z\]\{1,10\}\$/)).toBeInTheDocument();
    });

    it('a kind this build cannot read is REPORTED, not rendered as a bound', async () => {
        // Fail-closed, and the sentence matters: an unreadable constraint makes
        // the whole template undispatchable, which an operator must be told
        // rather than left to infer from a template that never fires.
        const row = withPending();
        (row.pending as Record<string, unknown>).openFields = { q: { kind: 'telepathy' } };
        listBody = [row];
        mount();
        const bounds = await screen.findByTestId(
            'parameter-set-pending-open-fields-Nightly roster push',
        );
        expect(within(bounds).getByText(/cannot read/)).toBeInTheDocument();
    });

    it('the target population is named WITH the registry description', async () => {
        listBody = [withPending()];
        mount();
        const pending = await screen.findByTestId('parameter-set-pending-Nightly roster push');
        expect(
            within(pending).getByText(/terminated_employee_work_emails/),
        ).toBeInTheDocument();
        expect(
            within(pending).getByText(/Work email addresses of terminated employees/),
        ).toBeInTheDocument();
    });
});

describe('the signature count sits beside the digest it is against', () => {
    it('with NO signature: 0 of 1, the pending digest, and the "no signature yet" sentence', async () => {
        listBody = [withPending()];
        mount();
        const sigs = await screen.findByTestId('parameter-set-signatures-Nightly roster push');
        expect(within(sigs).getByText(/0 of 1 signatures on this digest/)).toBeInTheDocument();
        expect(within(sigs).getByText(/No signature yet on this digest/)).toBeInTheDocument();
        // The DIGEST: the head for the eye, the WHOLE of it in the control's
        // accessible NAME. Queried `byRole('button')` on purpose — #3150
        // shipped this as a `<Tooltip>` wrapping a `<p>`, which satisfies
        // `no-ad-hoc-tooltip-title` and is not focusable, so the full hash was
        // mouse-and-screen-reader-only. A `<p>` answers no button query, so
        // this line is the one that would redden on a regression to one.
        //
        // The NAME, not an opened hint — `aria-label` carries the full hash
        // whether or not any hint is open, which is the stronger property and
        // the one a screen reader announces on arrival. The hint itself is
        // asserted separately, under "focus OPENS the hint" below; until #3163
        // it could not be, because `copy-text.tsx` reaches its Tooltip by the
        // relative `./tooltip` and that path resolved to a pass-through stub.
        const digest = within(sigs).getByRole('button', {
            name: new RegExp(`^Copy the full digest ${PENDING_HASH}$`),
        });
        expect(digest).not.toHaveAttribute('title');
        expect(digest).toHaveTextContent(PENDING_HASH.slice(0, 12));
        // What is READ is the head; what is NAMED is the whole thing.
        expect(digest.textContent ?? '').not.toContain(PENDING_HASH);
    });

    it('with ONE signature: the approver, the date, and the hash it is against', async () => {
        listBody = [
            withPending([
                {
                    approverUserId: 'user_signer',
                    revision: 2,
                    pendingHash: PENDING_HASH,
                    requiredApprovals: 1,
                    createdAt: '2026-09-21T00:00:00.000Z',
                },
            ]),
        ];
        mount();
        const sigs = await screen.findByTestId('parameter-set-signatures-Nightly roster push');
        expect(within(sigs).getByText(/1 of 1 signatures on this digest/)).toBeInTheDocument();
        expect(within(sigs).getByText('user_signer')).toBeInTheDocument();
        // The FULL hash on the signature row too, not only on the pending digest
        // above it — the operator's question is whether the two are the same, so
        // BOTH name it in full and both are focusable copy controls. Exactly
        // two inside this region: the pending-digest line and this one.
        const carriers = within(sigs).getAllByRole('button', {
            name: new RegExp(`^Copy the full digest ${PENDING_HASH}$`),
        });
        expect(carriers).toHaveLength(2);
        const against = carriers.filter((el) => /against/.test(el.textContent ?? ''));
        expect(against).toHaveLength(1);
        expect(against[0]).not.toHaveAttribute('title');
        expect(against[0]).toHaveTextContent(PENDING_HASH.slice(0, 12));
        expect(against[0].textContent ?? '').not.toContain(PENDING_HASH);
        expect(
            within(sigs).getByText(/counts only against the digest it names/),
        ).toBeInTheDocument();
    });
});

/**
 * #3154 — the digest is reachable from the KEYBOARD, not only from a mouse.
 *
 * Why rendered and not a guard: a source scan can see `<CopyText>`, but it
 * cannot see whether what gets rendered takes focus. The defect was exactly
 * that distinction — #3150's three hints were `<Tooltip>`s over a `<p>` and a
 * `<span>`, which are hoverable and NOT focusable, so Radix's focus-open could
 * never fire and the full digest was no more reachable than the native `title=`
 * it replaced. Every ratchet was green, including the one that forced the swap.
 *
 * So these drive the keyboard rather than reading an attribute, and the
 * population is counted rather than sampled: converting one site and leaving
 * two is the regression most likely to be shipped by someone reading only the
 * issue's title.
 */
describe('every digest is reachable from the keyboard, not only the mouse', () => {
    const ONE_SIGNATURE = [
        {
            approverUserId: 'user_signer',
            revision: 2,
            pendingHash: PENDING_HASH,
            requiredApprovals: 1,
            createdAt: '2026-09-21T00:00:00.000Z',
        },
    ];

    it('all THREE digests on a signed pending row are focusable copy controls', async () => {
        listBody = [withPending(ONE_SIGNATURE)];
        mount();
        await screen.findByTestId('parameter-set-signatures-Nightly roster push');

        // THE POPULATION, not a sample: the in-force digest, the pending
        // digest, and the one signature row. A conversion that left any site
        // as a hover-only <p> reads fewer than three here, and a `toHaveLength`
        // cannot be satisfied by an empty query the way a loop over hits can.
        const copies = screen.getAllByRole('button', {
            name: /^Copy the full digest [0-9a-f]{64}$/,
        });
        expect(copies).toHaveLength(3);
        for (const el of copies) {
            expect(el.tagName).toBe('BUTTON');
            expect(el).not.toBeDisabled();
            // Nothing takes it back out of the tab order.
            expect(el).not.toHaveAttribute('tabindex', '-1');
        }

        // Both DISTINCT hashes are named in full, and by the right counts —
        // one in-force, two against the pending edit. A helper that passed the
        // same hash to every site would read 0/3 or 3/0 here.
        const names = copies.map((el) => el.getAttribute('aria-label') ?? '');
        expect(names.filter((n) => n.includes(IN_FORCE_HASH))).toHaveLength(1);
        expect(names.filter((n) => n.includes(PENDING_HASH))).toHaveLength(2);
    });

    it('focus + Enter puts the WHOLE digest on the clipboard, and says so', async () => {
        const { user, writeText } = clipboardUser();
        listBody = [withPending()];
        mount();
        const sigs = await screen.findByTestId('parameter-set-signatures-Nightly roster push');
        const digest = within(sigs).getByRole('button', {
            name: new RegExp(`^Copy the full digest ${PENDING_HASH}$`),
        });

        // KEYBOARD, deliberately. A `click()` would pass on a control no Tab
        // can reach, which is what the <p> was; `focus()` landing at all is
        // the thing a non-focusable element cannot do, so the assertion right
        // after it is the discriminator.
        digest.focus();
        expect(digest).toHaveFocus();
        await user.keyboard('{Enter}');
        expect(writeText).toHaveBeenCalledWith(PENDING_HASH);

        // And what was copied is NOT what was read: the line shows the head.
        expect(digest).toHaveTextContent(PENDING_HASH.slice(0, 12));
        expect(digest.textContent ?? '').not.toContain(PENDING_HASH);
        await waitFor(() =>
            expect(toastMock.success).toHaveBeenCalledWith('Digest copied', {
                duration: 3000,
            }),
        );
    });

    /**
     * #3163 — THE HINT ITSELF, which this file could not reach until the
     * tooltip module mock began delegating.
     *
     * `<CopyText>` imports the primitive as `./tooltip`. `jest.config.js` used
     * to map that spelling to `tests/rendered/tooltip-mock.tsx`, and while that
     * file rendered `<>{children}</>`, no focus and no hover anywhere on this
     * page could produce a `role="tooltip"` node — so "Tab opens the hint
     * showing the whole hash" shipped resting on `tooltip.test.tsx` covering
     * the primitive in the abstract plus Radix's documented behaviour, and on
     * nothing measured on the page that ships it. That is the defect #3163
     * records. This test is what closes it.
     *
     * The mapping is gone now: the primitive supplies its own provider when a
     * suite mounts none, so `./tooltip` resolves to the real module and no
     * spelling gets a different test environment from another.
     *
     * WHY `.focus()` AND the explicit `:focus-visible` assertion: `tooltip.tsx`
     * gates Radix's focus-open on `e.currentTarget.matches(':focus-visible')`,
     * preventing the event otherwise, so that one selector decides whether the
     * hint opens at all. jsdom evaluates it through nwsapi, and the installed
     * version is pinned at **2.2.24** — inside the known-safe window
     * **>=2.2.16 <2.2.25**. 2.2.25 rewrote `:focus-visible`, and that rewrite
     * is what broke this gate in this repo and in its sibling with no warning.
     *
     * So: if this test goes red right after a dependabot bump of **nwsapi**,
     * the bump is the cause, not the change under review. Check the installed
     * version first — `node -p "require('nwsapi/package.json').version"` — and
     * read `tooltip.tsx`'s `onFocus` before touching anything here. The
     * assertion on `matches(':focus-visible')` is in the test precisely so the
     * failure names the mechanism instead of only the symptom.
     */
    it('focus OPENS the hint, and the hint carries the WHOLE 64-char digest', async () => {
        listBody = [withPending()];
        mount();
        const sigs = await screen.findByTestId('parameter-set-signatures-Nightly roster push');
        const digest = within(sigs).getByRole('button', {
            name: new RegExp(`^Copy the full digest ${PENDING_HASH}$`),
        });

        // NEGATIVE half of the pair, before anything is touched: nothing with
        // `role="tooltip"` is mounted. Without this the assertions below could
        // be reading a node that was always on the page.
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        expect(digest).not.toHaveAttribute('aria-describedby');

        digest.focus();
        expect(digest).toHaveFocus();
        // The gate itself, asserted rather than assumed — see the nwsapi
        // window in the docblock. `true` here is what lets Radix open.
        expect(digest.matches(':focus-visible')).toBe(true);

        // Exactly ONE hint is open: the population, so a second tooltip left
        // open elsewhere cannot be what satisfies the text assertion.
        const hints = await screen.findAllByRole('tooltip');
        expect(hints).toHaveLength(1);
        // …and it is THIS control's hint. Radix points the trigger's
        // `aria-describedby` at the node it gives `role="tooltip"`, so this is
        // the link a screen reader follows and the discriminator between "a
        // tooltip opened" and "this digest's tooltip opened".
        expect(hints[0].id).toBe(digest.getAttribute('aria-describedby'));

        // THE PAYOFF: the whole hash, not the 12-char head that is on screen.
        expect(PENDING_HASH).toHaveLength(64);
        expect(hints[0]).toHaveTextContent(PENDING_HASH);
        expect(digest.textContent ?? '').not.toContain(PENDING_HASH);

        // Blur closes it — the other half of the pair, and the proof the hint
        // is an opened surface rather than permanently mounted markup.
        digest.blur();
        await waitFor(() => {
            expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        });
    });
});

describe('sign and approve carry the digest that is on screen', () => {
    it('SIGN posts to the signatures path with expectedPendingHash', async () => {
        listBody = [withPending()];
        mount();
        await screen.findByTestId('parameter-set-pending-Nightly roster push');

        fireEvent.click(screen.getByRole('button', { name: /Sign this edit/ }));
        await waitFor(() =>
            expect(calls.some((c) => c.url.includes('/parameter-sets/signatures'))).toBe(true),
        );
        const call = calls.find((c) => c.url.includes('/parameter-sets/signatures'));
        expect(call?.method).toBe('POST');
        expect(call?.body).toEqual({ id: 'set_1', expectedPendingHash: PENDING_HASH });
    });

    it('APPROVE puts to the collection with the SAME hash, and names it on the button', async () => {
        listBody = [withPending()];
        mount();
        await screen.findByTestId('parameter-set-pending-Nightly roster push');

        // The label names the digest, so the operator approves what they read.
        const approve = screen.getByRole('button', {
            name: new RegExp(`Approve ${PENDING_HASH.slice(0, 12)}`),
        });
        fireEvent.click(approve);
        await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
        const call = calls.find((c) => c.method === 'PUT');
        expect(call?.url).toContain('/admin/agents/parameter-sets');
        expect(call?.url).not.toContain('/signatures');
        expect(call?.body).toEqual({ id: 'set_1', expectedPendingHash: PENDING_HASH });
    });

    it('a refused SIGN renders the SERVER\'s four-eyes sentence', async () => {
        // Verbatim from `fourEyesRefusal` — mapped in the usecase from the
        // database trigger. The client must render it rather than re-word it.
        const refusal =
            'You proposed this edit, so you cannot also be one of its approvers.';
        mutationResponse = { ok: false, body: { error: { message: refusal } } };
        listBody = [withPending()];
        mount();
        await screen.findByTestId('parameter-set-pending-Nightly roster push');

        fireEvent.click(screen.getByRole('button', { name: /Sign this edit/ }));
        const notice = await screen.findByTestId('parameter-set-error-Nightly roster push');
        expect(notice).toHaveTextContent(/cannot also be one of its approvers/);
    });

    it('a refused APPROVE renders the SERVER\'s sentence too', async () => {
        const refusal =
            'This edit changes the bounds on an open field, so it needs an approving signature from a human other than the one who proposed it.';
        mutationResponse = { ok: false, body: { error: { message: refusal } } };
        listBody = [withPending()];
        mount();
        await screen.findByTestId('parameter-set-pending-Nightly roster push');

        fireEvent.click(
            screen.getByRole('button', {
                name: new RegExp(`Approve ${PENDING_HASH.slice(0, 12)}`),
            }),
        );
        const notice = await screen.findByTestId('parameter-set-error-Nightly roster push');
        expect(notice).toHaveTextContent(/approving signature from a human other than/);
    });
});

describe('proposing an edit', () => {
    it('submits the WHOLE intended state, with an explicit null for absent bounds', async () => {
        listBody = [baseline()];
        mount();
        await screen.findByTestId('parameter-set-Nightly roster push');

        fireEvent.click(screen.getByRole('button', { name: /Propose a change/ }));
        const form = screen.getByTestId('parameter-set-propose-Nightly roster push');

        // Prefilled from what is IN FORCE, so an edit starts from the reviewed
        // state rather than from an empty box.
        const params = within(form).getByRole('textbox', { name: /Arguments as JSON/ });
        expect((params as HTMLTextAreaElement).value).toContain('"host": "a.test"');

        fireEvent.change(params, { target: { value: '{"host":"b.test"}' } });
        fireEvent.click(within(form).getByRole('button', { name: /^Propose$/ }));

        await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
        const call = calls.find((c) => c.method === 'PATCH');
        // `openFields: null` and `targetPopulation: null` are SENT, not omitted.
        // Omitting them means "carry the row's bounds forward" in the usecase,
        // which is a different edit from the one this form describes.
        expect(call?.body).toEqual({
            id: 'set_1',
            parameters: { host: 'b.test' },
            openFields: null,
            targetPopulation: null,
        });
    });

    it('refuses malformed JSON locally rather than sending a string as a body', async () => {
        listBody = [baseline()];
        mount();
        await screen.findByTestId('parameter-set-Nightly roster push');

        fireEvent.click(screen.getByRole('button', { name: /Propose a change/ }));
        const form = screen.getByTestId('parameter-set-propose-Nightly roster push');
        fireEvent.change(within(form).getByRole('textbox', { name: /Arguments as JSON/ }), {
            target: { value: '{not json' },
        });
        fireEvent.click(within(form).getByRole('button', { name: /^Propose$/ }));

        expect(
            await screen.findByTestId('parameter-set-error-Nightly roster push'),
        ).toHaveTextContent(/not valid JSON/);
        expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    });
});

describe('the baseline form', () => {
    it('states the trust-on-first-use ordering BEFORE the refusal is reached', async () => {
        mount();
        const card = await screen.findByTestId('parameter-set-create');
        expect(within(card).getByText(/trust-on-first-use/)).toBeInTheDocument();
        expect(within(card).getByText(/open fields and a target population are refused here/))
            .toBeInTheDocument();
    });

    it('surfaces the SERVER\'s open-fields refusal as a sentence', async () => {
        const refusal =
            'A new parameter set cannot be saved with open fields. A first save is trust-on-first-use.';
        mutationResponse = { ok: false, body: { error: { message: refusal } } };
        const user = userEvent.setup();
        mount();
        await screen.findByTestId('parameter-set-create');

        // The tool comes from the CATALOGUE, through the real picker.
        await user.click(document.getElementById('parameter-sets-tool') as HTMLElement);
        await user.click(await screen.findByText('update_user'));
        fireEvent.change(document.getElementById('parameter-sets-label') as HTMLElement, {
            target: { value: 'Nightly roster push' },
        });

        fireEvent.click(screen.getByRole('button', { name: /Save baseline/ }));
        expect(await screen.findByTestId('parameter-set-create-error')).toHaveTextContent(
            /cannot be saved with open fields/,
        );
        const post = calls.find((c) => c.method === 'POST');
        expect(post?.body).toEqual({
            toolName: TOOL,
            label: 'Nightly roster push',
            parameters: {},
        });
    });

    it('a catalogue failure is reported WITHOUT blanking the saved sets', async () => {
        // Somebody else's outage must not read as "this tenant has no saved
        // parameters" — the list comes from our own database.
        catalogue = { ok: false, body: { error: { message: 'Server unreachable.' } } };
        listBody = [baseline()];
        mount();
        expect(await screen.findByTestId('parameter-sets-catalogue-error')).toHaveTextContent(
            /Server unreachable/,
        );
        expect(screen.getByTestId('parameter-set-Nightly roster push')).toBeInTheDocument();
    });
});

describe('a connection the operator is not looking at', () => {
    it('is filtered out, so the register is about the selected server', async () => {
        listBody = [
            baseline(),
            baseline({
                id: 'set_2',
                label: 'Other server set',
                toolName: 'mcp__conn_2__update_user',
            }),
        ];
        mount();
        await screen.findByTestId('parameter-set-Nightly roster push');
        expect(screen.queryByTestId('parameter-set-Other server set')).not.toBeInTheDocument();
    });
});
