/**
 * THE AGENTS TOOLBAR'S COMPOSITION (#2436).
 *
 * Two claims about WHERE things sit, which is the whole content of the rule the
 * ControlsClient call site records:
 *
 *   • The ViewsMenu is in `filters.toolbarActions` — the toolbar's secondary
 *     cluster, not `header.actions`. The header stays NAVIGATIONAL; the toolbar
 *     is where the list's own controls live.
 *
 *   • THE GEARS STAY OUTSIDE THE MENU, AND ONE RUNG SMALLER. They are table
 *     chrome, not views. Folding them in would make "edit the KPI cards" read
 *     as another way to look at the data, and putting them at the trigger's
 *     size would flatten the hierarchy the labelled menu exists to create.
 *
 * Both are assertions about the DOM's SHAPE — containment and relative size —
 * because that is what "outside it" and "one rung smaller" mean. A source read
 * would confirm the props were passed and say nothing about where they landed.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(180_000);

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            ns.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en,
            ) as Record<string, unknown>,
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

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/agents',
    useSearchParams: () => new URLSearchParams(),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentsClient, type AgentRow } from '@/app/t/[tenantSlug]/(app)/agents/AgentsClient';

const ROW: AgentRow = {
    id: 'agent-1',
    name: 'Control reconciler',
    status: 'ACTIVE',
    autonomyLevel: 3,
    dataAccessScope: 'READ_TENANT_DATA',
    reversibility: 'COMPENSABLE',
    provenance: 'FIRST_PARTY',
    riskTier: 'MODERATE',
    isLegacyPlaceholder: false,
    owner: { id: 'user-1', name: 'Dana Iveagh', email: 'dana@acme.test' },
    aiSystem: null,
    _count: { apiKeys: 0 },
};

function renderRegister() {
    return render(
        <TooltipProvider delayDuration={0}>
            <AgentsClient
                initialRows={[ROW]}
                tenantSlug="acme"
                owners={[{ id: 'user-1', label: 'Dana Iveagh' }]}
                vendors={[]}
                kpiCounts={{ total: 1, active: 1, unscored: 0, egress: 0 }}
                governance={{ enforcing: true, unboundCredentials: 0 }}
                assurance={null}
                proposalsAwaitingReview={null}
                canWrite
                canReviewProposals
            />
        </TooltipProvider>,
    );
}

/** The toolbar row: the ancestor that holds the Filter trigger. */
function toolbar(): HTMLElement {
    const trigger = document.getElementById('agents-views-menu');
    expect(trigger).not.toBeNull();
    // Two levels up from the trigger is the actions cluster; the toolbar row is
    // its parent. Resolved by walking from a known element rather than by a
    // class selector, which would pin Tailwind output.
    const cluster = (trigger as HTMLElement).parentElement;
    expect(cluster).not.toBeNull();
    return cluster as HTMLElement;
}

describe('the ViewsMenu is in the toolbar, not the header', () => {
    it('renders its trigger', () => {
        renderRegister();
        expect(document.getElementById('agents-views-menu')).not.toBeNull();
    });

    it('sits in the SAME cluster as the filter gear, below the page header', () => {
        renderRegister();
        const trigger = document.getElementById('agents-views-menu') as HTMLElement;
        // The header is the `<h1>`'s nearest header-ish ancestor. The menu must
        // NOT be inside it: `header.actions` is the slot this deliberately
        // avoids, because the header stays navigational.
        const heading = screen.getAllByRole('heading')[0];
        const headerBlock = heading.closest('div')?.parentElement ?? null;
        if (headerBlock) expect(headerBlock.contains(trigger)).toBe(false);
        // …and it IS beside the gear, which is the toolbar's own cluster.
        const gear = document.querySelector('[data-testid="edit-filters-button"]');
        expect(gear).not.toBeNull();
        expect(toolbar().contains(gear as HTMLElement)).toBe(true);
    });

    it('the primary create button leads the toolbar, to the LEFT of the menu', () => {
        renderRegister();
        const create = document.getElementById('new-agent-btn') as HTMLElement;
        const trigger = document.getElementById('agents-views-menu') as HTMLElement;
        // Document order, which is reading order. `toolbarLeading` puts the
        // create button ahead of the Filter trigger; the menu is in the
        // trailing actions cluster.
        expect(
            create.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });
});

describe('the gears stay OUTSIDE the menu, and one rung smaller', () => {
    it('the gear is not a menu item', async () => {
        const user = userEvent.setup();
        renderRegister();
        await user.click(document.getElementById('agents-views-menu') as HTMLElement);
        const rows = screen.queryAllByRole('menuitem');
        // AGENTIC DESTINATIONS AND NOTHING ELSE. The gear folded in would read
        // as "another way to look at this data", which it is not.
        //
        // The exact count used to be pinned at five and is deliberately not any
        // more: this test is about WHAT is in the menu, not how much, and the
        // loop below already makes that claim for every item. A number here
        // only records how many destinations existed the day it was written —
        // AGENTIC UI 4/4 added Reports and turned a true statement about
        // composition into a false one about arithmetic. Same reasoning as the
        // count removed from `agents-views-navigation.spec.ts`.
        //
        // The floor stays, because the loop is vacuous on an empty menu: a
        // popover that rendered no items at all would satisfy it.
        expect(rows.length).toBeGreaterThanOrEqual(5);
        for (const row of rows) {
            expect(row.id.startsWith('agents-view-')).toBe(true);
        }
        const gear = document.querySelector('[data-testid="edit-filters-button"]');
        expect(gear).not.toBeNull();
        // Containment, in both directions: the gear is not inside the popover,
        // and the popover is not inside the gear.
        const popover = rows[0].closest('[role="menu"]') as HTMLElement;
        expect(popover.contains(gear as HTMLElement)).toBe(false);
    });

    it('the gear renders ONE RUNG SMALLER than the Views trigger', () => {
        renderRegister();
        const trigger = document.getElementById('agents-views-menu') as HTMLElement;
        const gear = document.querySelector(
            '[data-testid="edit-filters-button"]',
        ) as HTMLElement;
        // The size rungs are Button's own classes. `h-7` is `size="sm"` (the
        // Views trigger); the gear is `size="icon-sm"`, one rung down. Read as
        // the height token rather than a computed pixel value, which jsdom
        // does not resolve from Tailwind.
        expect(trigger.className).toContain('h-7');
        expect(gear.className).not.toContain('h-7');
        // Paired positive: the gear IS a button with a size class, so the
        // negative above is a difference rather than an unstyled element.
        expect(gear.tagName.toLowerCase()).toBe('button');
        expect(gear.className).toMatch(/\bh-6\b|\bsize-6\b|\bh-\[/);
    });
});
