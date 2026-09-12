/**
 * `/agents` is a STANDARD LIST PAGE (#2421, #2431, #2432).
 *
 * Four claims, each about something a reader takes as a promise:
 *
 *   1. THE REGISTER IS THE MAIN TABLE. Not a card grid, not a section inside an
 *      admin hub: the `#agents-table` DataTable, with the register's rows in
 *      it, the way `/policies` and `/vendors` render theirs.
 *
 *   2. ALL FOUR KPI CARDS RENDER, AND EACH IS REGISTERED `kind: 'kpi'`. The
 *      registration is asserted separately from the rendering because the two
 *      come apart: the visibility gear's stale-data migration only fires when
 *      EVERY persisted id is dead, so a card registered as `kind: 'filter'`
 *      would render today and vanish for anyone who had ever touched the gear
 *      (#1886). Reading the card definitions is the only way to see that.
 *
 *   3. THE BANNER SAYS THE RIGHT SENTENCE FOR EACH OF THE THREE STATES. All
 *      three RENDER — including "everything is fine", because a state that
 *      renders nothing cannot be told from a banner that failed.
 *
 *   4. THE PRIMARY ACTION IS `icon={<Plus />}` + THE BARE NOUN. The house
 *      vocabulary: the verb is dead weight once the glyph is doing the work,
 *      so the label is "Agent" and not "Add agent" / "New agent".
 *
 * The KPI numbers are read from the `kpiCounts` PROP, never derived here, and
 * the values fed in deliberately DISAGREE with `initialRows.length` — see the
 * comment on `COUNTS`.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

// Mounting the register mounts the table, the filter system, the KPI strip and
// the create modal's form stack — a one-off module load that runs to tens of
// seconds on a loaded machine.
jest.setTimeout(180_000);

// next-intl is ESM. Resolved against the real en.json so every assertion reads
// the catalogue rather than a dotted key path: next-intl renders a MISSING key
// as its own path, so a path assertion passes only while the catalogue is
// incomplete. `make` is memoised per namespace — a fresh `t` identity on each
// render invalidates the `useMemo([t])` that builds the columns.
//
// ICU PLURALS ARE NOT EXPANDED by this mock (it does `{param}` substitution
// only), which is why the unbound-credential assertion below reads the
// sentence's TAIL rather than its plural head.
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
import {
    AgentsClient,
    GovernanceBanner,
    type AgentRow,
} from '@/app/t/[tenantSlug]/(app)/agents/AgentsClient';

const EN = require('../../messages/en.json') as {
    agents: {
        register: {
            title: string;
            addAgent: string;
            kpi: Record<string, string>;
            governance: Record<string, string>;
        };
    };
};
const REGISTER = EN.agents.register;

/**
 * KPI values that CANNOT be derived from the rows below.
 *
 * Three rows are rendered and `total` reads 47. That disagreement is the whole
 * point: a card whose number came from the loaded array would read 3 here, and
 * #1905 was exactly that — a card that read 3 and filtered to 47. If a future
 * change re-derives the numbers client-side, these assertions go red rather
 * than silently agreeing.
 */
const COUNTS = { total: 47, active: 31, unscored: 12, egress: 4 };

function makeRow(overrides: Partial<AgentRow> = {}): AgentRow {
    return {
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
        aiSystem: { id: 'sys-1', riskTier: 'LIMITED', classificationClauseId: 'Art 95' },
        _count: { apiKeys: 2 },
        ...overrides,
    };
}

const ROWS: AgentRow[] = [
    makeRow({ id: 'a1', name: 'Control reconciler' }),
    makeRow({ id: 'a2', name: 'Evidence sweeper', status: 'SUSPENDED', riskTier: null }),
    makeRow({ id: 'a3', name: 'Egress reporter', dataAccessScope: 'EXTERNAL_EGRESS' }),
];

