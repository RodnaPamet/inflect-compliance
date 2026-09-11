/**
 * The agents "Views ▾" menu (#2436, #2439).
 *
 * Five claims:
 *
 *   1. FIVE ENTRIES, IN TWO LABELLED GROUPS. Pinned as exact ordered lists, not
 *      as counts: `>= 5` is satisfied by five of the wrong things, and a group
 *      heading that went missing would leave the rows reading as one flat list
 *      while every count still held.
 *
 *   2. `selected` MARKS THE CURRENT ROUTE — and exactly one row, so the menu
 *      says where you are. On the register itself NOTHING is selected, which is
 *      correct: the register is not an entry in its own menu.
 *
 *   3. A PERMISSION-ABSENT ITEM IS NOT RENDERED, not rendered disabled.
 *      `ViewsMenuGroup.items` drops falsy members, which is what makes the
 *      inline `perm && {…}` gate work — and the distinction matters: a disabled
 *      row in a NAVIGATION menu advertises a destination whose page would
 *      refuse the click. Asserted in both directions, including that the row is
 *      not merely `aria-disabled`.
 *
 *   4. A GROUP LEFT EMPTY DISAPPEARS, HEADING AND ALL — the half of the falsy
 *      filtering that a per-item assertion cannot see.
 *
 *   5. THE PROPOSALS BADGE APPEARS ONLY WHEN PROPOSALS AWAIT REVIEW. Three
 *      states, because there are three: a positive count, zero, and `null`
 *      (the page could not read the queue). A badge reading "0" is a
 *      notification about the absence of anything to notify.
 *
 * The menu is CLOSED until its trigger is clicked — a `<Popover>` — so every
 * assertion below opens it first. Reading the closed trigger would assert
 * nothing about the entries.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(120_000);

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const cache = new Map<string, (key: string) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string) => {
            const bag = ns.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en,
            );
            const v = key.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                bag,
            );
            return typeof v === 'string' ? v : key;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents',
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

import {
    AgentsViewsMenu,
    type AgentsViewRoute,
} from '@/app/t/[tenantSlug]/(app)/agents/AgentsViewsMenu';

const EN = require('../../messages/en.json') as {
    agents: { views: Record<string, string> };
};
const VIEWS = EN.agents.views;

/** The five entry ids, in the order the menu declares them. */
const ENTRY_IDS = [
    'agents-view-proposals',
    'agents-view-runs',
    'agents-view-receipts',
    'agents-view-quarantine',
    'agents-view-review-quality',
] as const;

async function openMenu(
    opts: {
        current?: AgentsViewRoute;
        canReviewProposals?: boolean;
        canInvestigate?: boolean;
        proposalsAwaitingReview?: number | null;
    } = {},
) {
    const user = userEvent.setup();
    render(
        <AgentsViewsMenu
            current={opts.current ?? 'register'}
            tenantSlug="acme"
            canReviewProposals={opts.canReviewProposals ?? true}
            canInvestigate={opts.canInvestigate ?? true}
            proposalsAwaitingReview={opts.proposalsAwaitingReview ?? null}
        />,
    );
    const trigger = document.getElementById('agents-views-menu');
    if (trigger) await user.click(trigger);
    return { user, trigger };
}

/** The rendered menu-item rows, in DOM order. */
const items = () => screen.queryAllByRole('menuitem');

describe('five entries in two labelled groups', () => {
    it('renders exactly the five, in order', async () => {
        await openMenu();
        // The ids, as an exact ordered list — a count would pass for five rows
        // pointing anywhere.
        expect(items().map((el) => el.id)).toEqual([...ENTRY_IDS]);
    });

    it('each entry links to its own /agents child route', async () => {
        await openMenu();
        expect(items().map((el) => el.getAttribute('href'))).toEqual([
            '/t/acme/agents/proposals',
            '/t/acme/agents/runs',
            '/t/acme/agents/receipts',
            '/t/acme/agents/quarantine',
            '/t/acme/agents/review-quality',
        ]);
    });

    it('renders BOTH group headings', async () => {
        await openMenu();
        expect(screen.getByText(VIEWS.groupOperate)).toBeTruthy();
        expect(screen.getByText(VIEWS.groupAssurance)).toBeTruthy();
    });

    it('the labels are the destinations, not acronyms', async () => {
        await openMenu();
        expect(items().map((el) => el.textContent?.trim())).toEqual([
            VIEWS.proposals,
            VIEWS.runs,
            VIEWS.receipts,
            VIEWS.quarantine,
            VIEWS.reviewQuality,
        ]);
    });
});

