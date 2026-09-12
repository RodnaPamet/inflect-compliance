/**
 * Render test for the AGENT REGISTER list (`AgentsClient`), Agent column.
 *
 * One claim, and it is about a sentence the surface could state that would be
 * false: **the register never says an agent is unowned.**
 *
 * `RegisteredAgent.ownerUserId` is NOT NULL behind a real FK — the schema calls
 * it "the accountable human" and the downstream two-person rule compares it —
 * while `User.name` is nullable. So the sub-line under an agent's name could
 * only ever fall through for an owner who IS on record and has no display name
 * set, and it rendered "Unassigned" at them. The register's whole job is to
 * answer "who is accountable for this agent", and it was answering "nobody"
 * about somebody the database is holding.
 *
 * The fix has two halves and both are asserted here, because either alone
 * leaves the column weaker than the data:
 *
 *   • the select carries `owner { id, name, email }`, so the fallback is an
 *     address a reader can act on rather than a phrase about a missing label;
 *   • the phrase that remains — for the case where the payload carries neither
 *     — denies the NAME, not the ownership, and is the same string the agent
 *     detail page uses so the two surfaces cannot drift apart.
 *
 * Every assertion reads the real `messages/en.json` value rather than a
 * dotted key path: next-intl renders a missing key as its own path, so an
 * assertion on the path passes only while the catalogue is incomplete and goes
 * red the moment the keys land.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

// Mounting the register mounts the table, the filter system and the create
// modal's form stack — a one-off module load that runs to tens of seconds on a
// loaded machine. Every assertion here is about WHAT renders, never how fast.
jest.setTimeout(180_000);

// next-intl is ESM (jest cannot parse it); mock it resolving real en.json
// values. `make` is MEMOISED per namespace — a fresh `t` identity on every
// render invalidates the `useMemo([t])` that builds the columns, which turns a
// render into a loop rather than a failure.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            // A dotted NAMESPACE ('common.filterGroups') is a path too — the
            // register opens two namespaces, and resolving only the first
            // segment would hand every group label back as its own key.
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

import { AgentsClient, type AgentRow } from '@/app/t/[tenantSlug]/(app)/agents/AgentsClient';

/**
 * The real catalogue values the column resolves against.
 *
 * TWO namespaces, and that split is the point this file's last assertion makes.
 * The register's own copy moved to `agents.register.*` when the page left
 * `/admin` (#2426); `admin.agentDetail.*` did not move with it. The Agent
 * column reaches ACROSS to the detail page's `ownerEmpty` key on purpose — one
 * key for one question, so the two surfaces cannot answer it differently again
 * (#2380) — and that cross-namespace reach is now visible here rather than
 * hidden inside one bag.
 */
const MESSAGES = require('../../messages/en.json') as {
    admin: { agentDetail: { overview: Record<string, string> } };
    agents: { register: Record<string, string> };
};
const DETAIL = MESSAGES.admin.agentDetail;
const REGISTER = MESSAGES.agents.register;

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

function renderRegister(rows: AgentRow[]) {
    return render(
        <AgentsClient
            initialRows={rows}
            tenantSlug="acme"
            owners={[{ id: 'user-1', label: 'Dana Iveagh' }]}
            vendors={[]}
            // The register's four numbers now come from the SERVER (#2432), so
            // the props are required rather than derived. Zeroes here: this
            // file is about ONE cell — the owner sub-line — and a KPI value
            // that agreed with `rows.length` would invite a reader to think
            // the cards are computed from the rows, which is the defect the
            // server counts exist to remove.
            kpiCounts={{ total: 0, active: 0, unscored: 0, egress: 0 }}
            governance={{ enforcing: true, unboundCredentials: 0 }}
            assurance={null}
            proposalsAwaitingReview={null}
            canWrite
            canReviewProposals
        />,
    );
}

/** The sub-line under one agent's name — the cell that answers "who owns it". */
function ownerLine(id: string): string {
    const cell = screen.getByTestId(`agent-row-${id}`);
    // The name sits in the first child div, the owner line in the second.
    const lines = within(cell).getAllByText(/.+/, { selector: 'div' });
    return (lines[lines.length - 1].textContent ?? '').trim();
}

describe('the register names whoever is accountable, and never says nobody is', () => {
    it('falls back to the owner EMAIL when the display name was never set', () => {
        renderRegister([
            makeRow({ id: 'named', name: 'Named owner', owner: { id: 'u1', name: 'Dana Iveagh', email: 'dana@acme.test' } }),
            makeRow({ id: 'nameless', name: 'Nameless owner', owner: { id: 'u2', name: null, email: 'ops@acme.test' } }),
        ]);

        // The positive companion first: the ordinary row still shows the NAME,
        // so the email below is a fallback rather than the column having been
        // switched over to addresses wholesale.
        expect(ownerLine('named')).toBe('Dana Iveagh');
        expect(ownerLine('nameless')).toBe('ops@acme.test');

        // The defect, by the exact string it wore. A LITERAL rather than the
        // catalogue key it came from: `agentRegistry.noOwner` is retired by
        // this change and the key can go, while the string must never come
        // back under any key — so the literal is the durable form of the
        // claim, and reading the key would make this test depend on a dead
        // entry staying in the catalogue.
        expect(ownerLine('nameless')).not.toBe('Unassigned');
    });

    it('denies the NAME, not the ownership, when the payload carries neither', () => {
        renderRegister([
            makeRow({ id: 'bare', name: 'Bare owner', owner: { id: 'u3', name: null, email: null } }),
        ]);

        // Read from the DETAIL page's catalogue entry, which is the very key
        // the column now calls: the two surfaces answer one question about one
        // agent, and #2380 was them answering it differently.
        expect(ownerLine('bare')).toBe(DETAIL.overview.ownerEmpty);
        expect(ownerLine('bare')).not.toBe('Unassigned');
        // And the phrase denies a label, never the accountability itself.
        expect(DETAIL.overview.ownerEmpty).toBe('Name not recorded');
    });

    it('a legacy placeholder still says what it is, rather than naming an owner', () => {
        // The one row that is NOT about accountability: the synthetic row the
        // registry migration creates to adopt pre-register activity. It has an
        // owner column value and must not use it — that branch sits above the
        // owner fallback chain and a refactor of the chain can swallow it.
        renderRegister([
            makeRow({
                id: 'placeholder',
                name: 'Pre-register activity',
                isLegacyPlaceholder: true,
                owner: { id: 'u4', name: 'Dana Iveagh', email: 'dana@acme.test' },
            }),
        ]);

        expect(ownerLine('placeholder')).toBe(REGISTER.legacyPlaceholder);
    });
});