function renderRegister(
    opts: {
        rows?: AgentRow[];
        governance?: { enforcing: boolean; unboundCredentials: number };
        canWrite?: boolean;
    } = {},
) {
    // The Unscored cell mounts an `<InfoTooltip>`, which is a Radix consumer
    // and throws outside a provider. One of the seeded rows is deliberately
    // unscored — that is the register's whole reason to exist — so the
    // provider is required rather than incidental.
    return render(
        <TooltipProvider delayDuration={0}>
            <AgentsClient
                initialRows={opts.rows ?? ROWS}
                tenantSlug="acme"
                owners={[{ id: 'user-1', label: 'Dana Iveagh' }]}
                vendors={[]}
                kpiCounts={COUNTS}
                governance={opts.governance ?? { enforcing: true, unboundCredentials: 0 }}
                assurance={null}
                proposalsAwaitingReview={null}
                canWrite={opts.canWrite ?? true}
                canReviewProposals
            />
        </TooltipProvider>,
    );
}

describe('the register is the page’s main table', () => {
    it('renders the register rows inside #agents-table', () => {
        renderRegister();
        const table = document.getElementById('agents-table');
        expect(table).not.toBeNull();
        // Every seeded row is IN it — not "the table exists", which an empty
        // table satisfies. An empty selection is a pass, so the rows are named.
        for (const row of ROWS) {
            expect(within(table as HTMLElement).getByText(row.name)).toBeTruthy();
        }
    });

    it('carries the register’s own title, not an admin-hub heading', () => {
        renderRegister();
        expect(screen.getAllByText(REGISTER.title).length).toBeGreaterThanOrEqual(1);
    });
});

describe('all four KPI cards render, and each is registered kind:"kpi"', () => {
    it.each(['total', 'active', 'unscored', 'egress'] as const)(
        'the %s card renders its label and its SERVER count',
        (id) => {
            renderRegister();
            // The CARD, by its wrapper test-id — `id` lands on the value span
            // alone, so scoping to it would put the label out of reach and
            // make "the label renders" unassertable.
            const card = document.querySelector(`[data-testid="agents-kpi-card-${id}"]`);
            expect(card).not.toBeNull();
            const host = card as HTMLElement;
            expect(within(host).getByText(REGISTER.kpi[id])).toBeTruthy();
            // The number comes from `kpiCounts`, which disagrees with
            // `ROWS.length` by construction — see COUNTS. Read from the
            // value span the card's `id` names, so this is the number a
            // reader sees rather than any digit in the card.
            expect(document.getElementById(`agents-kpi-${id}`)?.textContent).toBe(
                String(COUNTS[id]),
            );
        },
    );

    it('the four ids are EXACTLY the four, in order', () => {
        renderRegister();
        const rendered = [...document.querySelectorAll('[id^="agents-kpi-"]')].map(
            (el) => el.id,
        );
        expect(rendered).toEqual([
            'agents-kpi-total',
            'agents-kpi-active',
            'agents-kpi-unscored',
            'agents-kpi-egress',
        ]);
    });

    it('every card is registered under the agents filter-vis key as kind:"kpi"', () => {
        // Read from the SOURCE, because the registration is invisible in the
        // DOM and is what decides whether the card survives somebody touching
        // the "edit cards" gear. A mixed registration renders identically today
        // and hides the new cards for every user who has ever persisted an
        // order (#1886).
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const { callExpressionOf } = require('../helpers/source-blocks') as {
            callExpressionOf: (src: string, name: string) => string;
        };
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)/agents/AgentsClient.tsx'),
            'utf8',
        );
        // BOUND to the hook call, not read over the whole file: a whole-file
        // read would let a `kind: 'kpi'` in a neighbouring block satisfy a
        // claim about this registration.
        const call = callExpressionOf(src, 'useFilterCardVisibility');
        expect(call).toContain("storageKey: 'inflect:filter-vis:agents'");

        // The four definitions, each with its own `kind: 'kpi'`. Counted, so a
        // card added without the discriminator fails rather than riding on its
        // neighbours' three.
        const defs = callExpressionOf(src, 'useMemo');
        void defs; // the definitions array is inline in the component body
        const kpiCards = src.slice(
            src.indexOf('const kpiCards'),
            src.indexOf('const { visibleCards'),
        );
        expect(kpiCards).not.toBe('');
        for (const id of ['total', 'active', 'unscored', 'egress']) {
            expect(kpiCards).toContain(`id: '${id}'`);
        }
        expect(kpiCards.match(/kind: 'kpi'/g)?.length).toBe(4);
        expect(kpiCards).not.toContain("kind: 'filter'");
    });
});

