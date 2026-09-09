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
 * panel writes, so there is no news for the shell to broadcast. Scoping a risk
 * to an agent happens on the AI-system entry and linking a control happens on
 * the control — both elsewhere, both deliberately not duplicated here.
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
 *   • `scopedToAgent: false` — no `AiSystemRequirementLink` ties the risk to
 *     this agent's AI system. That is MISSING INFORMATION, not a decision
 *     that the risk does not apply, and the panel must not launder one into
 *     the other. Read `usecases/ai-system.ts`: the only production writer of
 *     that table links EU-AI-ACT / ISO 42001 obligations, whose requirement
 *     ids are disjoint from the ASI rows — so on a real tenant TODAY every
 *     ASI risk arrives unscoped. A panel that files those under "not in scope
 *     for this agent" in a neutral tone reports zero findings for every
 *     tenant in the product. They get their own section, worded as a fact
 *     about the data, and `nothingScoped` says so once at the top.
 *   • uncovered AND in scope — the finding. It sorts first, on its own.
 *
 * Because of that, the Uncovered tile takes its tone from the API's
 * `uncovered` count and NOT from the in-scope subset: an uncovered risk is a
 * finding until somebody has affirmatively recorded that it does not apply,
 * and no surface in this product records that yet.
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
    scopedToAgent: boolean;
    directControls: CoveringControl[];
    inheritedFrom: InheritedCoverage[];
    /** One of `COVERAGE_STATUSES` today — see `asCoverageStatus` for why the
     *  declared type is wider than the values the service emits. */
    status: string;
    /** `NOT_SCOPED` | `NO_CONTROL` today; unknown codes render no line at all
     *  rather than a sentence this build cannot vouch for. */
    reason: string | null;
}

