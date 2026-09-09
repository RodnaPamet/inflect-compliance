'use client';

import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { ShieldSlash } from '@/components/ui/icons/nucleo';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { KPIStat } from '@/components/ui/metric';
import { ProgressBar } from '@/components/ui/progress-bar';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading, textLinkVariants } from '@/components/ui/typography';
import { ApiClientError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';

import type { AgentTabProps } from './types';

/**
 * OWASP ASI01–ASI10 coverage for one registered agent.
 *
 * Read-only, and it takes no `onChanged` for that reason: nothing on this
 * panel writes, so there is no news for the shell to broadcast. Changing what
 * applies happens on the REGISTER (grant a tool, raise the autonomy level) and
 * linking a control happens on the control — both elsewhere, both deliberately
 * not duplicated here.
 *
 * FOUR ABSENCES THIS PANEL HAS TO KEEP APART, because collapsing any two of
 * them is a misreport on a compliance surface. Each one is an absence, and the
 * failure mode in every case is the same: rendering an absence as a
 * substantive negative — "you are covered for none of this", "this does not
 * apply to you" — when the truthful reading is "nobody has told us".
 *
 *   • `frameworkInstalled: false` — the ASI rows are missing from the
 *     PRODUCT-WIDE framework catalogue, so there is NOTHING to measure
 *     against. It renders as a notice and deliberately shows no percentage,
 *     no bar and no risk list. Note `Framework` carries no `tenantId`
 *     (prisma/schema/frameworks.prisma) — this is a deployment fact, not a
 *     workspace setting, which is why the notice names no in-product action
 *     and links nowhere: `/t/{slug}/frameworks` lists that same global table,
 *     so it would send the reader to a page provably missing the row.
 *   • `frameworkInstalled: true` with no entries — installed, holds no
 *     requirement rows. Also not zero coverage.
 *   • `status: 'NOT_APPLICABLE'` — the service DERIVED, from a mandatory
 *     register column, that this agent lacks the capability the risk names:
 *     zero tool grants for ASI02, autonomy 0 for ASI08. This one is the
 *     narrow exception to the rule above, and only because it is not an
 *     absence at all — it is a column with a value, enforced server-side, and
 *     every such row renders the exact basis so a reader can check it against
 *     the register instead of taking the word "applicable" on trust. THE
 *     WARNING STILL STANDS and now attaches to the basis strings: "no tool
 *     grants" means this agent cannot invoke a tool through the MCP tool door
 *     today, NOT that it touches nothing, and it flips the moment somebody
 *     grants one, with no record that it ever did not.
 *   • uncovered — the finding. It sorts first, on its own.
 *
 * Because of that, the Uncovered tile takes its tone from the API's
 * `uncovered` count: an uncovered risk is a finding until the register itself
 * shows the agent cannot reach it, and the risks where it does show that are
 * counted separately, never folded in here.
 *
 * Inherited coverage is labelled as inherited everywhere it appears and never
 * presented as covered: the service caps a cross-framework route at
 * PARTIALLY_COVERED however strong the mapping, because a mapping is Inflect's
 * curated judgement that two obligations overlap, not the tenant asserting
 * that the control governs this agent.
 */

const COVERAGE_STATUSES = [
    'COVERED',
    'PARTIALLY_COVERED',
    'REVIEW_NEEDED',
    'NOT_COVERED',
    'NOT_APPLICABLE',
] as const;
type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

type MappingStrength = 'EQUAL' | 'SUPERSET' | 'SUBSET' | 'INTERSECT' | 'RELATED';

/**
 * Narrow a wire status to the four this build can render.
 *
 * The wire field is typed `string`, not the union, deliberately. A fifth
 * `GapStatus` added service-side would match no group filter and no variant
 * key, so the entry would vanish from the panel while still counting in
 * `summary.total` — a risk silently dropped from a compliance readout, with
 * the denominator it inflates still on screen. Everything unrecognised lands
 * in its own visible bucket instead.
 */
function asCoverageStatus(status: string): CoverageStatus | undefined {
    return COVERAGE_STATUSES.find((known) => known === status);
}

/** `Control.code` is genuinely optional — fall back to the name, never a blank. */
interface CoveringControl {
    id: string;
    code: string | null;
    name: string;
    status: string;
}

interface InheritedCoverage {
    frameworkKey: string;
    frameworkName: string;
    requirementCode: string;
    requirementTitle: string;
    strength: MappingStrength;
    controls: CoveringControl[];
}

interface CoverageEntry {
    code: string;
    title: string;
    section: string | null;
    /**
     * An operator linked this agent's AI-system entry to the risk. It forces
     * the risk in scope server-side and is NOT the coverage gate — carried
     * only so the panel can tell a derived scope from a recorded one.
     */
    explicitlyScoped: boolean;
    directControls: CoveringControl[];
    inheritedFrom: InheritedCoverage[];
    /** One of `COVERAGE_STATUSES` today — see `asCoverageStatus` for why the
     *  declared type is wider than the values the service emits. */
    status: string;
    /** `NO_CONTROL` | `NOT_APPLICABLE` today; unknown codes render no line at
     *  all rather than a sentence this build cannot vouch for. */
    reason: string | null;
    /** `NO_TOOL_GRANTS` | `SUGGEST_ONLY` on an N/A row; null when the risk
     *  applies. An unknown basis renders nothing rather than a guess. */
    applicabilityBasis: string | null;
}

interface CoverageSummary {
    /** Every risk the framework carries. NOT the coverage denominator. */
    total: number;
    /** The denominator: `total` minus the risks the register puts out of scope. */
    applicableTotal: number;
    covered: string[];
    partiallyCovered: string[];
    reviewNeeded: string[];
    uncovered: string[];
    notApplicable: string[];
    coveragePercent: number;
}

/**
 * Declared locally rather than imported from `usecases/agent-coverage`: that
 * module reaches Prisma, and a type-only import from it is one refactor away
 * from dragging the server into this bundle.
 */
interface AgentRiskCoverageReport {
    agent: {
        id: string;
        name: string;
        status: string;
        riskTier: string | null;
        aiSystemId: string;
    };
    frameworkInstalled: boolean;
    framework: { key: string; name: string } | null;
    entries: CoverageEntry[];
    summary: CoverageSummary;
}

/**
 * The six buckets the entry list is partitioned into, in the order the panel
 * renders them. Named as a type so the partition below is a total function
 * over it — every entry lands in exactly one, `unrecognised` included.
 */
type GroupKey =
    | 'openGaps'
    | 'reviewNeeded'
    | 'partial'
    | 'unrecognised'
    | 'covered'
    | 'notApplicable';

const STATUS_VARIANT: Record<CoverageStatus, StatusBadgeVariant> = {
    COVERED: 'success',
    PARTIALLY_COVERED: 'warning',
    REVIEW_NEEDED: 'info',
    NOT_COVERED: 'error',
    // Neutral, and deliberately not 'success'. "Does not apply" is not an
    // achievement and must not read as one on a compliance surface.
    NOT_APPLICABLE: 'neutral',
};

export function CoverageTab({ tenantSlug, agentId, refreshToken }: AgentTabProps) {
    const t = useTranslations('admin');
    const { data, error, isLoading, mutate } = useTenantSWR<AgentRiskCoverageReport>(
        `/admin/agents/${agentId}/coverage`,
    );

    // The refreshToken -> SWR bridge. These lines, exactly, in every tab.
    useEffect(() => {
        void mutate();
    }, [refreshToken, mutate]);

    // The API's five disjoint lists, re-ordered into the sequence an assessor
    // reads: the finding first, the reassurance last. No entry is reclassified
    // on the way — the panel used to split `uncovered` by scope, and it no
    // longer needs to, because the service now reports the two meanings as two
    // statuses.
    //
    // Written as one exhaustive pass rather than six independent filters so
    // that every entry provably lands somewhere: the `default` arm is what
    // stops an unrecognised status from being dropped in silence.
    const groups = useMemo(() => {
        const buckets: Record<GroupKey, CoverageEntry[]> = {
            openGaps: [],
            reviewNeeded: [],
            partial: [],
            unrecognised: [],
            covered: [],
            notApplicable: [],
        };
        for (const entry of data?.entries ?? []) {
            switch (asCoverageStatus(entry.status)) {
                case 'NOT_COVERED':
                    // Every NOT_COVERED is now an open gap. The status no
                    // longer carries two meanings: a risk the register puts
                    // out of scope arrives as NOT_APPLICABLE instead, so there
                    // is nothing left for the panel to disambiguate.
                    buckets.openGaps.push(entry);
                    break;
                case 'NOT_APPLICABLE':
                    buckets.notApplicable.push(entry);
                    break;
                case 'REVIEW_NEEDED':
                    buckets.reviewNeeded.push(entry);
                    break;
                case 'PARTIALLY_COVERED':
                    buckets.partial.push(entry);
                    break;
                case 'COVERED':
                    buckets.covered.push(entry);
                    break;
                default:
                    buckets.unrecognised.push(entry);
            }
        }
        return buckets;
    }, [data]);

    if (error) {
        // A 403 is possible even though the page gate already passed — a role
        // can change under an open tab — and its message is deliberately the
        // uninformative "Permission denied", so it never reaches the panel.
        const status = error instanceof ApiClientError ? error.status : 0;
        return (
            <ErrorState
                title={t('agentDetail.coverage.errorTitle')}
                description={
                    status === 403
                        ? t('agentDetail.coverage.errorForbidden')
                        : status === 404
                          ? t('agentDetail.coverage.errorNotFound')
                          : t('agentDetail.coverage.errorLoad')
                }
                onRetry={() => void mutate()}
                retryLabel={t('agentDetail.coverage.retry')}
            />
        );
    }
    if (isLoading && !data) return <SkeletonCard lines={6} />;
    // Still narrowable-undefined here: SWR hands back nothing on the tick
    // between a key change and the next fetch. The loading render again, not
    // an empty panel — an absent report is not a report of zero.
    if (!data) return <SkeletonCard lines={6} />;

    if (!data.frameworkInstalled) {
        // No link. `Framework` has no tenantId, so "install it" names an
        // action this workspace cannot take, and `/t/{slug}/frameworks` reads
        // the same global table the row is missing from — the reader would
        // arrive at a list that provably does not contain what they came for.
        return (
            <InlineNotice
                variant="warning"
                title={t('agentDetail.coverage.notAvailableTitle')}
                data-testid="agent-coverage-framework-absent"
            >
                <p>{t('agentDetail.coverage.notAvailableBody')}</p>
            </InlineNotice>
        );
    }

    // Installed, but carrying no requirement rows. Also not zero coverage, and
    // phrased as a fact about the framework rather than about the agent.
    if (data.entries.length === 0) {
        return (
            <Card density="compact">
                <InlineEmptyState
                    icon={ShieldSlash}
                    title={t('agentDetail.coverage.frameworkEmptyTitle')}
                    // Omitted rather than interpolated with a blank name: the
                    // sentence opens on {framework}, so an empty fallback
                    // would render a leading gap and a headless claim.
                    description={
                        data.framework
                            ? t('agentDetail.coverage.frameworkEmptyDescription', {
                                  framework: data.framework.name,
                              })
                            : undefined
                    }
                />
                {data.framework && (
                    <p className="text-center text-xs">
                        <Link
                            href={`/t/${tenantSlug}/frameworks/${data.framework.key}`}
                            className={textLinkVariants({ tone: 'link' })}
                        >
                            {t('agentDetail.coverage.frameworkLink')}
                        </Link>
                    </p>
                )}
            </Card>
        );
    }

    const { summary } = data;

    // An agent nobody has scored. Its exposure profile — the two columns every
    // applicability call below is derived from — is a declaration nobody has
    // reviewed, which qualifies every figure on this panel without changing
    // any of them. A report-level caveat, deliberately not a sixth status.
    const unassessed = data.agent.riskTier === null;

    const sections = [
        {
            key: 'openGaps',
            entries: groups.openGaps,
            heading: t('agentDetail.coverage.gapsHeading', { count: groups.openGaps.length }),
            description: t('agentDetail.coverage.gapsDescription'),
            showReason: false,
        },
        {
            key: 'reviewNeeded',
            entries: groups.reviewNeeded,
            heading: t('agentDetail.coverage.reviewHeading', {
                count: groups.reviewNeeded.length,
            }),
            description: t('agentDetail.coverage.reviewDescription'),
            showReason: true,
        },
        {
            key: 'partial',
            entries: groups.partial,
            heading: t('agentDetail.coverage.partialHeading', { count: groups.partial.length }),
            description: t('agentDetail.coverage.partialDescription'),
            showReason: true,
        },
        {
            // Sits with the unresolved sections, not after the reassuring
            // ones: an entry this build cannot classify is the least settled
            // thing on the panel, and burying it under "Covered" would be the
            // silent drop this bucket exists to prevent.
            key: 'unrecognised',
            entries: groups.unrecognised,
            heading: t('agentDetail.coverage.unrecognisedHeading', {
                count: groups.unrecognised.length,
            }),
            description: t('agentDetail.coverage.unrecognisedDescription'),
            showReason: false,
        },
        {
            key: 'covered',
            entries: groups.covered,
            heading: t('agentDetail.coverage.coveredHeading', { count: groups.covered.length }),
            description: t('agentDetail.coverage.coveredDescription'),
            showReason: false,
        },
        {
            // Last, and the generic reason line is suppressed: the heading
            // already says these do not apply, and repeating it on every row
            // would make the section read like ten separate findings. Each row
            // still renders its own BASIS, which is the part that is specific
            // enough to check — `RiskEntryCard` shows that independently of
            // `showReason`.
            key: 'notApplicable',
            entries: groups.notApplicable,
            heading: t('agentDetail.coverage.notApplicableHeading', {
                count: groups.notApplicable.length,
            }),
            description: t('agentDetail.coverage.notApplicableDescription'),
            showReason: false,
        },
    ];

    return (
        <div className="space-y-section">
            {unassessed && (
                // Above the summary, because it qualifies every number below
                // it. The old banner here warned that nothing had been scoped
                // and the percentage was therefore pinned at 0 — a state that
                // no longer exists, since applicability is derived rather than
                // linked. What is still worth saying is weaker and true: the
                // register entry the derivation reads has never been reviewed.
                <InlineNotice variant="info" data-testid="agent-coverage-unassessed">
                    <p>{t('agentDetail.coverage.unassessedNotice')}</p>
                </InlineNotice>
            )}

            <Card density="compact">
                <div className="space-y-compact">
                    <div className="flex items-start justify-between gap-default">
                        <div className="space-y-tight">
                            <Heading level={2}>
                                {t('agentDetail.coverage.summaryHeading')}
                            </Heading>
                            {data.framework && (
                                <p className="text-xs text-content-muted">
                                    {t('agentDetail.coverage.measuredAgainst', {
                                        framework: data.framework.name,
                                    })}
                                </p>
                            )}
                        </div>
                        <span
                            className="text-xl font-semibold tabular-nums text-content-emphasis"
                            data-testid="agent-coverage-percent"
                        >
                            {t('agentDetail.coverage.percentValue', {
                                percent: summary.coveragePercent,
                            })}
                        </span>
                    </div>
                    <ProgressBar
                        value={summary.coveragePercent}
                        size="sm"
                        variant={
                            summary.coveragePercent === 100
                                ? 'success'
                                : summary.coveragePercent > 0
                                  ? 'brand'
                                  : 'neutral'
                        }
                        aria-label={t('agentDetail.coverage.progressAria')}
                    />
                    <p className="text-sm text-content-default">
                        {/* `applicableTotal`, NOT `total`. Measuring against
                            the catalogue would count risks this panel is
                            simultaneously reporting as out of scope. */}
                        {t('agentDetail.coverage.coveredOf', {
                            covered: summary.covered.length,
                            applicable: summary.applicableTotal,
                        })}
                    </p>
                    {/* The percentage is conservative by construction and says
                        so, because the number on its own reads as the whole
                        answer and is the one figure that cannot name the open
                        risk. */}
                    <p className="text-xs text-content-muted">
                        {t('agentDetail.coverage.conservativeNote')}
                    </p>
                    {/* And where the denominator came from. A shrunken
                        denominator flatters the percentage, so the rule behind
                        it is stated on the same card rather than left to be
                        discovered in the section at the bottom. */}
                    <p className="text-xs text-content-muted">
                        {t('agentDetail.coverage.derivedScopeNote')}
                    </p>
                </div>
            </Card>

            <div className="grid grid-cols-2 gap-default lg:grid-cols-4">
                <Card density="compact">
                    <KPIStat
                        value={summary.covered.length}
                        label={t('agentDetail.coverage.countCovered')}
                        tone={summary.covered.length > 0 ? 'success' : 'default'}
                    />
                </Card>
                <Card density="compact">
                    <KPIStat
                        value={summary.partiallyCovered.length}
                        label={t('agentDetail.coverage.countPartial')}
                    />
                </Card>
                <Card density="compact">
                    <KPIStat
                        value={summary.reviewNeeded.length}
                        label={t('agentDetail.coverage.countReview')}
                        tone={summary.reviewNeeded.length > 0 ? 'attention' : 'default'}
                    />
                </Card>
                <Card density="compact">
                    {/* Tone follows the API's uncovered count. Only the
                        REGISTER moves a risk out of this tile now, and it does
                        so by naming a capability the agent provably lacks — so
                        the count here is a count of findings, with nothing
                        laundered into it and nothing quietly dropped from it.
                        The description names what sits outside the tile, so
                        the tile still reconciles with the sections below. */}
                    <KPIStat
                        value={summary.uncovered.length}
                        label={t('agentDetail.coverage.countUncovered')}
                        tone={summary.uncovered.length > 0 ? 'critical' : 'default'}
                        description={
                            /* Zero is its own key, not an ICU `=0` arm. The
                               locale checker extracts placeholders with
                               /\{([a-zA-Z0-9_]+)/, so an English sub-message
                               beginning with a word — `{Every risk ...}` —
                               reads as a placeholder named `Every`, while the
                               Bulgarian arm beginning in Cyrillic matches
                               nothing, and the pair drifts. Every one of the
                               67 other plurals in the repo avoids the form. */
                            summary.notApplicable.length === 0
                                ? t('agentDetail.coverage.applicableSplitNone')
                                : t('agentDetail.coverage.applicableSplit', {
                                      notApplicable: summary.notApplicable.length,
                                  })
                        }
                    />
                </Card>
            </div>

            {sections.map((section) =>
                section.entries.length === 0 ? null : (
                    <section key={section.key} className="space-y-compact">
                        <div className="space-y-tight">
                            <Heading level={3}>{section.heading}</Heading>
                            <p className="text-xs text-content-muted">{section.description}</p>
                        </div>
                        <ul className="space-y-compact">
                            {section.entries.map((entry) => (
                                <RiskEntryCard
                                    key={entry.code}
                                    entry={entry}
                                    tenantSlug={tenantSlug}
                                    showReason={section.showReason}
                                />
                            ))}
                        </ul>
                    </section>
                ),
            )}
        </div>
    );
}

/**
 * One agentic risk, with every control standing behind it and how it got
 * there. Direct and inherited are separated by a rule and a label rather than
 * merged into one list: an assessor asked "which control covers ASI04 for this
 * agent" is owed the difference between a control linked to the risk and a
 * control Inflect believes overlaps it.
 */
function RiskEntryCard({
    entry,
    tenantSlug,
    showReason,
}: {
    entry: CoverageEntry;
    tenantSlug: string;
    showReason: boolean;
}) {
    const t = useTranslations('admin');

    const statusLabels: Record<CoverageStatus, string> = {
        COVERED: t('agentDetail.coverage.status.covered'),
        PARTIALLY_COVERED: t('agentDetail.coverage.status.partiallyCovered'),
        REVIEW_NEEDED: t('agentDetail.coverage.status.reviewNeeded'),
        NOT_COVERED: t('agentDetail.coverage.status.notCovered'),
        NOT_APPLICABLE: t('agentDetail.coverage.status.notApplicable'),
    };
    // `NO_CONTROL` says "no DIRECT control" and nothing else. The service sets
    // it whenever a scoped risk falls short of COVERED, and both routes to
    // that — REVIEW_NEEDED and an inherited PARTIALLY_COVERED — require an
    // inherited route that has controls (classifyAgentRiskCoverage drops
    // control-less routes first). So the unqualified wording sat four lines
    // above the very controls it denied. Scoped + direct is COVERED, which
    // carries no reason at all, so "directly" is true everywhere this shows.
    const reasonLabels: Record<string, string> = {
        NO_CONTROL: t('agentDetail.coverage.reason.noDirectControl'),
        NOT_APPLICABLE: t('agentDetail.coverage.reason.notApplicable'),
    };
    // The register column and value that put the risk out of scope, named so a
    // reader can check the claim against the register in one click. An
    // unrecognised basis renders NOTHING rather than a sentence this build
    // cannot vouch for — the same rule the reason labels follow.
    const basisLabels: Record<string, string> = {
        // `zeroToolGrants`, not `noToolGrants`: a key whose last segment
        // matches /^no[A-Z]/ is read by `empty-state-tone` as an empty-state
        // TITLE and held to the "No X yet" voice — no trailing period, no
        // explanatory tail. This value is neither a title nor an empty state,
        // it is a sentence explaining why a risk was excused, so it takes a
        // name the heuristic does not claim.
        NO_TOOL_GRANTS: t('agentDetail.coverage.basis.zeroToolGrants'),
        SUGGEST_ONLY: t('agentDetail.coverage.basis.suggestOnly'),
    };
    const strengthLabels: Record<MappingStrength, string> = {
        EQUAL: t('agentDetail.coverage.strength.equal'),
        SUPERSET: t('agentDetail.coverage.strength.superset'),
        SUBSET: t('agentDetail.coverage.strength.subset'),
        INTERSECT: t('agentDetail.coverage.strength.intersect'),
        RELATED: t('agentDetail.coverage.strength.related'),
    };

    const status = asCoverageStatus(entry.status);
    // An unrecognised status shows its raw code in a neutral badge — the same
    // fallback the mapping strengths and control statuses use. Naming what the
    // API said beats inventing a label for it.
    const badgeLabel = status ? statusLabels[status] : entry.status;
    const badgeVariant: StatusBadgeVariant = status ? STATUS_VARIANT[status] : 'neutral';
    const reasonLabel = entry.reason ? reasonLabels[entry.reason] : undefined;
    // Rendered independently of `showReason`: the N/A section suppresses the
    // generic reason line because its heading already says it, but the basis
    // is the specific, checkable half and must survive that suppression.
    const basisLabel = entry.applicabilityBasis
        ? basisLabels[entry.applicabilityBasis]
        : undefined;

    return (
        <Card as="li" density="compact" className="space-y-compact">
            <div className="flex items-start justify-between gap-default">
                <div className="min-w-0 space-y-tight">
                    <div className="flex flex-wrap items-baseline gap-compact">
                        <code className="font-mono text-xs text-content-subtle">
                            {entry.code}
                        </code>
                        <span className="text-sm font-medium text-content-emphasis">
                            {entry.title}
                        </span>
                    </div>
                    {entry.section && (
                        <p className="text-xs text-content-subtle">{entry.section}</p>
                    )}
                </div>
                <StatusBadge variant={badgeVariant} size="sm" className="shrink-0">
                    {badgeLabel}
                </StatusBadge>
            </div>

            {showReason && reasonLabel && (
                <p className="text-xs text-content-muted">{reasonLabel}</p>
            )}

            {basisLabel && <p className="text-xs text-content-muted">{basisLabel}</p>}

            {entry.directControls.length > 0 && (
                <div className="space-y-tight">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">
                        {t('agentDetail.coverage.directHeading')}
                    </p>
                    <ControlList controls={entry.directControls} tenantSlug={tenantSlug} />
                </div>
            )}

            {entry.inheritedFrom.length > 0 && (
                <div className="space-y-compact border-t border-border-subtle pt-3">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">
                        {t('agentDetail.coverage.inheritedHeading')}
                    </p>
                    {entry.inheritedFrom.map((route) => (
                        <div
                            key={`${route.frameworkKey}:${route.requirementCode}`}
                            className="space-y-tight"
                        >
                            <div className="flex flex-wrap items-baseline gap-compact">
                                <span className="text-xs text-content-default">
                                    {route.frameworkName}
                                </span>
                                <code className="font-mono text-xs text-content-subtle">
                                    {route.requirementCode}
                                </code>
                                <span className="text-xs text-content-muted">
                                    {route.requirementTitle}
                                </span>
                                <StatusBadge variant="neutral" size="sm" icon={null}>
                                    {strengthLabels[route.strength] ?? route.strength}
                                </StatusBadge>
                            </div>
                            <ControlList controls={route.controls} tenantSlug={tenantSlug} />
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}

/**
 * The controls themselves, each linked to its own page and carrying its
 * implementation status. The status is the part that stops this list
 * over-reading: the query counts a linked control whatever state it is in, so
 * a risk can be COVERED by a control nobody has started.
 */
function ControlList({
    controls,
    tenantSlug,
}: {
    controls: CoveringControl[];
    tenantSlug: string;
}) {
    const t = useTranslations('admin');

    const statusLabels: Record<string, string> = {
        NOT_STARTED: t('agentDetail.coverage.controlStatus.notStarted'),
        PLANNED: t('agentDetail.coverage.controlStatus.planned'),
        IN_PROGRESS: t('agentDetail.coverage.controlStatus.inProgress'),
        IMPLEMENTING: t('agentDetail.coverage.controlStatus.implementing'),
        IMPLEMENTED: t('agentDetail.coverage.controlStatus.implemented'),
        NEEDS_REVIEW: t('agentDetail.coverage.controlStatus.needsReview'),
        NOT_APPLICABLE: t('agentDetail.coverage.controlStatus.notApplicable'),
    };

    return (
        <ul className="space-y-tight">
            {controls.map((control) => (
                <li
                    key={control.id}
                    className="flex items-baseline justify-between gap-compact text-xs"
                >
                    <Link
                        href={`/t/${tenantSlug}/controls/${control.id}`}
                        className={cn(textLinkVariants({ tone: 'link' }), 'min-w-0 truncate')}
                    >
                        {control.code ? `${control.code} · ${control.name}` : control.name}
                    </Link>
                    <span className="shrink-0 text-content-subtle">
                        {statusLabels[control.status] ?? control.status}
                    </span>
                </li>
            ))}
        </ul>
    );
}
