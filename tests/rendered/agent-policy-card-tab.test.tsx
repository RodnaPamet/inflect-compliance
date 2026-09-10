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
 * ## The withheld disclosure is made for as long as it is TRUE
 *
 * It used to be one-shot: `wouldWithhold` is only on the no-card payload, so
 * once the card existed the grant went on standing and going on being refused
 * on every call with nothing on this surface saying so again. The card branch
 * now carries `withheld` — the same shape, evaluated by the server against the
 * version in force — and the two are asserted as a PAIR below: present when
 * there are withheld grants, absent when there are none, because a panel
 * announcing "0 tools are withheld" on every healthy agent is noise and an
 * empty list on the unreadable-head branch would be a false claim.
 *
 * The remedy is asserted PER REASON because the reasons do not share one:
 * `NOT_IN_CATALOGUE` is a stale grant left behind by a deploy and no ceiling
 * raise ever permits it, so copy that sends the operator up the ladder for it
 * would widen a live agent's reach over a tool that does not exist.
 *
 * ## The two ceilings set ELSEWHERE are pre-empted on the controls
 *
 * `riskTier` and `dataAccessScope` are on both payload branches, so the editor
 * caps its autonomy and data ladders at what the PUT would accept instead of
 * offering a rung whose refusal is an English sentence rendered verbatim into a
 * Bulgarian UI. The cap never removes a rung the card already holds: a card
 * above the tier cap is reached by a re-assessment, and hiding those rungs
 * would hide the operator's own declaration and the narrowing that repairs it.
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

import { ceilingForRiskTier } from '@/lib/agentic/autonomy-ceiling';
import {
    POLICY_CARD_RULES,
    dataScopeWithinCard,
    type PolicyDataScope,
} from '@/lib/agentic/policy-card';
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
    createdByName: string | null;
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
    // The seeding version nobody signed — `createdByUserId` is null on it, so
    // there is no actor to name and the row must say nothing rather than
    // inventing one. Its pair is V2 below.
    createdByUserId: null,
    createdByName: null,
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
    // Resolved server-side. The cuid above is deliberately still on the row and
    // deliberately never rendered — a raw id on a compliance surface is noise.
    createdByName: 'Ada Lovelace',
    createdAt: '2026-09-02T11:30:00.000Z',
};

const V3: VersionRow = {
    ...V2,
    id: 'ver-3',
    version: 3,
    maxActionsPerDay: 25,
    createdAt: '2026-09-03T12:45:00.000Z',
};

/**
 * The card branch.
 *
 * The default tier and declared scope are the ones that leave v3 exactly one
 * rung of room on both capped ladders (MODERATE caps autonomy at 3, v3 sits at
 * 2; the register declares WRITE_TENANT_DATA, v3 sits at READ_TENANT_DATA), so
 * the one-rung block below measures the ladder rule and not a ceiling. The
 * blocks that measure the ceilings override them.
 */
