/**
 * THE REVIEWER'S QUEUE SHOWS THE GUARD'S VERDICT.
 *
 * `guardAgentProposal` returns FLAGGED when an injection rule fired but nothing
 * was malicious, and `createAgentProposal` writes those rows `status =
 * 'PENDING'` — so a flagged proposal sits in `/t/:slug/agent-proposals` next to
 * the clean ones and is approvable. Until this change the page's projection
 * forwarded no guard column at all, and the two rendered identically: a reviewer
 * could create the real record from content that matched a known injection
 * pattern with nothing on screen saying so. That is ASI01 / ASI06 arriving
 * through the one gate built to stop them.
 *
 * The load-bearing claim, and the first describe block, is that a FLAGGED,
 * PENDING row shows its guard state IN THE LIST — not after opening a row.
 * Whether a row gets opened is decided from the list, so a signal that only
 * appears afterwards cannot change which rows get read.
 *
 * The second block is about a distinction the column cannot make on its own.
 * `guardVerdict` is `NOT NULL DEFAULT 'CLEAN'` and the migration ran no
 * backfill, so a row written before the guard existed reads CLEAN without ever
 * having been scanned. "Found nothing" and "never looked" are different claims;
 * `guardInputDigest` is what separates them, and these tests fail if the two
 * ever render the same.
 *
 * The third block is the approve seam. A verdict shown in the row but absent
 * from the approve confirmation is a defence that is easy to click past, so a
 * FLAGGED approval takes a second, deliberate confirmation that repeats the
 * rules. Its paired positive is that a CLEAN approval still takes ONE click —
 * without that, "there is a dialog" would be satisfied by a page that
 * interrupts every approval, which is how a dialog becomes something people
 * dismiss unread.
 *
 * NOTE ON THE MESSAGE KEYS. The `agents.proposals.guard.*` strings are added to
 * `messages/en.json` by the integrator (an unmerged PR owns large edits to that
 * file), so this suite never asserts their VALUES — it asserts testids, the
 * rule ids, which come from the data, and that two states render DIFFERENT
 * text. Those assertions hold both before and after the catalogue lands.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';

// next-intl is ESM (jest cannot parse it); mock it resolving real en.json
// values. `make` is MEMOISED per namespace — a fresh `t` identity on every
// render invalidates any `useMemo([t])` downstream, which turns a render into a
// loop rather than a failure.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key
            .split('.')
            .reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en[ns],
            );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

/**
 * The catalogue string a key resolves to, read from `messages/en.json` the same
 * way the component's `useTranslations('agents')` does.
 *
 * Assertions read through this rather than against literal expected text, and
 * emphatically not against the KEY PATH. next-intl renders a missing key as its
 * own dotted path, so `toHaveTextContent('proposals.guard.noRules')` passes
 * only while the catalogue is incomplete and goes red the moment the keys land
 * — the assertion would have been pinning the bug rather than the behaviour.
 */
function en(dotted: string): string {
    const messages = require('../../messages/en.json') as Record<string, unknown>;
    const value = `agents.${dotted}`
        .split('.')
        .reduce<unknown>(
            (node, part) =>
                node && typeof node === 'object'
                    ? (node as Record<string, unknown>)[part]
                    : undefined,
            messages,
        );
    if (typeof value !== 'string') {
        throw new Error(`messages/en.json has no string at agents.${dotted}`);
    }
    return value;
}

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/agents/proposals',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

// Force the desktop Dialog branch. jsdom's matchMedia polyfill reports
// matches:false, so `useMediaQuery` defaults to mobile and Modal mounts the
// Vaul Drawer, whose drag handlers throw in jsdom. The Dialog branch is what a
// reviewer at a desk sees anyway.
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        useMediaQuery: () => ({
            device: 'desktop',
            width: 1280,
            height: 800,
            isMobile: false,
            isDesktop: true,
        }),
    };
});

import {
    AgentProposalsClient,
    resolveProposalGuardState,
    type ProposalRow,
} from '@/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient';
import { computeProposalDiff } from '@/lib/agentic/proposal-diff';

/** The two rule ids a real injection scan puts on a flagged proposal. */
const RULE_IDS = ['injection.role_declaration', 'injection.direct_override'];

/**
 * A PENDING CREATE proposal with a computable diff, so the approve control is
 * rendered — `ProposalDiffPanel` withholds it when the diff could not be
 * worked out, and a withheld button would make the approve-seam block vacuous.
 */
