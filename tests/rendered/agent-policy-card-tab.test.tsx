/**
 * Rendered test for the agent detail page's POLICY CARD tab.
 *
 * The claim the whole file is built around: `GET /admin/agents/:id/policy-card`
 * answers with ONE OF TWO DISJOINT SHAPES, and a render that treats them as one
 * shape with optional fields makes a FALSE STATEMENT about a control.
 *
 *   • `{ card: null, wouldSeed, wouldWithhold, assessmentRequired }` — there is
 *     no card. `versions` is ABSENT, not empty.
 *   • `{ card: {…, inForce}, versions[], assessmentRequired: false }` — there is
 *     a card. `wouldSeed` / `wouldWithhold` are ABSENT.
 *
 * Read `versions` on the no-card branch and the page renders an empty trail,
 * which says "this card has no history" — a sentence about a card that does not
 * exist. Read `wouldWithhold` on the card branch and a live card grows a
 * withheld-grant disclosure describing a seed nobody wrote. Both blocks below
 * therefore pin the branch's own content AND the other branch's absence, and
 * every absence has a positive companion from the same render so that a
 * component rendering nothing at all cannot pass.
 *
 * ## The withheld preview is a ONE-SHOT disclosure
 *
 * `wouldWithhold` is only ever on the no-card payload. Once the card exists the
 * grant is still standing and still unexercisable, and nothing on this surface
 * says so again — so the seed preview is the single moment the operator is told
 * which grants the card will not carry and why. The remedy is asserted PER
 * REASON because the reasons do not share one: `NOT_IN_CATALOGUE` is a stale
 * grant left behind by a deploy and no ceiling raise ever permits it, so copy
 * that sends the operator up the ladder for it would widen a live agent's reach
 * over a tool that does not exist.
 *
 * ## `assessmentRequired` is a REFUSAL, not a warning
 *
 * An unscored agent seeds to `DENY_CEILING` autonomy and a zero budget on every
 * axis — a card the POST refuses to write (400 while `riskTier` is null). The
 * tab must therefore neither offer the button nor print the numbers: a preview
 * of zeroes reads as a deliberate lockdown rather than as an unassessed agent,
 * and a button that only ever 400s is read as a broken product rather than as
 * the rule it is. The fixture for that block is built by the REAL seeder, so
 * the numbers under test are the ones the route would actually send.
 *
 * ## Newest-first is load-bearing, not cosmetic
 *
 * Each row's delta is measured against the row BELOW it. Reverse the order and
 * every direction badge inverts — a narrowing reads as "Widened". The order is
 * pinned by the badges rather than only by the labels, so a reversed list fails
 * on what it SAYS about each version and not merely on where it sits.
 *
 * ## The ladder is enforced on the CONTROLS
 *
 * `checkLadderStep` is the final gate, but a control that always 400s is worse
 * than no control. So the editor offers at most one rung above the version in
 * force on each dimension (making `MULTI_RUNG_WIDEN` unreachable), closes every
 * other widening once one is spent (making `MULTI_DIMENSION_WIDEN`
 * unreachable), and never offers a tool the draft's own ceilings would refuse
 * on every call. The last block asserts both refusal sentences never render
 * while the widening that IS legal renders and saves.
 */
import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';

// next-intl is ESM (jest cannot parse it); mock it resolving real en.json
// values. `make` is MEMOISED per namespace — a fresh `t` identity on every
// render invalidates the `useMemo([t])` consumers, which turns a render into a
// loop rather than a failure.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
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

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/admin/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import { POLICY_CARD_RULES, type PolicyDataScope } from '@/lib/agentic/policy-card';
import {
    seedPolicyCardValue,
    withholdingReasonForTool,
    type ToolWithholdingReason,
    type WithheldTool,
} from '@/lib/agentic/policy-card-evaluation';

import { PolicyCardTab } from '@/app/t/[tenantSlug]/(app)/admin/agents/[agentId]/tabs/PolicyCardTab';

// ─── The copy under test, read from the catalogue the mock resolves ──

interface PolicyCardCopy {
    [key: string]: string | Record<string, string>;
}

const EN = (
    require('../../messages/en.json') as {
        admin: { agentDetail: { policyCard: PolicyCardCopy } };
    }
).admin.agentDetail.policyCard;

/**
 * One flat key of the catalogue.
 *
 * Throws rather than returning a fallback: a key that does not resolve renders
 * its own dotted path to the operator (that is what the mock and `next-intl`
 * both do), and a test that quietly compared "" to "" would pass while the
 * surface printed `agentDetail.policyCard.something` at them.
 */
