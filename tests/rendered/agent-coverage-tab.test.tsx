/**
 * Render test for the AGENTIC-RISK COVERAGE tab (`CoverageTab`).
 *
 * The claim this file exists for is a statement the panel must never make.
 * "The OWASP ASI framework is not in this deployment's catalogue" and "you are
 * covered for 0 of 10 agentic risks" are different facts about different
 * subjects — one is about the product's framework table, the other is a
 * finding against this tenant's agent. A panel that renders the first as the
 * second reports a compliance failure that was never measured, on a surface
 * whose whole purpose is to be read by an assessor. So the three
 * nothing-to-report states are pinned as three DISTINCT renderings, pairwise:
 * framework absent, framework installed but carrying no requirement rows, and
 * a real, measured zero. Each block asserts the true rendering first and the
 * false one's absence second, so a component that rendered nothing at all
 * cannot pass by silence.
 *
 * The rest of the file defends the applicability model, which is the other
 * place this panel can misreport — and it can do so in BOTH directions:
 *
 *   • A `NOT_APPLICABLE` entry counted as uncovered invents a finding. The
 *     service derived, from a register column, that the agent lacks the
 *     capability the risk names; folding that into the Uncovered tile turns a
 *     capability the agent does not have into a control gap it does.
 *   • The denominator is `applicableTotal`, never `total`. Measuring 3 covered
 *     against the ten-risk catalogue while simultaneously reporting three of
 *     those ten as out of scope is arithmetic the panel contradicts on the
 *     same screen — and it reads WORSE than the truth, so nobody would catch
 *     it by being suspicious of a flattering number.
 *   • And the exemption must not read as a decision somebody made. Nobody
 *     recorded it; it was derived from tool grants and autonomy level, and it
 *     flips the moment either column does, with no record that it ever did
 *     not. Every N/A row therefore renders its BASIS — the specific,
 *     checkable half — and the copy on both the summary card and the section
 *     says where the exemption came from.
 *
 * Two smaller invariants ride along. The conservative note has to survive
 * 100% coverage, because that is the reading it exists to qualify: a linked
 * control is not evidence anyone tested it against THIS agent. And
 * `explicitlyScoped` no longer gates COVERED — an entry the service reports
 * as covered is rendered as covered and counted, whether or not an operator
 * ever linked the risk by hand; the old panel demoted those, and a test that
 * did not pin this would let the demotion return unnoticed.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

// next-intl is ESM (jest cannot parse it); mock it resolving real en.json
// values. `make` is MEMOISED per namespace — a fresh `t` identity on every
// render invalidates the `useMemo([t])` that builds the columns, which turns a
// render into a loop rather than a failure.
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

import { CoverageTab } from '@/app/t/[tenantSlug]/(app)/admin/agents/[agentId]/tabs/CoverageTab';

// ─── The real catalogue ──────────────────────────────────────────────
//
// Every assertion below reads the string the USER sees, resolved out of
// `messages/en.json` exactly as the component's `t` does. `en()` throws on a
// key that does not resolve to a string, so a test that stops defending its
// claim fails loudly rather than comparing a key name against a key name.

const EN_COVERAGE = (
    require('../../messages/en.json') as {
        admin: { agentDetail: { coverage: Record<string, unknown> } };
    }
).admin.agentDetail.coverage;

function en(key: string): string {
    const value = key.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        EN_COVERAGE as unknown,
    );
    if (typeof value !== 'string')
        throw new Error(`admin.agentDetail.coverage.${key} does not resolve to a string in messages/en.json`);
    return value;
}

function fill(message: string, params: Record<string, string | number>): string {
    let out = message;
    for (const [name, value] of Object.entries(params))
        out = out.replace(new RegExp('\\{' + name + '\\}', 'g'), String(value));
    return out;
}

// ─── Wire fixtures ───────────────────────────────────────────────────

interface WireControl {
    id: string;
    code: string | null;
    name: string;
    status: string;
}

interface WireEntry {
    code: string;
    title: string;
    section: string | null;
    explicitlyScoped: boolean;
    directControls: WireControl[];
    inheritedFrom: {
        frameworkKey: string;
        frameworkName: string;
        requirementCode: string;
        requirementTitle: string;
        strength: string;
        controls: WireControl[];
    }[];
    status: string;
    reason: string | null;
    applicabilityBasis: string | null;
}

interface WireReport {
    agent: {
        id: string;
        name: string;
        status: string;
        riskTier: string | null;
        aiSystemId: string;
    };
    frameworkInstalled: boolean;
    framework: { key: string; name: string } | null;
    entries: WireEntry[];
    summary: {
        total: number;
        applicableTotal: number;
        covered: string[];
        partiallyCovered: string[];
        reviewNeeded: string[];
        uncovered: string[];
        notApplicable: string[];
        coveragePercent: number;
    };
}

const CONTROL: WireControl = {
    id: 'ctrl-1',
    code: 'AC-3',
    name: 'Tool invocation allowlist',
    status: 'IMPLEMENTED',
};

function entry(code: string, status: string, overrides: Partial<WireEntry> = {}): WireEntry {
    return {
        code,
        title: `Agentic risk titled for ${code}`,
        section: null,
        explicitlyScoped: true,
        directControls: [],
        inheritedFrom: [],
        status,
        reason: status === 'NOT_COVERED' ? 'NO_CONTROL' : null,
        applicabilityBasis: null,
        ...overrides,
    };
}

/**
 * Build a report whose SUMMARY is derived from its own entries, so a fixture
 * cannot accidentally assert a denominator the entry list contradicts. The
 * one thing the service computes and the panel only renders — the percentage
 * — is derived over `applicableTotal`, which is the arithmetic under test.
 */