function makeRow(overrides: Partial<ProposalRow> = {}): ProposalRow {
    return {
        id: 'p-clean',
        kind: 'RISK',
        operation: 'CREATE',
        status: 'PENDING',
        targetEntityId: null,
        rationale: 'Observed three failed backups in the last quarter.',
        proposedViaKeyId: 'key-abcdef12',
        createdAt: '2026-09-01T10:00:00.000Z',
        // The post-guard clean row: the scan ran (a digest exists) and nothing
        // fired.
        guardVerdict: 'CLEAN',
        guardRuleIds: [],
        guardInputDigest: 'sha256:0123456789abcdef0123456789abcdef',
        diff: computeProposalDiff({
            operation: 'CREATE',
            payloadJson: JSON.stringify({ title: 'Backup failure risk', impact: 8 }),
        }),
        ...overrides,
    };
}

/** A rule fired, nothing was malicious — queued PENDING, and approvable. */
const FLAGGED_ROW = makeRow({
    id: 'p-flagged',
    guardVerdict: 'FLAGGED',
    guardRuleIds: RULE_IDS,
    guardInputDigest: 'sha256:fedcba9876543210fedcba9876543210',
});

/** A row that predates the guard: the default verdict, and NO digest. */
const UNSCANNED_ROW = makeRow({
    id: 'p-legacy',
    guardVerdict: 'CLEAN',
    guardRuleIds: [],
    guardInputDigest: null,
});

const CLEAN_ROW = makeRow();

function renderQueue(rows: ProposalRow[]) {
    return render(<AgentProposalsClient tenantSlug="acme" initialProposals={rows} canOperate />);
}

/** A 200 with an applied-immediately body — the single-approver success shape. */
function mockFetchOk() {
    const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ACCEPTED' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
}

afterEach(cleanup);

describe('a FLAGGED, PENDING row is visibly flagged in the LIST', () => {
    it('names the verdict and the rule ids without anything being opened', () => {
        renderQueue([FLAGGED_ROW, CLEAN_ROW]);

        // The badge sits in the card header, beside kind and operation.
        expect(screen.getByTestId(`proposal-guard-badge-${FLAGGED_ROW.id}`)).toBeInTheDocument();

        // And the rule ids are legible, not summarised away. A rule id is what
        // turns "something was odd" into "this matched a known pattern".
        const notice = screen.getByTestId(`proposal-guard-flagged-${FLAGGED_ROW.id}`);
        expect(
            within(notice).getByTestId(`proposal-guard-rules-${FLAGGED_ROW.id}`),
        ).toHaveTextContent('injection.role_declaration, injection.direct_override');

        // Nothing was expanded to get here: the diff panel's own body is the
        // only thing a click reveals, and the flag was already on screen.
        expect(screen.getByTestId(`proposal-diff-${FLAGGED_ROW.id}`)).toBeInTheDocument();
    });

    it('flags the flagged row ONLY — the clean row beside it carries no warning', () => {
        renderQueue([FLAGGED_ROW, CLEAN_ROW]);

        // Positive companion first: the flagged notice exists, so the absence
        // below is a real per-row decision rather than a page that rendered
        // nothing.
        expect(screen.getByTestId(`proposal-guard-flagged-${FLAGGED_ROW.id}`)).toBeInTheDocument();
        expect(
            screen.queryByTestId(`proposal-guard-flagged-${CLEAN_ROW.id}`),
        ).not.toBeInTheDocument();
    });

    it('says so when a non-clean verdict carries no rule ids at all', () => {
        // A verdict the rule table cannot explain is a finding of its own. An
        // empty cell would read as "nothing to see" — the same vocabulary the
        // quarantine table uses for this state.
        renderQueue([makeRow({ id: 'p-norules', guardVerdict: 'FLAGGED', guardRuleIds: [] })]);

        const rules = screen.getByTestId('proposal-guard-rules-p-norules');
        expect(rules.textContent).not.toBe('');
        // Compared against the catalogue, NOT against a literal key path. The
        // first version asserted `toHaveTextContent('proposals.guard.noRules')`,
        // which is only true while the key is MISSING — next-intl renders the
        // key path as a fallback — so merging the catalogue would have turned
        // this red. Reading the same string the component reads pins the
        // rendering in both worlds, and pins that this state reuses the shared
        // guard vocabulary rather than minting a second one.
        expect(rules).toHaveTextContent(en('guard.noRules'));
        // …and it is not the ids list, which is the state next door.
        expect(rules).not.toHaveTextContent(en('proposals.guard.rulesLabel'));
    });
});