const s = (key: string): string => {
    const value = EN[key];
    if (typeof value !== 'string') {
        throw new Error(`admin.agentDetail.policyCard.${key} does not resolve to a string`);
    }
    return value;
};

/**
 * One key of a NESTED group. These are the keys the component builds with a
 * template literal (`withheldReason.${reason}`), which no static extractor can
 * see — so this is the only place the union and the catalogue are compared.
 */
const nested = (group: string, key: string): string => {
    const bag = EN[group];
    if (typeof bag !== 'object' || bag === null || typeof bag[key] !== 'string') {
        throw new Error(`admin.agentDetail.policyCard.${group}.${key} does not resolve to a string`);
    }
    return bag[key];
};

/**
 * The leading, parameter-free run of a message — the part that renders
 * verbatim whatever the numbers are, so a negative assertion over it cannot
 * pass merely because a `{placeholder}` never appears in any DOM.
 */
const stem = (template: string): string => template.split('{')[0].trim();

/** Same substitution the next-intl mock performs, so expectations match. */
const interp = (template: string, params: Record<string, string | number>): string => {
    let out = template;
    for (const [k, v] of Object.entries(params)) {
        out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    }
    return out;
};

// ─── Fixtures ────────────────────────────────────────────────────────

/** One immutable version row, shaped as `VERSION_SELECT` selects it. */
interface VersionRow {
    id: string;
    version: number;
    permittedTools: string[];
    maxDataScope: PolicyDataScope;
    maxAutonomyLevel: number;
    maxActionsPerRun: number;
    maxActionsPerDay: number;
    escalationTriggers: string[];
    approvalRung: string;
    seeded: boolean;
    seededFromTier: string | null;
    createdByUserId: string | null;
    createdAt: string;
}

/**
 * v1 → v2 → v3, chosen so consecutive rows move in OPPOSITE directions: v2
 * widens (one tool added), v3 narrows (a budget rung down). A history rendered
 * oldest-first swaps the two badges, which is the failure the order test is
 * for.
 */
const V1: VersionRow = {
    id: 'ver-1',
    version: 1,
    permittedTools: [],
    maxDataScope: 'READ_TENANT_DATA',
    maxAutonomyLevel: 2,
    maxActionsPerRun: 10,
    maxActionsPerDay: 50,
    escalationTriggers: [...POLICY_CARD_RULES],
    approvalRung: 'SECOND_APPROVER',
    seeded: true,
    seededFromTier: 'MODERATE',
    createdByUserId: null,
    createdAt: '2026-09-01T10:00:00.000Z',
};

const V2: VersionRow = {
    ...V1,
    id: 'ver-2',
    version: 2,
    permittedTools: ['list_risks'],
    seeded: false,
    seededFromTier: null,
    createdByUserId: 'user-1',
    createdAt: '2026-09-02T11:30:00.000Z',
};

const V3: VersionRow = {
    ...V2,
    id: 'ver-3',
    version: 3,
    maxActionsPerDay: 25,
    createdAt: '2026-09-03T12:45:00.000Z',
};

function cardPayload(overrides: { versions?: VersionRow[]; head?: Partial<Record<string, unknown>> } = {}) {
    const versions = overrides.versions ?? [V3, V2, V1];
    return {
        agentId: 'agent-1',
        card: {
            id: 'card-1',
            agentId: 'agent-1',
            currentVersion: 3,
            usageWindowDate: '2026-09-08',
            actionsInWindow: 7,
            createdAt: '2026-09-01T10:00:00.000Z',
            updatedAt: '2026-09-03T12:45:00.000Z',
            inForce: versions.find((v) => v.version === 3) ?? null,
            ...overrides.head,
        },
        versions,
        assessmentRequired: false as const,
    };
}

/**
 * The no-card payload, built by the REAL seeder rather than by hand, so what
 * the preview is asserted to show is exactly what the POST would write.
 *
 * The grants are chosen to produce all three withholding reasons at once:
 * CRITICAL caps autonomy at 1 (so a `propose` tool is above the card), the
 * agent is registered at `READ_METADATA` (so a tool whose BASE rung is tenant
 * data is above the card), and one grant names a tool this build never shipped.
 * `get_framework_status` survives, so the preview is not an empty panel.
 */