describe('`selected` marks the current route', () => {
    it.each([
        ['proposals', 'agents-view-proposals'],
        ['runs', 'agents-view-runs'],
        ['receipts', 'agents-view-receipts'],
        ['quarantine', 'agents-view-quarantine'],
        ['review-quality', 'agents-view-review-quality'],
    ] as const)('on %s exactly that one row is selected', async (current, id) => {
        await openMenu({ current });
        // The selected TONE is the observable — the shared `ROW_CLASS` plus
        // `bg-bg-subtle text-content-emphasis` for the current row. Counted
        // over the whole menu so "exactly one" is the claim, not "this one".
        const marked = items().filter((el) => el.className.includes('bg-bg-subtle'));
        expect(marked.map((el) => el.id)).toEqual([id]);
    });

    it('on the REGISTER nothing is selected — it is not an entry in its own menu', async () => {
        await openMenu({ current: 'register' });
        expect(items().filter((el) => el.className.includes('bg-bg-subtle'))).toEqual([]);
        // Paired positive over the same render: the menu is populated, so the
        // empty selection above is a real answer rather than an empty menu.
        expect(items().length).toBe(5);
    });
});

describe('a permission-absent entry is NOT RENDERED', () => {
    it('drops the two operate entries without admin.view', async () => {
        await openMenu({ canReviewProposals: false });
        expect(items().map((el) => el.id)).toEqual([
            'agents-view-receipts',
            'agents-view-quarantine',
            'agents-view-review-quality',
        ]);
    });

    it('drops the three assurance entries without the register key', async () => {
        await openMenu({ canInvestigate: false });
        expect(items().map((el) => el.id)).toEqual([
            'agents-view-proposals',
            'agents-view-runs',
        ]);
    });

    it('does not render them DISABLED — they are absent from the DOM entirely', async () => {
        await openMenu({ canInvestigate: false });
        // The distinction the falsy filtering exists for. A disabled row in a
        // navigation menu advertises a destination whose page would refuse the
        // click; these three have no row at all.
        for (const id of ['agents-view-receipts', 'agents-view-quarantine']) {
            expect(document.getElementById(id)).toBeNull();
        }
        expect(screen.queryAllByRole('menuitem', { hidden: true }).length).toBe(2);
        expect(document.querySelectorAll('[aria-disabled="true"]').length).toBe(0);
        expect(document.querySelectorAll('[disabled]').length).toBe(0);
    });

    it('an emptied GROUP disappears, heading and all', async () => {
        await openMenu({ canInvestigate: false });
        expect(screen.getByText(VIEWS.groupOperate)).toBeTruthy();
        expect(screen.queryByText(VIEWS.groupAssurance)).toBeNull();
    });

    it('with neither permission the menu renders NOTHING — not an empty popover', async () => {
        await openMenu({ canReviewProposals: false, canInvestigate: false });
        // Not even the trigger: `ViewsMenu` returns null when every group is
        // empty, so there is no button to click and no heading to read.
        expect(document.getElementById('agents-views-menu')).toBeNull();
        expect(items()).toEqual([]);
        expect(screen.queryByText(VIEWS.groupOperate)).toBeNull();
    });
});

describe('the Proposals badge appears only when proposals await review', () => {
    /** The badge chip lives inside the Proposals row. */
    const badgeText = () => {
        const row = document.getElementById('agents-view-proposals');
        if (!row) return null;
        // The visible chip, not the sr-only sentence beside it.
        const chip = row.querySelector('[aria-hidden="true"]');
        return chip?.textContent ?? null;
    };

    it('renders the count when proposals are waiting', async () => {
        await openMenu({ proposalsAwaitingReview: 3 });
        expect(badgeText()).toBe('3');
        // …and says what it counts, for a screen reader. A bare number read
        // after a label says nothing.
        const row = document.getElementById('agents-view-proposals') as HTMLElement;
        expect(within(row).getByText(`3 ${VIEWS.proposalsBadgeLabel}`)).toBeTruthy();
    });

    it('renders NO badge at zero', async () => {
        await openMenu({ proposalsAwaitingReview: 0 });
        expect(document.getElementById('agents-view-proposals')).not.toBeNull();
        expect(badgeText()).toBeNull();
    });

    it('renders NO badge when the count is unreadable (null)', async () => {
        // Distinct from zero in meaning and identical in rendering, on purpose:
        // "this page cannot tell you" must not render as a confident nothing
        // NOR as a confident number.
        await openMenu({ proposalsAwaitingReview: null });
        expect(document.getElementById('agents-view-proposals')).not.toBeNull();
        expect(badgeText()).toBeNull();
    });

    it('no OTHER entry carries a badge', async () => {
        await openMenu({ proposalsAwaitingReview: 7 });
        const badged = items().filter((el) => el.querySelector('[aria-hidden="true"]'));
        expect(badged.map((el) => el.id)).toEqual(['agents-view-proposals']);
    });
});