function makeReport(entries: WireEntry[], overrides: Partial<WireReport> = {}): WireReport {
    const codesWith = (status: string) =>
        entries.filter((e) => e.status === status).map((e) => e.code);
    const covered = codesWith('COVERED');
    const notApplicable = codesWith('NOT_APPLICABLE');
    const total = entries.length;
    const applicableTotal = total - notApplicable.length;
    return {
        agent: {
            id: 'agent-1',
            name: 'Vendor reconciler',
            status: 'ACTIVE',
            riskTier: 'HIGH',
            aiSystemId: 'ais-1',
        },
        frameworkInstalled: true,
        framework: { key: 'owasp-asi', name: 'OWASP Agentic Security Initiative' },
        entries,
        summary: {
            total,
            applicableTotal,
            covered,
            partiallyCovered: codesWith('PARTIALLY_COVERED'),
            reviewNeeded: codesWith('REVIEW_NEEDED'),
            uncovered: codesWith('NOT_COVERED'),
            notApplicable,
            coveragePercent:
                applicableTotal === 0 ? 0 : Math.round((covered.length / applicableTotal) * 100),
        },
        ...overrides,
    };
}

function mockReport(report: WireReport) {
    mockSWR.mockReturnValue({
        data: report,
        error: undefined,
        isLoading: false,
        mutate: jest.fn(),
    });
}

function renderTab() {
    return render(<CoverageTab tenantSlug="acme" agentId="agent-1" />);
}

/** The `<section>` a heading introduces — membership, not mere presence. */
function sectionOf(heading: string): HTMLElement {
    const found = screen.getByText(heading).closest('section');
    if (!found) throw new Error(`no <section> wrapping the heading: ${heading}`);
    return found as HTMLElement;
}

/** The KPI tile carrying a given label. The label span is the tile's first child. */
function kpiTile(label: string): HTMLElement {
    const tiles = screen.getAllByTestId('kpi-stat');
    const hit = tiles.find((tile) => tile.firstElementChild?.textContent === label);
    if (!hit) throw new Error(`no KPI tile labelled: ${label}`);
    return hit;
}

/**
 * The mixed report every applicability block reads. Ten catalogue risks:
 * three covered, two open gaps, one partial, one review, and THREE the
 * register puts out of scope — so `total` (10) and `applicableTotal` (7)
 * differ, and 3/7 (43%) differs from 3/10 (30%).
 */