const SCORED_SEED = seedPolicyCardValue({
    riskTier: 'CRITICAL',
    dataAccessScope: 'READ_METADATA',
    grantedTools: ['get_framework_status', 'list_risks', 'propose_risks', 'export_audit_pack'],
});

/** An UNSCORED agent: deny ceiling, zero budgets, nothing seedable. */
const UNSCORED_SEED = seedPolicyCardValue({
    riskTier: null,
    dataAccessScope: 'READ_TENANT_DATA',
    grantedTools: ['list_risks', 'propose_risks'],
});

function noCardPayload(seed = SCORED_SEED, assessmentRequired = false) {
    return {
        agentId: 'agent-1',
        card: null,
        wouldSeed: seed.value,
        wouldWithhold: seed.withheld,
        assessmentRequired,
    };
}

function renderTab(data: unknown, canEditPolicyCard = true) {
    mockSWR.mockReturnValue({ data, error: undefined, isLoading: false, mutate: jest.fn() });
    return render(
        <PolicyCardTab tenantSlug="acme" agentId="agent-1" canEditPolicyCard={canEditPolicyCard} />,
    );
}

// ─── DOM handles ─────────────────────────────────────────────────────

/** The `<dd>` next to the `<dt>` carrying `label`, inside one panel. */
function declaration(scope: HTMLElement, label: string): string {
    const term = within(scope).getByText(label);
    return term.nextElementSibling?.textContent ?? '';
}

/** The panel holding the card in force — scoped so the trail's copies do not match. */
function inForcePanel(): HTMLElement {
    const panel = screen.getByRole('heading', { name: s('heading') }).closest('.glass-card');
    if (!(panel instanceof HTMLElement)) throw new Error('the in-force panel is not rendered');
    return panel;
}

/** One version row of the trail, by its own label. */
function versionRow(label: string): HTMLElement {
    const row = screen.getByText(label).closest('li');
    if (!(row instanceof HTMLElement)) throw new Error(`no version row for ${label}`);
    return row;
}

/** The `<li>` of the withheld list naming this tool. */
function withheldRow(toolName: string): HTMLElement {
    const row = screen.getByText(toolName).closest('li');
    if (!(row instanceof HTMLElement)) throw new Error(`no withheld row for ${toolName}`);
    return row;
}

/** Every rung a ladder actually OFFERS, in order, with its enabled state. */
function rungs(groupId: string): { value: string; disabled: boolean }[] {
    const group = document.getElementById(groupId);
    if (!group) throw new Error(`radio group ${groupId} is not rendered`);
    return Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]')).map((el) => ({
        value: el.getAttribute('value') ?? '',
        disabled: el.disabled,
    }));
}

const offered = (groupId: string): string[] => rungs(groupId).map((r) => r.value);

function pickRung(groupId: string, value: string): void {
    const rung = document.querySelector<HTMLButtonElement>(`#${groupId} [value="${value}"]`);
    if (!rung) throw new Error(`${groupId} does not offer rung ${value}`);
    fireEvent.click(rung);
}

function box(id: string): HTMLButtonElement {
    const el = document.getElementById(id);
    if (!(el instanceof HTMLButtonElement)) throw new Error(`checkbox ${id} is not rendered`);
    return el;
}

const openEditor = () => fireEvent.click(box('agent-policy-card-edit-btn'));