describe('the governance banner says the right sentence for each of the three states', () => {
    /** Rendered alone — the banner is the unit, and mounting the whole
     *  register three times to read one sentence is thirty seconds a state. */
    const bannerText = (governance: { enforcing: boolean; unboundCredentials: number }) => {
        const { container, unmount } = render(<GovernanceBanner governance={governance} />);
        const text = container.textContent ?? '';
        unmount();
        return text;
    };

    it('NOT ENFORCING — says the register decides nothing', () => {
        const text = bannerText({ enforcing: false, unboundCredentials: 0 });
        expect(text).toContain(REGISTER.governance.notEnforcing);
        // …and NOT either of the other two. A banner that concatenated them
        // would satisfy a `toContain` for the right one while also saying the
        // opposite.
        expect(text).not.toContain(REGISTER.governance.enforcing);
    });

    it('NOT ENFORCING wins even when credentials are unbound', () => {
        // Order matters: with the gate off, unbound credentials are refused by
        // nothing, so naming them would send an operator to fix a problem they
        // do not have.
        const text = bannerText({ enforcing: false, unboundCredentials: 5 });
        expect(text).toContain(REGISTER.governance.notEnforcing);
    });

    it('ENFORCING WITH UNBOUND CREDENTIALS — names the refusal and the fix', () => {
        const text = bannerText({ enforcing: true, unboundCredentials: 3 });
        // The sentence's TAIL, after the ICU plural the test mock does not
        // expand. It is the half that carries the instruction.
        expect(text).toContain('until you bind it to a registered agent');
        expect(text).not.toContain(REGISTER.governance.enforcing);
        expect(text).not.toContain(REGISTER.governance.notEnforcing);
    });

    it('ENFORCING — renders the all-clear sentence rather than nothing', () => {
        const text = bannerText({ enforcing: true, unboundCredentials: 0 });
        expect(text).toBe(REGISTER.governance.enforcing);
    });

    it('renders in ALL three states — none of them is silent', () => {
        // The paired assertion the three above cannot make individually: a
        // state that rendered null would pass its own `not.toContain` checks.
        for (const g of [
            { enforcing: false, unboundCredentials: 0 },
            { enforcing: true, unboundCredentials: 3 },
            { enforcing: true, unboundCredentials: 0 },
        ]) {
            expect(bannerText(g).trim().length).toBeGreaterThan(20);
        }
    });
});

describe('the primary action is a Plus glyph plus the bare noun', () => {
    it('renders the noun alone as its label', () => {
        renderRegister({ canWrite: true });
        const btn = document.getElementById('new-agent-btn');
        expect(btn).not.toBeNull();
        expect((btn as HTMLElement).textContent?.trim()).toBe(REGISTER.addAgent);
        // The catalogue value is the NOUN, not a verb phrase. Asserted on the
        // message rather than only on the render, because a verb added to the
        // string would render correctly and still be wrong.
        expect(REGISTER.addAgent).toBe('Agent');
        expect(REGISTER.addAgent).not.toMatch(/^(Add|New|Create)\b/);
    });

    it('carries an svg glyph, and no "+" in the label text', () => {
        renderRegister({ canWrite: true });
        const btn = document.getElementById('new-agent-btn') as HTMLElement;
        expect(btn.querySelector('svg')).not.toBeNull();
        expect(btn.textContent).not.toContain('+');
    });

    it('is absent without the write permission', () => {
        renderRegister({ canWrite: false });
        expect(document.getElementById('new-agent-btn')).toBeNull();
    });
});