interface CoverageSummary {
    total: number;
    covered: string[];
    partiallyCovered: string[];
    reviewNeeded: string[];
    uncovered: string[];
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
 * Unscoped entries never read from this table: NOT_COVERED means one thing
 * when the risk is scoped to the agent and another when nothing has been
 * scoped at all, so `RiskEntryCard` resolves that pair before it reaches here.
 */
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
    | 'notScoped';

const STATUS_VARIANT: Record<CoverageStatus, StatusBadgeVariant> = {
    COVERED: 'success',
    PARTIALLY_COVERED: 'warning',
    REVIEW_NEEDED: 'info',
    NOT_COVERED: 'error',
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

    // The uncovered list the API returns is one bucket; an assessor reads two.
    // Splitting it here rather than in the tiles keeps the API's partition
    // intact above and the actionable ordering below.
    //
    // Written as one exhaustive pass rather than five independent filters so
    // that every entry provably lands somewhere: the `default` arm is what
    // stops an unrecognised status from being dropped in silence.
    const groups = useMemo(() => {
        const buckets: Record<GroupKey, CoverageEntry[]> = {
            openGaps: [],
            reviewNeeded: [],
            partial: [],
            unrecognised: [],
            covered: [],
            notScoped: [],
        };
        for (const entry of data?.entries ?? []) {
            switch (asCoverageStatus(entry.status)) {
                case 'NOT_COVERED':
                    (entry.scopedToAgent ? buckets.openGaps : buckets.notScoped).push(entry);
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

    // Not `notScoped.length === summary.total`: a PARTIALLY_COVERED entry is
    // also unscoped (a direct control that nothing ties to this agent), so
    // that test would miss a tenant whose every risk is unscoped but not all
    // uncovered. The claim being made is about the links, so read the links.
    const nothingScoped = data.entries.every((entry) => !entry.scopedToAgent);

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
            // Last, and the reason line is suppressed: the heading above it
            // already says these are unscoped, and repeating it on every row
            // would make the section read like ten separate findings. The
            // copy states what the data says — no link exists — and stops
            // short of the applicability decision nothing in the product has
            // actually made.
            key: 'notScoped',
            entries: groups.notScoped,
            heading: t('agentDetail.coverage.notScopedHeading', {
                count: groups.notScoped.length,
            }),
            description: t('agentDetail.coverage.notScopedDescription'),
            showReason: false,
        },
    ];

    return (
        <div className="space-y-section">
            {nothingScoped && (
                // Above the summary, because it qualifies every number below
                // it: COVERED requires a scope link, so with none the
                // percentage is pinned at 0 by construction and reads as a
                // measurement when it is the absence of one.
                <InlineNotice
                    variant="warning"
                    title={t('agentDetail.coverage.nothingScopedTitle')}
                    data-testid="agent-coverage-nothing-scoped"
                >
                    <p>{t('agentDetail.coverage.nothingScopedBody')}</p>
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
                        {t('agentDetail.coverage.coveredOf', {
                            covered: summary.covered.length,
                            total: summary.total,
                        })}
                    </p>
                    {/* The percentage is conservative by construction and says
                        so, because the number on its own reads as the whole
                        answer and is the one figure that cannot name the open
                        risk. */}
                    <p className="text-xs text-content-muted">
                        {t('agentDetail.coverage.conservativeNote')}
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
                    {/* Tone follows the API's uncovered count, NOT the in-scope
                        subset. Scoping is the only thing that moves a risk out
                        of this tile, and nothing in the product scopes an ASI
                        requirement to an AI system — so keying the tone off
                        `openGaps` painted a neutral "0 in scope" tile over ten
                        uncontrolled risks on every real tenant, which reads as
                        "no findings". An uncovered risk stays a finding until
                        somebody affirmatively records that it does not apply.
                        The description carries the split so the tile still
                        reconciles with the two sections below. */}
                    <KPIStat
                        value={summary.uncovered.length}
                        label={t('agentDetail.coverage.countUncovered')}
                        tone={summary.uncovered.length > 0 ? 'critical' : 'default'}
                        description={t('agentDetail.coverage.uncoveredSplit', {
                            scoped: groups.openGaps.length,
                            unscoped: groups.notScoped.length,
                        })}
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
    };
    // `NO_CONTROL` says "no DIRECT control" and nothing else. The service sets
    // it whenever a scoped risk falls short of COVERED, and both routes to
    // that — REVIEW_NEEDED and an inherited PARTIALLY_COVERED — require an
    // inherited route that has controls (classifyAgentRiskCoverage drops
    // control-less routes first). So the unqualified wording sat four lines
    // above the very controls it denied. Scoped + direct is COVERED, which
    // carries no reason at all, so "directly" is true everywhere this shows.
    const reasonLabels: Record<string, string> = {
        NOT_SCOPED: t('agentDetail.coverage.reason.notScoped'),
        NO_CONTROL: t('agentDetail.coverage.reason.noDirectControl'),
    };
    const strengthLabels: Record<MappingStrength, string> = {
        EQUAL: t('agentDetail.coverage.strength.equal'),
        SUPERSET: t('agentDetail.coverage.strength.superset'),
        SUBSET: t('agentDetail.coverage.strength.subset'),
        INTERSECT: t('agentDetail.coverage.strength.intersect'),
        RELATED: t('agentDetail.coverage.strength.related'),
    };

    const status = asCoverageStatus(entry.status);
    // NOT_COVERED means two different things depending on scope, so the badge
    // reads the pair rather than the status alone. "Not scoped" is the fact;
    // the badge deliberately does not say "not in scope", which would assert a
    // decision about applicability that nothing in the data supports.
    const notScoped = status === 'NOT_COVERED' && !entry.scopedToAgent;
    // An unrecognised status shows its raw code in a neutral badge — the same
    // fallback the mapping strengths and control statuses use. Naming what the
    // API said beats inventing a label for it.
    const badgeLabel = notScoped
        ? t('agentDetail.coverage.status.notScoped')
        : status
          ? statusLabels[status]
          : entry.status;
    const badgeVariant: StatusBadgeVariant = notScoped || !status
        ? 'neutral'
        : STATUS_VARIANT[status];
    const reasonLabel = entry.reason ? reasonLabels[entry.reason] : undefined;

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