function cardPayload(
    overrides: {
        versions?: VersionRow[];
        head?: Partial<Record<string, unknown>>;
        riskTier?: string | null;
        dataAccessScope?: PolicyDataScope;
        withheld?: WithheldTool[] | null;
    } = {},
) {
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
        riskTier: overrides.riskTier === undefined ? 'MODERATE' : overrides.riskTier,
        dataAccessScope: overrides.dataAccessScope ?? ('WRITE_TENANT_DATA' as PolicyDataScope),
        versions,
        withheld: overrides.withheld === undefined ? [] : overrides.withheld,
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

/**
 * Granted tools the card IN FORCE refuses, built by the real predicate against
 * v3 rather than typed by hand — the server evaluates the same function, so a
 * hand-written fixture could describe a disclosure the product cannot produce.
 * Two different reasons, because the remedy is per reason.
 */
const STANDING_WITHHELD: WithheldTool[] = ['propose_risks', 'export_audit_pack']
    .map((tool) => withholdingReasonForTool(tool, V3))
    .filter((withheld): withheld is WithheldTool => withheld !== null);

function noCardPayload(seed = SCORED_SEED, assessmentRequired = false) {
    return {
        agentId: 'agent-1',
        card: null,
        // The same two declarations the seed above was built from, so the
        // fixture cannot describe one agent's preview beside another's tier.
        riskTier: assessmentRequired ? null : 'CRITICAL',
        dataAccessScope: (assessmentRequired
            ? 'READ_TENANT_DATA'
            : 'READ_METADATA') as PolicyDataScope,
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

/**
 * One of the editor's two drift notices, by the axis it is about.
 *
 * Addressed by ID and not by its copy, deliberately. The keys these notices
 * render are not in `messages/en.json` yet, and next-intl renders a missing key
 * AS ITS OWN DOTTED PATH — so an assertion written against that path would be
 * satisfied by the very absence it is meant to be insensitive to, and would go
 * red the moment the catalogue landed. `s()` throwing on an unresolved key is
 * what keeps that mistake out of this file; an id is the handle that survives
 * the merge unchanged.
 */
function driftNotice(axis: 'tier-cap' | 'declared-scope'): HTMLElement | null {
    const el = document.getElementById(`agent-policy-card-above-${axis}`);
    return el instanceof HTMLElement ? el : null;
}

/**
 * The `<FormField>` description under one ladder — the "no rung above it is
 * offered" hint. `FormField` derives that id from the control's own id and
 * wires it into the control's `aria-describedby`, so this is the element a
 * screen reader reads out WITH the control rather than a class-name guess.
 */
function ladderHint(groupId: string): HTMLElement | null {
    const el = document.getElementById(`${groupId}-description`);
    return el instanceof HTMLElement ? el : null;
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

    it('goes on naming the withheld grants once the card exists', () => {
        // The fact does not expire with the preview: the grant still stands and
        // the tool is still refused on every call. Before `withheld` was on the
        // card branch it survived only in the creation audit row.
        expect(STANDING_WITHHELD.map((w) => w.reason)).toEqual([
            'DATA_SCOPE_ABOVE_CARD',
            'NOT_IN_CATALOGUE',
        ]);

        renderTab(cardPayload({ withheld: STANDING_WITHHELD }));

        for (const tool of STANDING_WITHHELD) {
            const row = withheldRow(tool.toolName);
            expect(row).toHaveTextContent(
                interp(nested('withheldReason', tool.reason), {
                    requires: tool.requires,
                    permits: tool.permits,
                }),
            );
            expect(row).toHaveTextContent(
                interp(nested('withheldRemedy', tool.reason), { requires: tool.requires }),
            );
        }
    });

    it('says nothing when the card withholds nothing, and nothing when it cannot be judged', () => {
        // The pair for the test above, and the reason it is a pair: a notice
        // reading "0 tools are withheld" on every healthy agent is noise, and
        // the same silence must hold for `null` — the version in force could
        // not be read, so there is no card to evaluate grants against and an
        // empty list would be a claim rather than an absence.
        for (const withheld of [[], null]) {
            const { unmount } = renderTab(cardPayload({ withheld }));

            // Positive companion: the card branch demonstrably rendered.
            expect(screen.getByText(s('heading'))).toBeInTheDocument();
            expect(screen.getByText(s('historyHeading'))).toBeInTheDocument();

            for (const reason of Object.keys(EN.withheldReason as Record<string, string>)) {
                expect(
                    screen.queryByText(stem(nested('withheldReason', reason)), { exact: false }),
                ).not.toBeInTheDocument();
            }
            unmount();
        }
    });
});

describe('the version trail names who wrote each version', () => {
    it('renders the resolved display name, and never the raw id', () => {
        renderTab(cardPayload());

        // The NAME, not the label beside it. The name is data the server
        // resolved and the label is copy; asserting the copy here would be
        // asserting the catalogue, which the withheld and badge blocks above
        // already do where the copy IS the thing under test.
        expect(versionRow('v2')).toHaveTextContent('Ada Lovelace');
        // The cuid is ON the row and must not reach the operator — a raw id
        // beside a timestamp reads as a defect rather than as evidence.
        expect(V2.createdByUserId).toBe('user-1');
        expect(versionRow('v2')).not.toHaveTextContent('user-1');

        // The pair: v1 is the seeded version with no actor at all, so its row
        // says nothing about one while still rendering everything else.
        expect(V1.createdByName).toBeNull();
        expect(versionRow('v1')).not.toHaveTextContent('Ada Lovelace');
        expect(versionRow('v1')).toHaveTextContent(
            interp(s('seededFromBadge'), { tier: 'MODERATE' }),
        );
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

        // The form no longer SAYS it cannot see the two ceilings set elsewhere,
        // because it can: `riskTier` and `dataAccessScope` are on the payload
        // and the ladders above are already clipped to them (the ceiling block
        // below measures that). The retired copy claimed the opposite, in a
        // sentence an operator would have read as the rule.
        //
        // It is NOT asserted absent by its own text. `ceilingsElsewhereHint` is
        // an orphan the integrator deletes with the catalogue merge, and `s()`
        // THROWS on a key that is not there — so an assertion naming it would
        // pass today and take this file red the moment the key it is about goes
        // away. The retirement is measured by what stands in its place instead:
        // the clipped ladders above, and the two drift notices whose gating the
        // ceiling block below pins.
        expect(V3.maxAutonomyLevel).toBeLessThanOrEqual(ceilingForRiskTier('MODERATE'));
        expect(driftNotice('tier-cap')).toBeNull();
        expect(driftNotice('declared-scope')).toBeNull();

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

describe('the ceilings set elsewhere are pre-empted on the controls', () => {
    it("offers no autonomy rung above the assessed tier's cap", () => {
        // HIGH caps autonomy at 2 and v3 sits at 2, so the rung the one-rung
        // rule would offer is exactly the one the PUT refuses. It is not
        // rendered disabled — it is not rendered.
        expect(ceilingForRiskTier('HIGH')).toBe(2);
        renderTab(cardPayload({ riskTier: 'HIGH' }));
        openEditor();

        expect(offered('agent-policy-card-autonomy')).toEqual(['0', '1', '2']);
        // The companion, from the same render: the dimension with room to spare
        // still offers its one rung above, so the clipping is per ceiling and
        // not a form that stopped offering widenings.
        expect(offered('agent-policy-card-data-scope')).toEqual([
            'NONE',
            'READ_METADATA',
            'READ_TENANT_DATA',
            'WRITE_TENANT_DATA',
        ]);
        // And the budgets, which no ceiling bounds, are untouched.
        expect(offered('agent-policy-card-per-day')).toEqual([
            '0',
            '1',
            '5',
            '10',
            '25',
            '50',
        ]);
    });

    it("offers no data rung above the agent's registered scope", () => {
        // The register declares READ_TENANT_DATA and v3 stops there, so
        // WRITE_TENANT_DATA is a raise past the declaration — refused by the
        // PUT, and now never offered.
        renderTab(cardPayload({ dataAccessScope: 'READ_TENANT_DATA' }));
        openEditor();

        expect(offered('agent-policy-card-data-scope')).toEqual([
            'NONE',
            'READ_METADATA',
            'READ_TENANT_DATA',
        ]);
        expect(offered('agent-policy-card-autonomy')).toEqual(['0', '1', '2', '3']);
    });

    it('an UNSCORED agent can only narrow autonomy, and the other ladders still work', () => {
        // `ceilingForRiskTier(null)` is DENY_CEILING, which is not a rung of
        // the ladder at all — so nothing above the base is offered, which is
        // the fail direction the whole subsystem takes for an unassessed agent.
        renderTab(cardPayload({ riskTier: null }));
        openEditor();

        expect(offered('agent-policy-card-autonomy')).toEqual(['0', '1', '2']);
        expect(offered('agent-policy-card-approval')).toEqual([
            'SECOND_APPROVER',
            'SINGLE_APPROVER',
        ]);
    });

    /**
     * ── THE HINT AND THE NOTICE ARE MUTUALLY EXCLUSIVE ──────────────
     *
     * `autonomyCapHint` and `dataScopeCapHint` both end in "so no rung above
     * it is offered". On a card sitting ABOVE its bound that sentence is
     * FALSE: the ladder deliberately keeps every rung the card holds, so the
     * operator can see and narrow their own declaration, and rungs above the
     * bound are on offer. A sentence under a control that states the opposite
     * of the control is worse on a compliance surface than no sentence — it is
     * the one claim there an operator reads as the rule. So each hint renders
     * only while its claim is true of the ladder beside it, and the drift
     * notice takes its place on the renders where it is not.
     *
     * The three cases below are exhaustive over the gate: both bounds above
     * the card, the autonomy bound under it, the data bound under it. The
     * unscored case is a fourth, because `DENY_CEILING` is under every card.
     *
     * All of it asserted STRUCTURALLY — element ids, and `FormField`'s own aria
     * wiring — never by copy. The keys are unmerged, and next-intl renders a
     * missing key as its own dotted path, so a text assertion here would be
     * measuring the catalogue's absence rather than the gate, and would invert
     * the day the catalogue landed.
     */
    it('states the cap under the control only while the ladder obeys it', () => {
        // MODERATE caps autonomy at 3 and v3 sits at 2; the register declares
        // WRITE_TENANT_DATA and v3 sits at READ_TENANT_DATA. Both bounds are
        // above the card, so both hints' claims hold.
        expect(V3.maxAutonomyLevel).toBeLessThan(ceilingForRiskTier('MODERATE'));
        expect(dataScopeWithinCard(V3.maxDataScope, 'WRITE_TENANT_DATA')).toBe(true);
        renderTab(cardPayload());
        openEditor();

        expect(ladderHint('agent-policy-card-autonomy')).not.toBeNull();
        expect(ladderHint('agent-policy-card-data-scope')).not.toBeNull();
        // Announced WITH the control rather than merely near it.
        expect(
            document
                .getElementById('agent-policy-card-autonomy')
                ?.getAttribute('aria-describedby'),
        ).toContain('agent-policy-card-autonomy-description');

        // And what each hint claims is true of this render: the top rung on
        // offer IS the bound, so nothing above it is offered.
        expect(offered('agent-policy-card-autonomy').at(-1)).toBe(
            String(ceilingForRiskTier('MODERATE')),
        );
        expect(offered('agent-policy-card-data-scope').at(-1)).toBe('WRITE_TENANT_DATA');
        expect(driftNotice('tier-cap')).toBeNull();
        expect(driftNotice('declared-scope')).toBeNull();

        // The companion, from the same render: the dimensions no ceiling bounds
        // carry no hint at all, so the two above are a per-ceiling statement
        // and not a description hung on every field.
        expect(ladderHint('agent-policy-card-per-day')).toBeNull();
        expect(ladderHint('agent-policy-card-approval')).toBeNull();
    });

    it('drops the autonomy hint and warns instead once the card is above the cap', () => {
        // CRITICAL caps autonomy at 1 while v3 declares 2, and rung 2 IS still
        // offered — so "no rung above the cap is offered" would be false here.
        expect(ceilingForRiskTier('CRITICAL')).toBe(1);
        renderTab(cardPayload({ riskTier: 'CRITICAL' }));
        openEditor();

        expect(offered('agent-policy-card-autonomy')).toEqual(['0', '1', '2']);
        expect(Number(offered('agent-policy-card-autonomy').at(-1))).toBeGreaterThan(
            ceilingForRiskTier('CRITICAL'),
        );
        expect(ladderHint('agent-policy-card-autonomy')).toBeNull();
        expect(driftNotice('tier-cap')).not.toBeNull();

        // Per AXIS, not per form: the data ladder is still inside its
        // declaration on this fixture, so its hint stands and its notice does
        // not. A gate that keyed off "any drift" would fail here.
        expect(ladderHint('agent-policy-card-data-scope')).not.toBeNull();
        expect(driftNotice('declared-scope')).toBeNull();
    });

    it('warns about the reach past the declaration — the drift nothing else clamps', () => {
        // The register was narrowed to READ_METADATA after v3 was written.
        // Unlike the tier cap, NOTHING at the tool boundary clamps this one —
        // `dataAccessScope` is read when a card is seeded and never again — so
        // the wider reach is live until somebody settles it here.
        expect(dataScopeWithinCard(V3.maxDataScope, 'READ_METADATA')).toBe(false);
        renderTab(cardPayload({ dataAccessScope: 'READ_METADATA' }));
        openEditor();

        expect(driftNotice('declared-scope')).not.toBeNull();
        expect(ladderHint('agent-policy-card-data-scope')).toBeNull();
        // Every rung the card holds is still offered, which is what makes the
        // repair reachable from the notice rather than only describable.
        expect(offered('agent-policy-card-data-scope')).toEqual([
            'NONE',
            'READ_METADATA',
            'READ_TENANT_DATA',
        ]);
        // Both moves are narrowings, so neither spends the one widening: drop
        // the tool the lower rung would strand, then land on the declaration.
        fireEvent.click(box('agent-policy-card-tool-list_risks'));
        pickRung('agent-policy-card-data-scope', 'READ_METADATA');
        expect(box('agent-policy-card-save-btn')).toBeEnabled();

        // And the other axis is untouched: MODERATE's cap is still above the
        // card, so autonomy keeps its hint and grows no notice.
        expect(driftNotice('tier-cap')).toBeNull();
        expect(ladderHint('agent-policy-card-autonomy')).not.toBeNull();
    });

    it('an UNSCORED agent gets the notice, and no hint that has to name a cap', () => {
        // `DENY_CEILING` is -1: not a rung, and not a number to put in front of
        // an operator. There is no cap to state, so the hint is absent rather
        // than rendering one — and the notice speaks instead.
        expect(ceilingForRiskTier(null)).toBe(-1);
        renderTab(cardPayload({ riskTier: null }));
        openEditor();

        expect(ladderHint('agent-policy-card-autonomy')).toBeNull();
        expect(driftNotice('tier-cap')).not.toBeNull();
        // Narrow-only, and the data axis still carries its own hint — the
        // positive companion that stops a dead form from passing.
        expect(offered('agent-policy-card-autonomy')).toEqual(['0', '1', '2']);
        expect(ladderHint('agent-policy-card-data-scope')).not.toBeNull();
    });

    it('a card ABOVE the cap keeps every rung it declares, and can be narrowed', () => {
        // CRITICAL caps autonomy at 1 while v3 declares 2 — reachable by a
        // re-assessment, since lowering the tier never rewrites a stored
        // version. Clipping the ladder to the cap here would leave the radio
        // group with no selected value: the operator could not see their own
        // card, let alone bring it under the cap.
        expect(ceilingForRiskTier('CRITICAL')).toBe(1);
        expect(V3.maxAutonomyLevel).toBe(2);
        renderTab(cardPayload({ riskTier: 'CRITICAL' }));
        openEditor();

        expect(offered('agent-policy-card-autonomy')).toEqual(['0', '1', '2']);

        // And the repair is offered rather than fought: the save judges the
        // MOVE, so narrowing onto the cap is a saveable edit.
        expect(box('agent-policy-card-save-btn')).toBeDisabled(); // nothing moved yet
        pickRung('agent-policy-card-autonomy', '1');
        expect(box('agent-policy-card-save-btn')).toBeEnabled();
        expect(
            screen.queryByText(nested('ladderRefusal', 'MULTI_RUNG_WIDEN')),
        ).not.toBeInTheDocument();
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
