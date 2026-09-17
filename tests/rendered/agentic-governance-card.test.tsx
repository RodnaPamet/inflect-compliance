/**
 * THE DASHBOARD CARD SAYS WHAT IS IN THE REGISTER, AND SAYS NOTHING OVER AN
 * EMPTY ONE (#2560).
 *
 * The card shipped with six lines and none of them was a count of agents. It
 * also had no zero-agent gate: for a tenant that had never registered an
 * agent it still rendered, and the all-clear line told that tenant "every
 * active agent is scored, and registration is enforced" over nothing at all.
 *
 * Until this file the card, the usecase behind it and all eight
 * `agents.dashboardWidget.*` keys had NO rendered coverage of any kind.
 *
 * ── THE KEY-RESOLUTION ASSERTION, AND WHAT IT IS ACTUALLY FOR ───────────────
 *
 * next-intl renders a MISSING key as its own dotted path — no throw, no warn.
 * Two guards exist for that, and between them they leave exactly one hole,
 * which is the hole this card falls into:
 *
 *   · `tests/guards/i18n-keys-resolve.test.ts` walks ALL of `src` and checks
 *     every LITERAL `t('…')` in a single-namespace file. This card qualifies,
 *     so its literal keys — including the new `dashboardWidget.standing` —
 *     ARE covered there. (Measured, not assumed: misspelling that key in the
 *     card turns that guard red.)
 *   · `tests/guards/agents-copy-keys-resolve.test.ts` resolves interpolated
 *     keys at their PREFIX, which is what would cover the per-standing labels
 *     — but its population is `src/app/t/[tenantSlug]/(app)/agents`, and this
 *     card sits under `(app)/dashboard/`.
 *
 * So the INTERPOLATED lookup here —
 * `` t(`register.filterEnums.status.${standing}`) `` — is seen by neither: one
 * guard only reads literals, the other only reads a directory this file is not
 * in. That is the assertion below that earns its place; the `dashboardWidget.`
 * half is a belt beside a brace that already holds, and is kept only because
 * it costs one string comparison in a test that had to render the card anyway.
 *
 * ── WHY THE TRANSLATOR IS A RESOLVER AND NOT A STUB ─────────────────────────
 *
 * `getTranslations` is mocked against the REAL `messages/en.json` and returns
 * the dotted key when a lookup fails, exactly as next-intl does. A stub that
 * echoed its key would make every assertion below pass on a card whose every
 * label was a raw path — which is the defect, not the fixture.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { AgentStatus } from '@prisma/client';

jest.setTimeout(120_000);

/** The context read. Replaced per test, because the permission arm needs it. */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

/** The one data load. */
const summaryMock = jest.fn();
jest.mock('@/app-layer/usecases/agent-registry', () => ({
    __esModule: true,
    getAgenticDashboardSummary: (...a: unknown[]) => summaryMock(...a),
}));

/**
 * `next-intl/server` is ESM and has no manual mock (the repo's
 * `__mocks__/next-intl.js` covers the CLIENT entrypoint only). Resolved
 * against the real English catalogue with `{param}` substitution; a key that
 * does not resolve comes back as its own dotted path, which is the production
 * behaviour the last assertion in this file is about.
 */
jest.mock('next-intl/server', () => ({
    __esModule: true,
    getTranslations: async (namespace: string) => {
        const en = require('../../messages/en.json') as Record<string, unknown>;
        const walk = (bag: unknown, dotted: string): unknown =>
            dotted
                .split('.')
                .reduce<unknown>(
                    (o, k) =>
                        o && typeof o === 'object'
                            ? (o as Record<string, unknown>)[k]
                            : undefined,
                    bag,
                );
        const ns = walk(en, namespace);
        return (key: string, params?: Record<string, unknown>) => {
            const found = walk(ns, key);
            if (typeof found !== 'string') return key;
            let out = found;
            for (const [name, value] of Object.entries(params ?? {})) {
                out = out.split(`{${name}}`).join(String(value));
            }
            return out;
        };
    },
}));

import { AgenticGovernanceCardBody } from '@/app/t/[tenantSlug]/(app)/dashboard/AgenticGovernanceCard';

const EN = (
    require('../../messages/en.json') as {
        agents: {
            dashboardWidget: Record<string, string>;
            register: { filterEnums: { status: Record<string, string> } };
        };
    }
).agents;

type Summary = {
    enforcing: boolean;
    tenantKillInForce: boolean;
    agentsKilled: number;
    activeUnscored: number;
    proposalsAwaitingReview: number;
    totalRegistered: number;
    byStanding: Record<AgentStatus, number>;
};

/** Nothing stopped, nothing unscored, enforcing, no queue — the `clear` state. */
const QUIET = {
    enforcing: true,
    tenantKillInForce: false,
    agentsKilled: 0,
    activeUnscored: 0,
    proposalsAwaitingReview: 0,
} as const;

const standing = (
    draft: number,
    active: number,
    suspended: number,
    retired: number,
): Record<AgentStatus, number> => ({
    [AgentStatus.DRAFT]: draft,
    [AgentStatus.ACTIVE]: active,
    [AgentStatus.SUSPENDED]: suspended,
    [AgentStatus.RETIRED]: retired,
});

const summaryOf = (over: Partial<Summary> & Pick<Summary, 'byStanding'>): Summary => {
    const byStanding = over.byStanding;
    return {
        ...QUIET,
        totalRegistered: Object.values(byStanding).reduce((a, b) => a + b, 0),
        ...over,
    };
};