function mixedReport(overrides: Partial<WireReport> = {}): WireReport {
    return makeReport(
        [
            entry('ASI01', 'COVERED', { directControls: [CONTROL] }),
            entry('ASI02', 'NOT_APPLICABLE', {
                reason: 'NOT_APPLICABLE',
                applicabilityBasis: 'NO_TOOL_GRANTS',
            }),
            entry('ASI03', 'NOT_COVERED'),
            entry('ASI04', 'PARTIALLY_COVERED', {
                reason: 'NO_CONTROL',
                inheritedFrom: [
                    {
                        frameworkKey: 'iso-42001',
                        frameworkName: 'ISO/IEC 42001',
                        requirementCode: 'A.6.2.2',
                        requirementTitle: 'AI system impact assessment',
                        strength: 'RELATED',
                        controls: [{ ...CONTROL, id: 'ctrl-2', code: 'AC-9', name: 'Impact review' }],
                    },
                ],
            }),
            entry('ASI05', 'REVIEW_NEEDED', { reason: 'NO_CONTROL' }),
            entry('ASI06', 'COVERED', {
                explicitlyScoped: false,
                directControls: [{ ...CONTROL, id: 'ctrl-3', code: null, name: 'Egress proxy' }],
            }),
            // Never linked to this agent by hand, and still a finding: an
            // unscoped gap is not an exemption.
            entry('ASI07', 'NOT_COVERED', { explicitlyScoped: false }),
            entry('ASI08', 'NOT_APPLICABLE', {
                reason: 'NOT_APPLICABLE',
                applicabilityBasis: 'SUGGEST_ONLY',
            }),
            entry('ASI09', 'NOT_APPLICABLE', {
                reason: 'NOT_APPLICABLE',
                applicabilityBasis: 'NO_TOOL_GRANTS',
            }),
            entry('ASI10', 'COVERED', { directControls: [CONTROL] }),
        ],
        overrides,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('an absent framework is not zero coverage', () => {
    it('says the catalogue is missing the rows, and shows no figure of any kind', () => {
        mockReport(
            makeReport([], {
                frameworkInstalled: false,
                framework: null,
                summary: {
                    total: 0,
                    applicableTotal: 0,
                    covered: [],
                    partiallyCovered: [],
                    reviewNeeded: [],
                    uncovered: [],
                    notApplicable: [],
                    coveragePercent: 0,
                },
            }),
        );
        renderTab();

        // Positive first: the notice demonstrably rendered, so every absence
        // below is a real absence rather than a blank panel.
        const notice = screen.getByTestId('agent-coverage-framework-absent');
        expect(within(notice).getByText(en('notAvailableTitle'))).toBeInTheDocument();
        expect(within(notice).getByText(en('notAvailableBody'))).toBeInTheDocument();

        // The misreport, in every form the panel could make it.
        expect(screen.queryByTestId('agent-coverage-percent')).not.toBeInTheDocument();
        expect(screen.queryByText('0%')).not.toBeInTheDocument();
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
        expect(
            screen.queryByText(fill(en('coveredOf'), { covered: 0, applicable: 0 })),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByText(fill(en('coveredOf'), { covered: 0, applicable: 10 })),
        ).not.toBeInTheDocument();
        // No tiles either — an "Uncovered: 0" tile is the same claim in a box.
        expect(screen.queryAllByTestId('kpi-stat')).toHaveLength(0);
        expect(screen.queryByText(en('summaryHeading'))).not.toBeInTheDocument();
    });

    it('names no in-workspace remedy and links nowhere, because the row is not a tenant setting', () => {
        mockReport(
            makeReport([], {
                frameworkInstalled: false,
                framework: null,
                summary: {
                    total: 0,
                    applicableTotal: 0,
                    covered: [],
                    partiallyCovered: [],
                    reviewNeeded: [],
                    uncovered: [],
                    notApplicable: [],
                    coveragePercent: 0,
                },
            }),
        );
        renderTab();

        const notice = screen.getByTestId('agent-coverage-framework-absent');
        expect(within(notice).getByText(en('notAvailableBody'))).toBeInTheDocument();
        // `/t/{slug}/frameworks` lists the same global table the row is
        // missing from, so any link here sends the reader to a page that
        // provably does not contain what they came for.
        expect(within(notice).queryByRole('link')).toBeNull();
        expect(within(notice).queryByRole('button')).toBeNull();
    });

    it('the copy itself distinguishes the two facts and quotes no percentage', () => {
        // Read on the catalogue rather than the DOM: the sentence is the whole
        // mechanism here, so a rewrite that drops the distinction is the
        // regression, whatever the markup does.
        expect(en('notAvailableBody')).toContain('not the same as zero coverage');
        expect(en('notAvailableBody')).not.toMatch(/\d+%/);
        expect(en('notAvailableTitle')).not.toMatch(/\d/);
    });

    it('a measured zero renders the whole apparatus — figure, bar and tiles', () => {
        // The mirror image. Ten in-scope risks, none covered: this IS the
        // "0 of 10" statement, and it is allowed to be made here.
        mockReport(
            makeReport(
                Array.from({ length: 10 }, (_, i) =>
                    entry(`ASI${String(i + 1).padStart(2, '0')}`, 'NOT_COVERED'),
                ),
            ),
        );
        renderTab();

        expect(screen.getByTestId('agent-coverage-percent')).toHaveTextContent('0%');
        expect(
            screen.getByText(fill(en('coveredOf'), { covered: 0, applicable: 10 })),
        ).toBeInTheDocument();
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');

        // And it is NOT the framework-absent state.
        expect(screen.queryByTestId('agent-coverage-framework-absent')).not.toBeInTheDocument();
        expect(screen.queryByText(en('notAvailableTitle'))).not.toBeInTheDocument();
        expect(screen.queryByText(en('notAvailableBody'))).not.toBeInTheDocument();
    });

    it('an installed framework holding no requirements is a third rendering, not either of the other two', () => {
        mockReport(makeReport([]));
        renderTab();

        expect(screen.getByText(en('frameworkEmptyTitle'))).toBeInTheDocument();
        expect(
            screen.getByText(
                fill(en('frameworkEmptyDescription'), {
                    framework: 'OWASP Agentic Security Initiative',
                }),
            ),
        ).toBeInTheDocument();
        // Unlike the absent-catalogue notice, this one CAN point somewhere:
        // the framework exists, it is this workspace's view of it that is empty.
        expect(screen.getByRole('link', { name: en('frameworkLink') })).toHaveAttribute(
            'href',
            '/t/acme/frameworks/owasp-asi',
        );

        expect(screen.queryByTestId('agent-coverage-percent')).not.toBeInTheDocument();
        expect(screen.queryByText('0%')).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-coverage-framework-absent')).not.toBeInTheDocument();
        expect(screen.queryByText(en('notAvailableTitle'))).not.toBeInTheDocument();
    });
});

describe('a risk the register puts out of scope is not a gap', () => {
    it('renders N/A entries in their own section, as not applicable', () => {
        mockReport(mixedReport());
        renderTab();

        const naSection = sectionOf(fill(en('notApplicableHeading'), { count: 3 }));
        expect(within(naSection).getByText('ASI02')).toBeInTheDocument();
        expect(within(naSection).getByText('ASI08')).toBeInTheDocument();
        expect(within(naSection).getByText('ASI09')).toBeInTheDocument();
        expect(within(naSection).getAllByText(en('status.notApplicable'))).toHaveLength(3);
        expect(within(naSection).getByText(en('notApplicableDescription'))).toBeInTheDocument();
    });

    it('keeps them out of the open-gaps list, which holds the two real findings', () => {
        mockReport(mixedReport());
        renderTab();

        const gaps = sectionOf(fill(en('gapsHeading'), { count: 2 }));
        // Positive companion: the section rendered its actual members.
        expect(within(gaps).getByText('ASI03')).toBeInTheDocument();
        expect(within(gaps).getByText('ASI07')).toBeInTheDocument();
        expect(within(gaps).getAllByText(en('status.notCovered'))).toHaveLength(2);

        expect(within(gaps).queryByText('ASI02')).toBeNull();
        expect(within(gaps).queryByText('ASI08')).toBeNull();
        expect(within(gaps).queryByText('ASI09')).toBeNull();
        expect(within(gaps).queryByText(en('status.notApplicable'))).toBeNull();
    });

    it('does not count them in the Uncovered tile', () => {
        mockReport(mixedReport());
        renderTab();

        const uncovered = kpiTile(en('countUncovered'));
        expect(within(uncovered).getByText('2')).toBeInTheDocument();
        // 2 findings + 3 exemptions. A tile reading 5 has invented three.
        expect(within(uncovered).queryByText('5')).toBeNull();

        // The tile names what sits outside it, so it still reconciles with the
        // sections below rather than leaving the reader to subtract.
        expect(uncovered).toHaveTextContent('not counted here');
        expect(screen.queryByText(en('applicableSplitNone'))).toBeNull();
    });

    it('claims every risk applies only when none is exempt', () => {
        mockReport(
            makeReport([
                entry('ASI01', 'COVERED', { directControls: [CONTROL] }),
                entry('ASI02', 'NOT_COVERED'),
            ]),
        );
        renderTab();

        const uncovered = kpiTile(en('countUncovered'));
        expect(within(uncovered).getByText('1')).toBeInTheDocument();
        expect(screen.getByText(en('applicableSplitNone'))).toBeInTheDocument();
        expect(
            screen.queryByText(fill(en('notApplicableHeading'), { count: 0 })),
        ).not.toBeInTheDocument();
    });
});

describe('the denominator is what applies, not the catalogue', () => {
    it('shows the ratio against the applicable total', () => {
        mockReport(mixedReport());
        renderTab();

        expect(
            screen.getByText(fill(en('coveredOf'), { covered: 3, applicable: 7 })),
        ).toBeInTheDocument();
        // The out-of-scope risks must not appear in the denominator. This is
        // the reading that is WORSE than the truth, so nothing else on the
        // page would make a reader suspicious of it.
        expect(
            screen.queryByText(fill(en('coveredOf'), { covered: 3, applicable: 10 })),
        ).not.toBeInTheDocument();
    });

    it('shows the percentage over the same denominator', () => {
        mockReport(mixedReport());
        renderTab();

        // 3 of 7 applicable, not 3 of 10 catalogue rows.
        expect(screen.getByTestId('agent-coverage-percent')).toHaveTextContent('43%');
        expect(screen.queryByText('30%')).not.toBeInTheDocument();
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43');
    });

    it('the sentence is written against the applicable count, so no future edit can swap the source', () => {
        expect(en('coveredOf')).toContain('{applicable}');
        expect(en('coveredOf')).not.toContain('{total}');
        expect(en('coveredOf')).toContain('applicable');
    });
});

describe('the exemption is derived, and says so', () => {
    it('renders the register basis on every N/A row', () => {
        mockReport(mixedReport());
        renderTab();

        const naSection = sectionOf(fill(en('notApplicableHeading'), { count: 3 }));
        // Two rows lack tool grants, one is registered at autonomy 0.
        expect(within(naSection).getAllByText(en('basis.zeroToolGrants'))).toHaveLength(2);
        expect(within(naSection).getByText(en('basis.suggestOnly'))).toBeInTheDocument();
    });

    it('keeps the basis even where the generic reason line is suppressed', () => {
        mockReport(mixedReport());
        renderTab();

        const naSection = sectionOf(fill(en('notApplicableHeading'), { count: 3 }));
        // The heading already says these do not apply, so the generic reason
        // is dropped — but the checkable half survives that suppression.
        expect(within(naSection).getByText(en('basis.suggestOnly'))).toBeInTheDocument();
        expect(within(naSection).queryByText(en('reason.notApplicable'))).toBeNull();
    });

    it('renders nothing at all for a basis this build does not recognise', () => {
        mockReport(
            makeReport([
                entry('ASI01', 'COVERED', { directControls: [CONTROL] }),
                entry('ASI02', 'NOT_APPLICABLE', {
                    reason: 'NOT_APPLICABLE',
                    applicabilityBasis: 'A_BASIS_FROM_A_LATER_SERVICE',
                }),
            ]),
        );
        renderTab();

        const naSection = sectionOf(fill(en('notApplicableHeading'), { count: 1 }));
        // The row itself is present — the absence below is about the basis
        // line, not about a dropped entry.
        expect(within(naSection).getByText('ASI02')).toBeInTheDocument();
        expect(within(naSection).getByText(en('status.notApplicable'))).toBeInTheDocument();
        // A raw enum code is not a sentence this build can vouch for.
        expect(screen.queryByText('A_BASIS_FROM_A_LATER_SERVICE')).not.toBeInTheDocument();
        expect(screen.queryByText(en('basis.zeroToolGrants'))).not.toBeInTheDocument();
        expect(screen.queryByText(en('basis.suggestOnly'))).not.toBeInTheDocument();
    });

    it('says on screen that the scope was derived from the register, not decided by anyone', () => {
        mockReport(mixedReport());
        renderTab();

        expect(screen.getByText(en('derivedScopeNote'))).toBeInTheDocument();
        expect(
            screen.getByText(en('notApplicableDescription')),
        ).toBeInTheDocument();
    });

    it('the copy attributes the exemption to the register and disclaims a recorded decision', () => {
        // A shrunken denominator flatters the figure, so the rule behind it is
        // stated on the same card. These two sentences are that rule; a
        // rewrite that turns them into "marked not applicable" would describe
        // a decision nobody made.
        expect(en('derivedScopeNote')).toContain('derived from');
        expect(en('derivedScopeNote')).toContain('Nobody has recorded an applicability decision');
        expect(en('notApplicableDescription')).toContain('derived from the register');
        expect(en('notApplicableDescription')).toContain(
            'not an applicability decision anyone recorded',
        );
        // And that it is reversible without trace.
        expect(en('notApplicableDescription')).toContain('no record that it ever was not');
        expect(en('basis.zeroToolGrants')).toContain('does not mean the agent touches nothing');
    });
});

describe('the conservative note', () => {
    it('says a linked control is not evidence it was tested against this agent', () => {
        mockReport(mixedReport());
        renderTab();

        expect(screen.getByText(en('conservativeNote'))).toBeInTheDocument();
        expect(en('conservativeNote')).toContain(
            'not evidence that it was tested against this agent',
        );
    });

    it('survives 100% coverage, which is the reading it exists to qualify', () => {
        mockReport(
            makeReport([
                entry('ASI01', 'COVERED', { directControls: [CONTROL] }),
                entry('ASI02', 'COVERED', { directControls: [CONTROL] }),
            ]),
        );
        renderTab();

        expect(screen.getByTestId('agent-coverage-percent')).toHaveTextContent('100%');
        // A note that disappears at 100% is missing from the only screen where
        // somebody is about to conclude the agent is done.
        expect(screen.getByText(en('conservativeNote'))).toBeInTheDocument();
        expect(screen.getByText(en('derivedScopeNote'))).toBeInTheDocument();
    });
});

describe('explicit scoping no longer gates COVERED', () => {
    it('counts and renders a covered entry the operator never scoped by hand', () => {
        mockReport(mixedReport());
        renderTab();

        const coveredSection = sectionOf(fill(en('coveredHeading'), { count: 3 }));
        // ASI06 carries `explicitlyScoped: false` and a direct control.
        expect(within(coveredSection).getByText('ASI06')).toBeInTheDocument();
        expect(within(coveredSection).getAllByText(en('status.covered'))).toHaveLength(3);

        // It is in the numerator, not demoted into a gap or an exemption.
        expect(within(kpiTile(en('countCovered'))).getByText('3')).toBeInTheDocument();
        expect(
            screen.getByText(fill(en('coveredOf'), { covered: 3, applicable: 7 })),
        ).toBeInTheDocument();
        expect(within(sectionOf(fill(en('gapsHeading'), { count: 2 }))).queryByText('ASI06')).toBeNull();
        expect(
            within(sectionOf(fill(en('notApplicableHeading'), { count: 3 }))).queryByText('ASI06'),
        ).toBeNull();
    });

    it('an unscoped uncovered risk stays a finding rather than becoming an exemption', () => {
        mockReport(mixedReport());
        renderTab();

        // The other half of the same rule: "nobody linked this" is not
        // "this does not apply". ASI07 is unscoped and uncovered.
        const gaps = sectionOf(fill(en('gapsHeading'), { count: 2 }));
        expect(within(gaps).getByText('ASI07')).toBeInTheDocument();
        expect(within(kpiTile(en('countUncovered'))).getByText('2')).toBeInTheDocument();
        expect(
            within(sectionOf(fill(en('notApplicableHeading'), { count: 3 }))).queryByText('ASI07'),
        ).toBeNull();
    });

    it('an unreviewed register entry qualifies the figures without pinning them to zero', () => {
        const unassessed = mixedReport();
        mockReport({ ...unassessed, agent: { ...unassessed.agent, riskTier: null } });
        renderTab();

        const notice = screen.getByTestId('agent-coverage-unassessed');
        expect(within(notice).getByText(en('unassessedNotice'))).toBeInTheDocument();
        // The retired banner said nothing was scoped and the percentage was
        // therefore 0. The figure is still the real one.
        expect(screen.getByTestId('agent-coverage-percent')).toHaveTextContent('43%');
        expect(screen.queryByText('0%')).not.toBeInTheDocument();
        expect(
            screen.getByText(fill(en('coveredOf'), { covered: 3, applicable: 7 })),
        ).toBeInTheDocument();
    });
});