beforeEach(() => {
    jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────

describe('the two disjoint payload shapes', () => {
    it('the no-card payload renders the seed panel and NOTHING that implies a card', () => {
        const payload = noCardPayload();
        // The shape itself: `versions` is absent, so any history the tab
        // rendered here would be a claim about a card that does not exist.
        expect(Object.keys(payload)).not.toContain('versions');

        renderTab(payload);

        expect(screen.getByText(s('seedHeading'))).toBeInTheDocument();
        expect(screen.getByText(s('seedIntro'))).toBeInTheDocument();
        expect(screen.getByText(s('previewHeading'))).toBeInTheDocument();
        expect(document.getElementById('agent-policy-card-seed-btn')).not.toBeNull();

        // The absences the positives above make real.
        expect(screen.queryByText(s('heading'))).not.toBeInTheDocument();
        expect(screen.queryByText(s('historyHeading'))).not.toBeInTheDocument();
        expect(screen.queryByText(s('noVersions'))).not.toBeInTheDocument();
        expect(document.getElementById('agent-policy-card-edit-btn')).toBeNull();
    });

    it('the seed preview shows the value the POST would write, field by field', () => {
        renderTab(noCardPayload());
        const preview = screen.getByText(s('previewHeading')).closest('.glass-card') as HTMLElement;
        const seeded = SCORED_SEED.value;

        expect(declaration(preview, s('fieldTools'))).toBe(seeded.permittedTools.join(', '));
        expect(declaration(preview, s('fieldDataScope'))).toBe(seeded.maxDataScope);
        expect(declaration(preview, s('fieldAutonomy'))).toBe(
            interp(s('autonomyValue'), { level: seeded.maxAutonomyLevel }),
        );
        expect(declaration(preview, s('fieldPerRun'))).toBe(String(seeded.maxActionsPerRun));
        expect(declaration(preview, s('fieldPerDay'))).toBe(String(seeded.maxActionsPerDay));
        expect(declaration(preview, s('fieldApproval'))).toBe(seeded.approvalRung);
        expect(declaration(preview, s('fieldTriggers'))).toBe(
            seeded.escalationTriggers.join(', '),
        );
    });

    it('the card payload renders the card in force and its trail, and no seed panel', () => {
        const payload = cardPayload();
        // The other half of the discrimination: no `wouldSeed` to preview and
        // no `wouldWithhold` to disclose.
        expect(Object.keys(payload)).not.toContain('wouldSeed');
        expect(Object.keys(payload)).not.toContain('wouldWithhold');

        renderTab(payload);

        expect(screen.getByText(s('heading'))).toBeInTheDocument();
        expect(screen.getByText(interp(s('versionBadge'), { version: 3 }))).toBeInTheDocument();
        expect(screen.getByText(s('historyHeading'))).toBeInTheDocument();
        expect(document.getElementById('agent-policy-card-edit-btn')).not.toBeNull();

        expect(screen.queryByText(s('seedHeading'))).not.toBeInTheDocument();
        expect(screen.queryByText(s('previewHeading'))).not.toBeInTheDocument();
        expect(screen.queryByText(s('assessmentTitle'))).not.toBeInTheDocument();
        expect(document.getElementById('agent-policy-card-seed-btn')).toBeNull();
    });

    it('the head carries facts no version row has, and an unstarted counter is not a zero', () => {
        renderTab(cardPayload());
        const panel = inForcePanel();

        // `usageWindowDate` + `actionsInWindow` live on the HEAD. The version
        // rows below carry neither, so reading this off a version would print
        // nothing here.
        expect(declaration(panel, s('fieldUsage'))).toBe(
            interp(s('usageCount'), { count: 7, date: '08 Sept 2026' }),
        );
        expect(declaration(panel, s('fieldCreated'))).toBe('01 Sept 2026, 10:00');
        expect(declaration(panel, s('fieldUpdated'))).toBe('03 Sept 2026, 12:45');
        // The declarations shown are the version IN FORCE (v3, perDay 25), not
        // v1's 50 — the head names a version number, and this is where that
        // number is dereferenced.
        expect(declaration(panel, s('fieldPerDay'))).toBe('25');
    });

    it('a counter that has never started says so rather than counting zero', () => {
        const { unmount } = renderTab(
            cardPayload({ head: { usageWindowDate: null, actionsInWindow: 0 } }),
        );
        expect(declaration(inForcePanel(), s('fieldUsage'))).toBe(s('usageNotStarted'));
        // The positive companion: the same panel rendered its other head facts,
        // so the absence of a "0 counted on …" string is not a blank render.
        expect(declaration(inForcePanel(), s('fieldCreated'))).toBe('01 Sept 2026, 10:00');
        unmount();
    });
});

describe('the withheld preview — the one chance the operator gets', () => {
    it('the fixture is the real predicate, and it produces all three reasons', () => {
        // Not a restatement: the reasons are what the block below asserts copy
        // for, and a fixture typed by hand could disagree with the function the
        // boundary actually throws on.
        const byName = new Map(SCORED_SEED.withheld.map((w) => [w.toolName, w]));
        expect(byName.get('export_audit_pack')?.reason).toBe('NOT_IN_CATALOGUE');
        expect(byName.get('propose_risks')?.reason).toBe('AUTONOMY_ABOVE_CARD');
        expect(byName.get('list_risks')?.reason).toBe('DATA_SCOPE_ABOVE_CARD');
        for (const withheld of SCORED_SEED.withheld) {
            expect(withholdingReasonForTool(withheld.toolName, SCORED_SEED.value)).toEqual(
                withheld,
            );
        }
    });

    it('names every withheld tool, why it is withheld, and what would settle it', () => {
        renderTab(noCardPayload());

        expect(screen.getByText(s('withheldIntro'))).toBeInTheDocument();

        for (const tool of SCORED_SEED.withheld as WithheldTool[]) {
            const row = withheldRow(tool.toolName);
            const reason = interp(nested('withheldReason', tool.reason), {
                requires: tool.requires,
                permits: tool.permits,
            });
            const remedy = interp(nested('withheldRemedy', tool.reason), {
                requires: tool.requires,
            });
            expect(row).toHaveTextContent(reason);
            expect(row).toHaveTextContent(remedy);
            // Proves the needle the one-shot test below searches for HAS
            // reach: the same `stem` query finds this sentence when it is on
            // screen, so its absence there is a fact rather than a needle that
            // never matches anything.
            expect(
                screen.getAllByText(stem(nested('withheldReason', tool.reason)), {
                    exact: false,
                }).length,
            ).toBeGreaterThan(0);
        }

        // The two ceiling reasons state BOTH numbers — a refusal that does not
        // say what the card permits leaves the operator guessing at the gap.
        expect(withheldRow('propose_risks')).toHaveTextContent(
            interp(nested('withheldReason', 'AUTONOMY_ABOVE_CARD'), { requires: 2, permits: 1 }),
        );
        expect(withheldRow('list_risks')).toHaveTextContent(
            interp(nested('withheldReason', 'DATA_SCOPE_ABOVE_CARD'), {
                requires: 'READ_TENANT_DATA',
                permits: 'READ_METADATA',
            }),
        );
    });

    it('a tool this build does not carry gets a REVOCATION, never a ladder answer', () => {
        renderTab(noCardPayload());

        const stale = withheldRow('export_audit_pack');
        // Positive companion: the row rendered its own remedy…
        expect(stale).toHaveTextContent(nested('withheldRemedy', 'NOT_IN_CATALOGUE'));
        // …and that remedy is not the one that sends somebody up the ladder.
        // The retired copy told the operator to widen an agent's reach over a
        // grant a deploy had left behind.
        expect(stale.textContent ?? '').not.toMatch(/becomes exercisable/i);
        expect(nested('withheldRemedy', 'NOT_IN_CATALOGUE')).not.toMatch(/becomes exercisable/i);
        // The rows that DO have a ladder answer still carry it, so the absence
        // above is per-reason rather than a missing remedy everywhere.
        expect(withheldRow('propose_risks').textContent ?? '').toMatch(/becomes exercisable/i);
    });

    it('says nothing about withheld grants once the card exists — the disclosure is one-shot', () => {
        renderTab(cardPayload());

        // Positive companion first: the card branch demonstrably rendered.
        expect(screen.getByText(s('heading'))).toBeInTheDocument();
        expect(screen.getByText(s('historyHeading'))).toBeInTheDocument();

        expect(screen.queryByText(s('withheldIntro'))).not.toBeInTheDocument();
        for (const reason of Object.keys(EN.withheldReason as Record<string, string>)) {
            expect(
                screen.queryByText(stem(nested('withheldReason', reason)), { exact: false }),
            ).not.toBeInTheDocument();
        }
    });
});

describe('an unscored agent cannot be seeded, and is told why', () => {
    it('offers no create control and prints none of the deny-ceiling numbers', () => {
        renderTab(noCardPayload(UNSCORED_SEED, true));

        // What it DOES say.
        expect(screen.getByText(s('seedHeading'))).toBeInTheDocument();
        expect(screen.getByText(s('assessmentTitle'))).toBeInTheDocument();
        expect(screen.getByText(s('assessmentBody'))).toBeInTheDocument();

        // The button is not merely disabled — it is not offered. The POST 400s
        // while `riskTier` is null, and a control that only ever refuses is
        // read as a bug in the product.
        expect(document.getElementById('agent-policy-card-seed-btn')).toBeNull();
        expect(
            screen.queryByRole('button', { name: s('seedAction') }),
        ).not.toBeInTheDocument();

        // And the preview is withheld with it. These are the real seeded
        // numbers for an unscored agent — a deny ceiling below rung 0 and a
        // zero budget on every axis — and printed they read as a deliberate
        // lockdown rather than as an agent nobody has assessed.
        expect(UNSCORED_SEED.value.maxAutonomyLevel).toBe(-1);
        expect(UNSCORED_SEED.value.maxActionsPerRun).toBe(0);
        expect(UNSCORED_SEED.value.maxActionsPerDay).toBe(0);
        expect(screen.queryByText(s('previewHeading'))).not.toBeInTheDocument();
        expect(
            screen.queryByText(interp(s('autonomyValue'), { level: -1 })),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(s('noToolsPermitted'))).not.toBeInTheDocument();
        // Every grant would be withheld, and listing them here would be a list
        // about a card that cannot be written.
        expect(UNSCORED_SEED.withheld.length).toBeGreaterThan(0);
        expect(screen.queryByText(s('withheldIntro'))).not.toBeInTheDocument();
    });

    it('a SCORED agent gets the button and the confirmation that says what v1 means', () => {
        // The pair: same branch, same panel, one flag apart. Without this the
        // test above would pass on a seed panel that never offers the button.
        renderTab(noCardPayload());

        expect(screen.queryByText(s('assessmentTitle'))).not.toBeInTheDocument();
        fireEvent.click(box('agent-policy-card-seed-btn'));

        // `Modal` renders its title twice — once visually hidden as
        // `Dialog.Title` for screen readers, once in the visible header — so
        // the count is asserted rather than the singleton.
        expect(screen.getAllByText(s('seedConfirmTitle')).length).toBeGreaterThan(0);
        expect(screen.getAllByText(s('seedConfirmBody')).length).toBeGreaterThan(0);
        // The confirmation names what version 1 IS, because there is no delete:
        // the dialog is the last place that can say so.
        expect(s('seedConfirmBody')).toMatch(/no delete/i);
        expect(
            screen.getByRole('button', { name: s('seedAction') }),
        ).toBeInTheDocument();
    });
});

describe('the version history reads newest first', () => {
    it('lists the versions newest first and measures each against the row below it', () => {
        renderTab(cardPayload());

        expect(screen.getAllByText(/^v\d+$/).map((el) => el.textContent)).toEqual([
            'v3',
            'v2',
            'v1',
        ]);

        // The badges are what makes the order load-bearing: v2 ADDED a tool and
        // v3 dropped a budget rung, so an oldest-first render swaps these two.
        const newest = versionRow('v3');
        expect(within(newest).getByText(s('narrowedBadge'))).toBeInTheDocument();
        expect(within(newest).getByText(s('inForceBadge'))).toBeInTheDocument();
        expect(newest).toHaveTextContent(s('fieldPerDay'));
        expect(newest).toHaveTextContent(interp(s('changeMoved'), { from: 50, to: 25 }));
        expect(within(newest).queryByText(s('widenedBadge'))).not.toBeInTheDocument();

        const middle = versionRow('v2');
        expect(within(middle).getByText(s('widenedBadge'))).toBeInTheDocument();
        expect(middle).toHaveTextContent(interp(s('changeToolsAdded'), { tools: 'list_risks' }));
        expect(within(middle).queryByText(s('narrowedBadge'))).not.toBeInTheDocument();
        expect(within(middle).queryByText(s('inForceBadge'))).not.toBeInTheDocument();

        // The origin has nothing below it, so it shows what it DECLARES rather
        // than a comparison it cannot make, and carries no direction badge.
        const oldest = versionRow('v1');
        expect(within(oldest).getByText(interp(s('seededFromBadge'), { tier: 'MODERATE' })))
            .toBeInTheDocument();
        expect(declaration(oldest, s('fieldTools'))).toBe(s('noToolsPermitted'));
        expect(declaration(oldest, s('fieldPerDay'))).toBe('50');
        expect(within(oldest).queryByText(s('widenedBadge'))).not.toBeInTheDocument();
        expect(within(oldest).queryByText(s('narrowedBadge'))).not.toBeInTheDocument();
        expect(within(oldest).queryByText(s('unchangedBadge'))).not.toBeInTheDocument();

        // A trail that reaches v1 is COMPLETE, so it must not warn about a cap.
        expect(screen.queryByText(interp(s('historyCapped'), { count: 200 })))
            .not.toBeInTheDocument();
        expect(screen.queryByText(s('historyWindowEdge'))).not.toBeInTheDocument();
    });

    it('a trail whose oldest listed row is not v1 says the window cut it', () => {
        renderTab(cardPayload({ versions: [V3, V2] }));

        // Positive companion: the same two rows rendered, newest first.
        expect(screen.getAllByText(/^v\d+$/).map((el) => el.textContent)).toEqual(['v3', 'v2']);
        expect(within(versionRow('v3')).getByText(s('narrowedBadge'))).toBeInTheDocument();

        expect(screen.getByText(interp(s('historyCapped'), { count: 200 }))).toBeInTheDocument();
        const edge = versionRow('v2');
        expect(within(edge).getByText(s('historyWindowEdge'))).toBeInTheDocument();
        // It shows its declarations, and NO direction badge: "no change" and
        // "the row it moved from is outside the window" are different facts and
        // the badge can only honestly say the first.
        expect(declaration(edge, s('fieldPerDay'))).toBe('50');
        expect(within(edge).queryByText(s('widenedBadge'))).not.toBeInTheDocument();
        expect(within(edge).queryByText(s('unchangedBadge'))).not.toBeInTheDocument();
    });
});

describe('the one-rung rule is enforced on the controls, not only at the save', () => {
    it('offers at most ONE rung above the version in force on every dimension', () => {
        renderTab(cardPayload());
        openEditor();

        expect(screen.getByText(interp(s('basedOn'), { version: 3 }))).toBeInTheDocument();

        // v3 sits at READ_TENANT_DATA / L2 / 10 per run / 25 per day /
        // SECOND_APPROVER. Every rung at or below is offered — narrowing is
        // never refused — plus exactly one above. The rung TWO above is not a
        // disabled control, it is not rendered: `MULTI_RUNG_WIDEN` is
        // unreachable from this form.
        expect(offered('agent-policy-card-data-scope')).toEqual([
            'NONE',
            'READ_METADATA',
            'READ_TENANT_DATA',
            'WRITE_TENANT_DATA',
        ]);
        expect(offered('agent-policy-card-autonomy')).toEqual(['0', '1', '2', '3']);
        expect(offered('agent-policy-card-per-run')).toEqual(['0', '1', '5', '10', '25']);
        expect(offered('agent-policy-card-per-day')).toEqual(['0', '1', '5', '10', '25', '50']);
        expect(offered('agent-policy-card-approval')).toEqual([
            'SECOND_APPROVER',
            'SINGLE_APPROVER',
        ]);

        // Nothing is spent yet, so every offered rung is live.
        for (const group of [
            'agent-policy-card-data-scope',
            'agent-policy-card-autonomy',
            'agent-policy-card-approval',
        ]) {
            expect(rungs(group).filter((r) => r.disabled)).toEqual([]);
        }

        // The form also says out loud what it CANNOT pre-empt — the tier's
        // autonomy cap and the agent's registered data scope are not on this
        // payload, so those refusals arrive as 400s. A control that refuses
        // without warning is read as a bug; one that warned is read as a rule.
        expect(screen.getByText(s('ceilingsElsewhereHint'))).toBeInTheDocument();

        // An edit that moves nothing cannot be saved, and says so.
        expect(screen.getByText(s('unchangedHint'))).toBeInTheDocument();
        expect(box('agent-policy-card-save-btn')).toBeDisabled();
        expect(box('agent-policy-card-save-btn')).toHaveTextContent(
            interp(s('saveAction'), { version: 4 }),
        );
    });

    it('spending the widening on one dimension closes every other widening', () => {
        renderTab(cardPayload());
        openEditor();

        // Before: dropping a declared escalation trigger is a widening this
        // edit has not spent, so it is available.
        expect(box(`agent-policy-card-trigger-${POLICY_CARD_RULES[0]}`)).toBeEnabled();
        expect(box('agent-policy-card-tool-list_controls')).toBeEnabled();

        pickRung('agent-policy-card-autonomy', '3');

        expect(
            screen.getByText(interp(s('widenSpent'), { dimension: s('fieldAutonomy') })),
        ).toBeInTheDocument();

        // The rung above base on every OTHER ladder is now closed, while every
        // rung at or below stays open — narrowing is never rationed.
        const scope = rungs('agent-policy-card-data-scope');
        expect(scope.filter((r) => r.disabled).map((r) => r.value)).toEqual([
            'WRITE_TENANT_DATA',
        ]);
        expect(scope.filter((r) => !r.disabled).map((r) => r.value)).toEqual([
            'NONE',
            'READ_METADATA',
            'READ_TENANT_DATA',
        ]);
        expect(
            rungs('agent-policy-card-approval').filter((r) => r.disabled).map((r) => r.value),
        ).toEqual(['SINGLE_APPROVER']);

        // The set dimensions close the same way: adding a tool and dropping a
        // declared trigger are both widenings, and this edit has spent its one.
        expect(box('agent-policy-card-tool-list_controls')).toBeDisabled();
        expect(box(`agent-policy-card-trigger-${POLICY_CARD_RULES[0]}`)).toBeDisabled();
        // …but taking the already-permitted tool away is still free.
        expect(box('agent-policy-card-tool-list_risks')).toBeEnabled();

        // The legal edit is saveable, and NEITHER refusal sentence is on screen
        // — the controls made both states unreachable rather than reporting
        // them after the fact.
        expect(box('agent-policy-card-save-btn')).toBeEnabled();
        expect(screen.queryByText(s('unchangedHint'))).not.toBeInTheDocument();
        expect(
            screen.queryByText(nested('ladderRefusal', 'MULTI_DIMENSION_WIDEN')),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByText(nested('ladderRefusal', 'MULTI_RUNG_WIDEN')),
        ).not.toBeInTheDocument();
        // And the ladder never grows a second rung under the operator: the
        // offer is measured from the pinned base, not from the draft.
        expect(offered('agent-policy-card-autonomy')).toEqual(['0', '1', '2', '3']);
    });

    it("never offers a tool the draft's own ceilings would refuse on every call", () => {
        renderTab(cardPayload());
        openEditor();

        // v3 stops at READ_TENANT_DATA, and every propose tool reaches
        // WRITE_TENANT_DATA on every call. Permitting one writes a card that
        // refuses what it declares — `assertDeclarationsExercisable` rejects
        // the whole card by name — so it is offered to nobody, before any
        // widening has been spent.
        expect(withholdingReasonForTool('propose_risks', V3)?.reason).toBe(
            'DATA_SCOPE_ABOVE_CARD',
        );
        expect(box('agent-policy-card-tool-propose_risks')).toBeDisabled();
        // The positive companion, from the same catalogue render: a reachable
        // tool is offered, so the disabling is per-tool and not a dead form.
        expect(withholdingReasonForTool('list_controls', V3)).toBeNull();
        expect(box('agent-policy-card-tool-list_controls')).toBeEnabled();
        expect(box('agent-policy-card-tool-list_risks')).toBeChecked();
    });
});

describe('the read is gated too', () => {
    it('does not fetch at all without the permission — a denial row per page view is noise', () => {
        renderTab(cardPayload(), false);

        // `useTenantSWR(null)` skips the request entirely. The route rule
        // carries no `methods` restriction, so fetching would only mint a
        // hash-chained AUTHZ_DENIED row in the one log an investigation reads.
        expect(mockSWR).toHaveBeenCalled();
        expect(mockSWR.mock.calls[0][0]).toBeNull();

        expect(screen.getByText(s('forbiddenTitle'))).toBeInTheDocument();
        expect(screen.getByText(s('forbiddenDescription'))).toBeInTheDocument();
        expect(screen.queryByText(s('heading'))).not.toBeInTheDocument();
    });

    it('fetches the agent-scoped path when the flag is held', () => {
        renderTab(cardPayload(), true);
        expect(mockSWR.mock.calls[0][0]).toBe('/admin/agents/agent-1/policy-card');
    });
});

/**
 * The dynamic key families, compared against the catalogue directly.
 *
 * `withheldReason.${reason}` and `ladderRefusal.${refusal.reason}` are built
 * with template literals, so no static extractor sees them and no render
 * reaches all of them at once. A member added to either union without copy
 * prints its own dotted path at the operator at the exact moment the refusal
 * matters. The maps are exhaustive by TYPE, so adding a member fails to compile
 * here rather than surfacing as a key in production.
 */
describe('every reason a refusal can carry has copy', () => {
    it('resolves both sentences for every tool-withholding reason', () => {
        const reasons: Record<ToolWithholdingReason, true> = {
            NOT_IN_CATALOGUE: true,
            AUTONOMY_ABOVE_CARD: true,
            DATA_SCOPE_ABOVE_CARD: true,
        };
        for (const reason of Object.keys(reasons)) {
            expect(nested('withheldReason', reason)).not.toHaveLength(0);
            expect(nested('withheldRemedy', reason)).not.toHaveLength(0);
        }
    });

    it('resolves a sentence for every ladder refusal', () => {
        for (const reason of ['MULTI_DIMENSION_WIDEN', 'MULTI_RUNG_WIDEN']) {
            expect(nested('ladderRefusal', reason)).not.toHaveLength(0);
        }
    });
});