/** Render the server component the way Next does, and hand back the DOM. */
async function mount(
    summary: Summary,
    opts: { registerKey?: boolean } = {},
): Promise<HTMLElement | null> {
    getTenantCtxMock.mockResolvedValue({
        appPermissions: { admin: { agent_registry: opts.registerKey !== false } },
    });
    summaryMock.mockResolvedValue(summary);
    const element = await AgenticGovernanceCardBody({ tenantSlug: 'acme' });
    render(<>{element}</>);
    return screen.queryByTestId('agentic-governance-card');
}

afterEach(() => {
    getTenantCtxMock.mockReset();
    summaryMock.mockReset();
});

describe('the census line', () => {
    it('names every occupied standing, with its number, and suppresses the empty ones', async () => {
        const card = await mount(
            summaryOf({ byStanding: standing(1, 2, 4, 0) }),
        );
        expect(card).not.toBeNull();

        // The WHOLE sentence, composed the way the catalogue composes it —
        // not `toContain('2')`, which a card rendering any other number 2
        // would satisfy. RETIRED is absent because it is zero; the total is
        // 7 because the total counts what the sentence does not name.
        const expected = EN.dashboardWidget.standing
            .split('{total}')
            .join('7')
            .split('{breakdown}')
            .join(
                `${EN.register.filterEnums.status.DRAFT}: 1, ` +
                    `${EN.register.filterEnums.status.ACTIVE}: 2, ` +
                    `${EN.register.filterEnums.status.SUSPENDED}: 4`,
            );
        expect(screen.getByTestId('agentic-standing').textContent).toBe(expected);
    });

    it('renders even when every notice is suppressed', async () => {
        // The census is not a notice. A card that only spoke up when something
        // was wrong is the card that shipped, and it is why a fleet of twelve
        // suspended agents read the same as one healthy agent.
        const card = await mount(summaryOf({ byStanding: standing(0, 3, 0, 0) }));
        expect(card).not.toBeNull();
        expect(screen.getByTestId('agentic-clear')).toBeTruthy();
        expect(screen.getByTestId('agentic-standing').textContent).toBe(
            EN.dashboardWidget.standing
                .split('{total}')
                .join('3')
                .split('{breakdown}')
                .join(`${EN.register.filterEnums.status.ACTIVE}: 3`),
        );
    });

    it('sits ABOVE the notices — what is here, then what is wrong', async () => {
        await mount(
            summaryOf({
                byStanding: standing(0, 5, 2, 0),
                activeUnscored: 2,
                proposalsAwaitingReview: 1,
                tenantKillInForce: true,
            }),
        );
        const order = [
            'agentic-standing',
            'agentic-kill-tenant',
            'agentic-unscored-active',
            'agentic-proposals-waiting',
        ].map((id) => {
            const node = screen.getByTestId(id);
            // Index within the parent, resolved through the SAME element the
            // assertion names — a position read off a document-wide query
            // would move if an unrelated card were ever mounted beside this.
            return Array.from(node.parentElement?.children ?? []).indexOf(node);
        });
        expect(order).toStrictEqual([0, 1, 2, 3]);
    });
});

describe('a tenant with an empty register', () => {
    it('renders NOTHING — not an empty card, and not the all-clear line', async () => {
        const card = await mount(summaryOf({ byStanding: standing(0, 0, 0, 0) }));

        // Three ways of saying it, because "the card is absent" and "the card
        // is empty" are different defects and only one of them is fixed here.
        expect(card).toBeNull();
        expect(screen.queryByTestId('agentic-clear')).toBeNull();
        expect(document.body.textContent).toBe('');
    });

    it('still renders for a register holding exactly one agent', async () => {
        // The paired positive. Without it a gate written as `> 1`, or one that
        // returned null unconditionally, would satisfy every assertion above.
        const card = await mount(summaryOf({ byStanding: standing(0, 1, 0, 0) }));
        expect(card).not.toBeNull();
        expect(screen.getByTestId('agentic-standing').textContent).toBe(
            EN.dashboardWidget.standing
                .split('{total}')
                .join('1')
                .split('{breakdown}')
                .join(`${EN.register.filterEnums.status.ACTIVE}: 1`),
        );
    });
});

describe('the permission gate is unchanged (positive control)', () => {
    it('renders nothing for a caller without admin.agent_registry, and never loads', async () => {
        // Pre-existing behaviour, asserted here because this file adds a
        // SECOND early return above the render. A refactor that reordered the
        // two would leak aggregate counts to a reader who was refused the
        // register, and nothing else in the repo renders this card.
        const card = await mount(summaryOf({ byStanding: standing(1, 1, 1, 1) }), {
            registerKey: false,
        });
        expect(card).toBeNull();
        expect(summaryMock).not.toHaveBeenCalled();
    });
});

describe('no key renders as its own dotted path', () => {
    it('resolves the interpolated standing labels, which no guard in the repo covers', async () => {
        await mount(summaryOf({ byStanding: standing(1, 1, 1, 1) }));
        const rendered = screen.getByTestId('agentic-governance-card').textContent ?? '';

        // The interpolated lookup. `agents-copy-keys-resolve` would catch a
        // broken prefix here, but its population is the `(app)/agents` subtree
        // and this card is not in it; `i18n-keys-resolve` reads literals only.
        expect(rendered).not.toContain('register.filterEnums.status.');
        // The literal keys. Covered by `i18n-keys-resolve` as well; kept
        // because it is one comparison on text this test already has.
        expect(rendered).not.toContain('dashboardWidget.');
        // And the positive half: the resolver is working, so the two negatives
        // above mean "checked and found nothing" rather than "rendered blank".
        expect(rendered).toContain(EN.register.filterEnums.status.SUSPENDED);
        expect(rendered).toContain(EN.dashboardWidget.title);
    });
});