describe('"not flagged" and "never checked" are different claims', () => {
    it('renders an unscanned row differently from a clean one', () => {
        renderQueue([CLEAN_ROW, UNSCANNED_ROW]);

        // The legacy row carries its own line saying the guard never ran.
        expect(screen.getByTestId(`proposal-guard-unscanned-${UNSCANNED_ROW.id}`)).toBeInTheDocument();
        // The scanned-clean row does NOT — and the assertion above is the
        // positive companion that proves the page rendered both cards.
        expect(
            screen.queryByTestId(`proposal-guard-unscanned-${CLEAN_ROW.id}`),
        ).not.toBeInTheDocument();

        // And the badges themselves differ. Asserting the TEXTS are unequal
        // rather than what they say keeps this honest whether or not the
        // message catalogue has landed — but a single shared badge for both
        // states fails it either way.
        const cleanBadge = screen.getByTestId(`proposal-guard-badge-${CLEAN_ROW.id}`);
        const legacyBadge = screen.getByTestId(`proposal-guard-badge-${UNSCANNED_ROW.id}`);
        expect(cleanBadge.textContent).not.toBe(legacyBadge.textContent);
        expect(cleanBadge.textContent?.trim().length).toBeGreaterThan(0);
        expect(legacyBadge.textContent?.trim().length).toBeGreaterThan(0);
    });

    it('an unscanned row is not treated as flagged either', () => {
        renderQueue([UNSCANNED_ROW]);

        // Three states, three renderings: the absence of a scan is not an
        // accusation, so it must not wear the flagged notice.
        expect(screen.getByTestId(`proposal-guard-unscanned-${UNSCANNED_ROW.id}`)).toBeInTheDocument();
        expect(
            screen.queryByTestId(`proposal-guard-flagged-${UNSCANNED_ROW.id}`),
        ).not.toBeInTheDocument();
    });

    it('resolveProposalGuardState reads the digest, not the verdict alone', () => {
        // The pure decision behind all of the above. `guardVerdict` is NOT NULL
        // DEFAULT CLEAN, so the digest is the only fact that separates a scan
        // from no scan.
        expect(resolveProposalGuardState({ guardVerdict: 'CLEAN', guardInputDigest: 'sha256:ab' }))
            .toBe('CLEAN');
        expect(resolveProposalGuardState({ guardVerdict: 'CLEAN', guardInputDigest: null }))
            .toBe('UNSCANNED');
        expect(resolveProposalGuardState({ guardVerdict: 'FLAGGED', guardInputDigest: 'sha256:ab' }))
            .toBe('FLAGGED');
        // QUARANTINED cannot reach this queue (`listAgentProposals` names the
        // reviewable statuses in the query itself), but if it ever did it must
        // not read as clean.
        expect(
            resolveProposalGuardState({ guardVerdict: 'QUARANTINED', guardInputDigest: null }),
        ).toBe('FLAGGED');
    });
});

describe('the verdict is repeated at the moment of approving', () => {
    it('a FLAGGED approval asks again, naming the rules, before anything is sent', async () => {
        const fetchMock = mockFetchOk();
        renderQueue([FLAGGED_ROW]);

        fireEvent.click(screen.getByTestId(`proposal-approve-${FLAGGED_ROW.id}`));

        const body = await screen.findByTestId('proposal-guard-confirm-body');
        expect(within(body).getByTestId('proposal-guard-confirm-rules')).toHaveTextContent(
            'injection.role_declaration, injection.direct_override',
        );
        // The click did NOT approve. If the dialog were decoration over a
        // request already in flight, this would be 1.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('confirming in the dialog is what sends the approval', async () => {
        const fetchMock = mockFetchOk();
        renderQueue([FLAGGED_ROW]);

        fireEvent.click(screen.getByTestId(`proposal-approve-${FLAGGED_ROW.id}`));
        await screen.findByTestId('proposal-guard-confirm-body');

        // `[data-modal-confirm]`, not the button's text. Matching on
        // 'proposals.guard.confirmApprove' only found the button while the key
        // was absent and next-intl was rendering the key path; the moment the
        // catalogue landed the text became "Approve anyway" and the lookup
        // returned undefined. `Modal.Confirm` already stamps this attribute on
        // its commit button, so it identifies the control by role in the
        // component's own terms.
        const confirm = document.querySelector('[data-modal-confirm]');
        expect(confirm).not.toBeNull();
        expect(confirm).toHaveTextContent(en('proposals.guard.confirmApprove'));
        fireEvent.click(confirm as HTMLElement);

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(fetchMock.mock.calls[0][0]).toBe(
            `/api/t/acme/agent-proposals/${FLAGGED_ROW.id}/approve`,
        );
    });

    it('a CLEAN approval is still one click — the interruption is spent where it matters', async () => {
        const fetchMock = mockFetchOk();
        renderQueue([CLEAN_ROW]);

        fireEvent.click(screen.getByTestId(`proposal-approve-${CLEAN_ROW.id}`));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        // This is the paired positive for the two tests above: "a dialog
        // appears" would also be satisfied by a page that interrupts every
        // approval, and an interruption on every row is the one that gets
        // clicked through unread.
        expect(screen.queryByTestId('proposal-guard-confirm-body')).not.toBeInTheDocument();
    });
});
