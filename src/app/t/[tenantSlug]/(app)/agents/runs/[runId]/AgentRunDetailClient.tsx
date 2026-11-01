'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { StatusBadge } from '@/components/ui/status-badge';
import { MetaStrip } from '@/components/ui/meta-strip';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiErrorMessage } from '@/lib/api-error';
import { PermissionGated } from '../../PermissionGated';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import { delegationSpans, delegatesClaiming } from '@/lib/agentic/delegation-spans';
import { proposalKindLabelKey } from '@/lib/agentic/proposal-labels';
import { proposalStatusLabelKey, runStatusLabelKey, stepStatusLabelKey } from '@/lib/agentic/run-labels';
import type { RunStepFeedRow } from '@/lib/agentic/run-step-projection';
import type { RecordedRunDriver } from '@/lib/agentic/agent-driver';

/**
 * ONE definition, in the usecase that produces it.
 *
 * This file used to declare the shape and `page.tsx` used to build it, so the
 * two agreed by being written together. With the projection shared by the
 * paged feed route and the live tail (#3472) that stops being true: a field
 * added to the row here and not to the projection would typecheck as an
 * optional-free structural match in neither direction, and a field added
 * there would silently never render. A type ALIAS cannot drift.
 *
 * `import type`, so nothing from the app layer reaches the client bundle.
 */
export type RunStepRow = RunStepFeedRow;

export interface RunHeader {
    id: string;
    workflowKey: string;
    workflowName: string;
    status: string;
    /** As recorded, or `UNRECOGNISED` for an engine this build does not know (#4241). */
    driver: RecordedRunDriver;
    stepCount: number;
    costTokens: number;
    startedAt: string;
    completedAt: string | null;
    summary: string | null;
    errorMessage: string | null;
    /**
     * WHAT CAUSED THIS RUN — the `AutomationExecution` id of the rule firing
     * that started it, or null when nothing did (#3537).
     *
     * Distinct from the authority. An automation-started run's
     * `startedByUserId` is the rule OWNER, because the run executes under
     * their permissions and is stamped `actorType: 'JOB'` so the trail does
     * not claim a person acted. That is correct attribution and says nothing
     * about the cause, and a reader seeing only a person's name concluded
     * somebody had clicked something.
     */
    parentExecutionId: string | null;
    /**
     * WHO started it, by name, and WHICH rule caused it (#4894). Both null when
     * the page could not resolve them: a starter who is no longer a member, or
     * a run nothing caused. For an automation-started run the starter is the
     * rule's owner, whose permissions it ran under.
     */
    startedBy?: string | null;
    ruleName?: string | null;
    /**
     * WHAT THIS RUN WAS TAUGHT (#3666) — each mounted skill's name, version and
     * content hash, pinned when the run was admitted. `[]` means it mounted
     * none; null means the row predates the pin, which is a different fact and
     * is shown as one.
     */
    /**
     * `origin: 'tenant'` marks a skill this workspace authored (#3680); a
     * repository skill carries no origin.
     */
    mountedSkills: Array<{ name: string; version: string; contentHash: string; origin?: 'tenant'; versionId?: string }> | null;
}

const STATUS_VARIANT: Record<string, 'info' | 'success' | 'warning' | 'error' | 'neutral'> = {
    RUNNING: 'info',
    AWAITING_APPROVAL: 'warning',
    PAUSED: 'warning',
    COMPLETED: 'success',
    ABORTED: 'neutral',
    FAILED: 'error',
    // A run that could not start because it reached no tool (#4894): a
    // failure, in the failure tone, as on the runs list.
    EMPTY_CATALOGUE: 'error',
};

/** The statuses a run can be resumed from, and the ones it can be aborted from — as on the runs list. */
const RESUMABLE = new Set(['AWAITING_APPROVAL', 'PAUSED']);
const ABORTABLE = new Set(['RUNNING', 'AWAITING_APPROVAL', 'PAUSED']);

/**
 * The engines' error codes, worded (#4894). A run's `errorMessage` is written
 * as `<code>: <detail>`; a known code gets a sentence and the rest is kept as
 * the technical detail. An unknown one is shown as written.
 */
const ERROR_CODES = new Set([
    'skill_not_mountable',
    'skill_pin_drift',
    'flue_run_failed',
    'tool_runner_run_failed',
    'monthly_token_budget_exceeded',
]);

export function runErrorParts(message: string): { code: string | null; detail: string } {
    const match = /^([a-z_]+):\s*([\s\S]*)$/.exec(message);
    if (!match) return { code: null, detail: message };
    const [, raw, detail] = match;
    if (raw.endsWith('_run_agent_killed')) return { code: 'run_agent_killed', detail };
    return ERROR_CODES.has(raw) ? { code: raw, detail } : { code: null, detail: message };
}

/**
 * Per-STEP status. A different axis from the run's, and deliberately its own
 * map: a step is PENDING while the run is AWAITING_APPROVAL, and collapsing the
 * two would make the checkpoint that is waiting look like the run that is.
 */
const STEP_STATUS_VARIANT: Record<string, 'info' | 'success' | 'warning' | 'error' | 'neutral'> = {
    PENDING: 'warning',
    RUNNING: 'info',
    DONE: 'success',
    FAILED: 'error',
    SKIPPED: 'neutral',
};

const DRIVER_VARIANT: Record<string, 'info' | 'neutral'> = {
    STATIC: 'neutral',
    FLUE: 'info',
    TOOL_RUNNER: 'info',
};

/** A step's payload, shown as TEXT and never interpreted. */
function Payload({ label, json }: { label: string; json: string | null }) {
    if (!json) return null;
    return (
        <details className="text-xs">
            <summary className="cursor-pointer text-content-subtle">{label}</summary>
            {/*
                `json` is agent-authored tenant content, decrypted on read by the
                Epic B extension. It goes through `{}` so React escapes it, into
                a <pre> so it keeps its shape, and is NEVER parsed or injected —
                the quarantine surface settled this for the same class of
                content. `break-words` because a single long line of JSON would
                otherwise make the whole page scroll sideways.
            */}
            <pre className="mt-tight overflow-x-auto whitespace-pre-wrap break-words text-content-muted">
                {json}
            </pre>
        </details>
    );
}

/**
 * The run's step ledger, in order.
 *
 * An ordered LIST, not a table: the rows are heterogeneous — a checkpoint has
 * an actor and no tool, a synthesis has output and neither — and a table would
 * spend four columns being empty to keep them aligned. It also keeps the whole
 * table platform (the tabular primitive, its filter toolbar, its column
 * dropdown, the list-page shell) out of a surface that needs none of it.
 *
 * That last sentence names the platform WITHOUT naming its component, on
 * purpose. `tests/unit/data-table.test.ts` decides which files it audits with
 * `content.includes(...)` over the raw source, so a file that merely MENTIONS
 * the component in prose is audited as though it rendered one — and this file
 * was, failing four assertions about column definitions it has no columns for.
 * Not the first guard here to read prose as code: the explicit-`any` ratchet
 * matches an English word ending in "-as" followed immediately by the word
 * "any", and the no-fallbacks guard once flagged a comment that quoted the very
 * pattern it bans. These guards read comments, so a comment naming a primitive
 * is a comment claiming to use it.
 */
/**
 * STEP THROUGH A RUN, one step at a time (#3472, plan point 08's scrubber).
 *
 * ── WHY IT LIVES HERE AND NOT ON THE CANVAS ─────────────────────────────────
 *
 * The plan asks for "a timeline scrubber so a completed run can be stepped
 * through node-by-node". A run's steps index a workflow DEFINITION's step
 * array, which is code — the canvas holds one node per automation RULE, so
 * there is no step-to-node mapping to scrub along. The ledger is where the
 * steps are, so this is where stepping through them belongs; the canvas shows
 * the run's state on its agent node instead (#3548).
 *
 * ── NO FETCHING ─────────────────────────────────────────────────────────────
 *
 * The page is server-rendered with every step already in hand, so scrubbing is
 * pure selection over data that is present. A scrubber that fetched per step
 * would add a spinner to an interaction whose whole point is to be immediate,
 * and the bounded feed (#3514) exists for the surfaces that cannot hold the
 * whole ledger.
 *
 * ── SELECTION IS ADDITIVE, NOT A FILTER ─────────────────────────────────────
 *
 * Every step stays rendered and the selected one is EMPHASISED. Hiding the
 * others would make the scrubber the only way to read the run — worse for
 * anyone scanning, and it would break the `#step-N` anchors the decisions page
 * links into. So the control is an affordance over the list rather than a
 * replacement for it.
 */
function TimelineScrubber({
    steps,
    selectedSeq,
    onSelect,
}: {
    steps: RunStepRow[];
    selectedSeq: number | null;
    onSelect: (seq: number | null) => void;
}) {
    const t = useTranslations('agents');
    // The POSITION in the rendered list, not the step's own `seq`. A Flue run's
    // `seq` counts steps RECORDED and a static run's indexes the definition, so
    // neither is guaranteed contiguous — stepping by `seq ± 1` would skip or
    // stall on a gap. The list order is the thing an operator is stepping
    // through.
    const index = selectedSeq === null ? -1 : steps.findIndex((s) => s.seq === selectedSeq);
    // NOTHING SELECTED is not "at the end". `atLast` read
    // `index === -1 || …`, which disabled NEXT in the initial state and made
    // the scrubber unusable until somebody clicked a disabled button — caught
    // by its own rendered test on the first run.
    //
    // The semantics, stated: with nothing selected, PREV is disabled and NEXT
    // selects the first step. That is "stepping forward through a run", which
    // is what an operator opens this for; making PREV jump to the last step
    // instead would be a second, unsignposted entry point.
    const atFirst = index <= 0;
    const atLast = index !== -1 && index >= steps.length - 1;

    const go = (delta: number) => {
        const next = index === -1 ? 0 : index + delta;
        if (next < 0 || next >= steps.length) return;
        onSelect(steps[next].seq);
    };

    return (
        <div
            className="flex flex-wrap items-center gap-tight"
            data-testid="run-scrubber"
            // A GROUP, so a screen reader announces the three controls as one
            // thing rather than three loose buttons in a card.
            role="group"
            aria-label={t('runs.detail.scrubber.label')}
            onKeyDown={(e) => {
                // Arrow keys, because stepping through a sequence with a mouse
                // is the slower half of the interaction. Scoped to this group
                // so they do not fight the page's own scrolling.
                if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
                if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
            }}
        >
            <Button
                size="sm"
                variant="secondary"
                onClick={() => go(-1)}
                disabled={atFirst}
                data-testid="run-scrubber-prev"
            >
                {t('runs.detail.scrubber.prev')}
            </Button>
            <span className="text-sm tabular-nums text-content-muted" data-testid="run-scrubber-position">
                {index === -1
                    ? t('runs.detail.scrubber.none', { total: steps.length })
                    : t('runs.detail.scrubber.position', {
                          position: index + 1,
                          total: steps.length,
                      })}
            </span>
            <Button
                size="sm"
                variant="secondary"
                onClick={() => go(1)}
                disabled={atLast}
                data-testid="run-scrubber-next"
            >
                {t('runs.detail.scrubber.next')}
            </Button>
            {/* CLEARING IS A CONTROL, not an absence. Without it, selecting a
                step is a one-way door: an operator who wants the unemphasised
                list back would have to reload the page. */}
            {index !== -1 && (
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onSelect(null)}
                    data-testid="run-scrubber-clear"
                >
                    {t('runs.detail.scrubber.clear')}
                </Button>
            )}
        </div>
    );
}

export function AgentRunDetailClient({
    tenantSlug,
    run,
    steps,
    canOperate = false,
}: {
    tenantSlug: string;
    run: RunHeader;
    steps: RunStepRow[];
    /**
     * The role-tier `canWrite`: resume and abort open with `assertCanWrite`.
     * As on the runs list, the controls are shown DISABLED with the reason to
     * anybody else, never hidden.
     */
    canOperate?: boolean;
}) {
    const t = useTranslations('agents');
    const tenantHref = useTenantHref();
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const [refreshing, startRefresh] = useTransition();
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [confirmAbort, setConfirmAbort] = useState(false);

    async function act(action: 'resume' | 'abort') {
        setBusy(true);
        setActionError(null);
        try {
            const res = await fetch(apiUrl(`/agent-runs/${run.id}/${action}`), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) {
                setActionError(apiErrorMessage(await res.json().catch(() => null), t(`runs.${action}Failed`)));
                return;
            }
            startRefresh(() => router.refresh());
        } catch {
            setActionError(t(`runs.${action}Failed`));
        } finally {
            setBusy(false);
        }
    }

    const errorParts = run.errorMessage ? runErrorParts(run.errorMessage) : null;
    // A stored code's name, or the code itself when this build does not know
    // it (#4532). The keys come from `run-labels` / `proposal-labels`, which
    // pin each list to its enum and to both catalogues.
    const label = (key: string | null, stored: string) => (key ? t(key) : stored);
    // NULL is the initial state, and that is deliberate: the page's first paint
    // is the whole timeline with nothing singled out, which is what somebody
    // arriving from a link wants. Defaulting to step 1 would emphasise a step
    // nobody asked about.
    const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
    // THE DELEGATIONS, grouped by the rule in `delegation-spans` (#3473 part
    // 3). Derived rather than fetched: the steps already carry everything —
    // each delegation marker holds its specialist and its span's lower bound,
    // and the rule is pure so it is unit-tested without a timeline.
    //
    // Not memoised. It is a filter and a comparison over one page of steps,
    // and `useMemo` here would cost a dependency nobody re-reads for an
    // allocation nobody measured.
    const spans = delegationSpans(steps);
    // Absent reads as "not recorded", the same as NULL: a header built before
    // the field existed must not render as "mounted nothing".
    const pinnedSkills = run.mountedSkills ?? null;

    return (
        <EntityDetailLayout
            breadcrumbs={[
                { href: tenantHref('/agents'), label: t('runs.detail.crumbAgents') },
                { href: tenantHref('/agents/runs'), label: t('runs.crumb') },
                { label: run.workflowName },
            ]}
            // The smart back affordance, not a static href: the canonical
            // parent (/agents/runs) is the cold-load fallback, and a reader who
            // arrived from a proposal should go back there instead.
            back={{ smart: true }}
            title={run.workflowName}
            actions={
                RESUMABLE.has(run.status) || ABORTABLE.has(run.status) ? (
                    <div className="flex items-center gap-tight">
                        {RESUMABLE.has(run.status) && (
                            <PermissionGated allowed={canOperate} reason={t('runs.needsWrite')}>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={!canOperate || busy || refreshing}
                                    data-testid="run-detail-resume"
                                    onClick={() => void act('resume')}
                                >
                                    {t('runs.resume')}
                                </Button>
                            </PermissionGated>
                        )}
                        {ABORTABLE.has(run.status) && (
                            <PermissionGated allowed={canOperate} reason={t('runs.needsWrite')}>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={!canOperate || busy || refreshing}
                                    data-testid="run-detail-abort"
                                    onClick={() => setConfirmAbort(true)}
                                >
                                    {t('runs.abort')}
                                </Button>
                            </PermissionGated>
                        )}
                    </div>
                ) : undefined
            }
            // `<MetaStrip>` rather than a hand-rolled row of badges —
            // `detail-page-metastrip-adoption` requires it of every detail page
            // passing `meta`, and the editorial cap it documents (at most five
            // items, never two rows) is why this carries four and leaves the
            // summary to the body.
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            label: t('runs.detail.metaStatus'),
                            value: label(runStatusLabelKey(run.status), run.status),
                            variant: STATUS_VARIANT[run.status] ?? 'neutral',
                        },
                        {
                            kind: 'status',
                            label: t('runs.detail.metaDriver'),
                            value: t(`runs.driver.${run.driver}`),
                            variant: DRIVER_VARIANT[run.driver] ?? 'neutral',
                        },
                        {
                            kind: 'metric',
                            label: t('runs.detail.metaSteps'),
                            value: run.stepCount,
                        },
                        {
                            // The RUN's total. There is no per-step token
                            // column — `costTokens` is accumulated across the
                            // whole run — so the honest place for the number is
                            // the header, not a per-step chip that would have to
                            // invent it by division.
                            kind: 'metric',
                            label: t('runs.detail.metaTokens'),
                            value: run.costTokens,
                        },
                        {
                            label: t('runs.detail.metaStarted'),
                            value: formatDateTime(run.startedAt),
                        },
                    ]}
                />
            }
        >
            <div className="space-y-section">
                {/* WHO vs WHAT. An automation-started run names a person in
                    `startedByUserId` — the rule's owner, whose permissions it
                    ran under — so without this line the page answers "under
                    whose authority" while looking like it answers "why". The
                    id is shown rather than the rule's NAME because a rule can
                    be renamed or deleted after the fact and the execution id
                    is what the audit trail carries. */}
                {actionError && (
                    <InlineNotice variant="error" data-testid="run-detail-action-error">
                        {actionError}
                    </InlineNotice>
                )}
                {run.parentExecutionId ? (
                    <p
                        className="text-sm text-content-muted"
                        data-testid="run-caused-by"
                    >
                        {run.ruleName && run.startedBy
                            ? t('runs.detail.causedByRuleAs', { rule: run.ruleName, owner: run.startedBy })
                            : run.ruleName
                              ? t('runs.detail.causedByRule', { rule: run.ruleName })
                              : t('runs.detail.causedByUnnamedRule')}
                    </p>
                ) : run.startedBy ? (
                    <p className="text-sm text-content-muted" data-testid="run-started-by">
                        {t('runs.detail.startedBy', { name: run.startedBy })}
                    </p>
                ) : null}
                {/* WHAT IT WAS TAUGHT. Hashes rather than text: the hash
                    names the exact document in the repository, and the text
                    of a skill is the repository's to show, not this page's. */}
                <div data-testid="run-mounted-skills" className="space-y-tight">
                    <Heading level={3} className="text-sm">{t('runs.detail.skillsTitle')}</Heading>
                    {pinnedSkills === null ? (
                        <p className="text-sm text-content-muted">{t('runs.detail.skillsNotRecorded')}</p>
                    ) : pinnedSkills.length === 0 ? (
                        <p className="text-sm text-content-muted">{t('runs.detail.skillsNone')}</p>
                    ) : (
                        <ul className="space-y-tight text-sm">
                            {pinnedSkills.map((s) => (
                                <li key={s.name} className="flex flex-wrap items-baseline gap-x-compact">
                                    <span className="text-content-default">{s.name}</span>
                                    {s.origin === 'tenant' ? (
                                        <span className="text-content-muted" data-testid={`run-skill-tenant-${s.name}`}>
                                            {t('runs.detail.skillTenant')}
                                        </span>
                                    ) : null}
                                    <span className="text-content-muted">{t('runs.detail.skillVersion', { version: s.version })}</span>
                                    <code className="break-all text-xs text-content-muted">{s.contentHash}</code>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                {run.errorMessage && errorParts && (
                    <div
                        className={cn(cardVariants({ density: 'compact' }), 'space-y-tight text-sm')}
                        data-testid="run-error"
                    >
                        <p className="text-content-error">
                            {errorParts.code ? t(`runs.detail.error.${errorParts.code}`) : errorParts.detail}
                        </p>
                        {errorParts.code && errorParts.detail && (
                            <details>
                                <summary className="cursor-pointer text-xs text-content-subtle">
                                    {t('runs.detail.error.detailLabel')}
                                </summary>
                                <p className="mt-1 break-words text-xs text-content-muted">{errorParts.detail}</p>
                            </details>
                        )}
                    </div>
                )}
                {run.summary && (
                    <p className={cn(cardVariants({ density: 'comfortable' }), 'text-sm text-content-default')}>
                        {run.summary}
                    </p>
                )}

                {/* ── WHAT THIS RUN DELEGATED (#3473 part 3) ──────────────
                    Rendered ABOVE the timeline and only when there is
                    something to say: a run that delegated nothing shows
                    nothing, which is every run until a workflow uses a
                    specialist.

                    The steps a specialist produced are the run's OWN rows
                    further down — a delegate runs the parent's tool objects,
                    so its reads land in the parent's ledger and are charged to
                    it. The span is the only thing that says whose work they
                    were, which is why this section exists at all. */}
                {spans.length > 0 && (
                    <section
                        className={cn(cardVariants({ density: 'comfortable' }), 'space-y-tight')}
                        data-testid="run-delegations"
                    >
                        <Heading level={2} className="text-sm">
                            {t('runs.detail.delegation.title')}
                        </Heading>
                        <p className="max-w-prose text-xs text-content-muted">
                            {t('runs.detail.delegation.body')}
                        </p>
                        <ul className="space-y-compact">
                            {spans.map((span) => (
                                <li
                                    key={span.taskId}
                                    data-testid={`delegation-${span.agent}`}
                                    data-overlapping={span.overlapping ? 'true' : undefined}
                                    className="space-y-tight"
                                >
                                    <div className="flex flex-wrap items-center gap-tight">
                                        <span className="text-xs font-medium text-content-emphasis">
                                            {t('runs.detail.delegation.specialist', { name: span.agent })}
                                        </span>
                                        {/* THE OUTCOME, from the marker's own
                                            status — the one thing a reader
                                            cannot infer from the delegation
                                            having happened. */}
                                        <StatusBadge
                                            variant={
                                                span.marker.status === 'FAILED' ? 'error' : 'success'
                                            }
                                        >
                                            {span.marker.status === 'FAILED'
                                                ? t('runs.detail.delegation.refused')
                                                : t('runs.detail.delegation.accepted')}
                                        </StatusBadge>
                                    </div>
                                    {/* STEPS AND TOKENS, each able to say it
                                        does not know: an unbounded span claims
                                        no steps, and a span whose steps
                                        reported no usage is not a span that
                                        spent nothing. */}
                                    <p className="text-xs text-content-subtle">
                                        {span.fromSeq === null
                                            ? t('runs.detail.delegation.stepsUnknown')
                                            : t('runs.detail.delegation.stepsClaimed', {
                                                count: span.steps.length,
                                            })}
                                        {' · '}
                                        {span.costTokens === null
                                            ? t('runs.detail.delegation.tokensUnknown')
                                            : t('runs.detail.delegation.tokens', {
                                                count: span.costTokens,
                                            })}
                                    </p>
                                    {span.fromSeq === null && (
                                        <p className="text-xs text-content-subtle">
                                            {t('runs.detail.delegation.stepsUnknownWhy')}
                                        </p>
                                    )}
                                    {/* SAID, not implied. Interleaved
                                        delegations share steps, so these
                                        figures do not sum to the run's total,
                                        and a reader comparing them with the
                                        header would otherwise conclude the
                                        arithmetic is broken. */}
                                    {span.overlapping && (
                                        <InlineNotice variant="info">
                                            {t('runs.detail.delegation.overlapping')}
                                        </InlineNotice>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {steps.length === 0 ? (
                    <EmptyState
                        title={t('runs.detail.emptyTitle')}
                        description={t('runs.detail.emptyDesc')}
                    />
                ) : (
                    <>
                        <TimelineScrubber
                            steps={steps}
                            selectedSeq={selectedSeq}
                            onSelect={setSelectedSeq}
                        />
                        <ol id="run-step-timeline" className="space-y-default">
                        {steps.map((s) => (
                            <li
                                key={s.id}
                                id={`step-${s.seq}`}
                                className={cn(
                                    cardVariants({ density: 'comfortable' }),
                                    'space-y-tight',
                                    // EMPHASIS, not isolation — every step stays
                                    // rendered. Appended last so the ring wins
                                    // over the card's own border.
                                    s.seq === selectedSeq && 'ring-2 ring-brand-default',
                                )}
                                // The selection as a FACT a test can read, not a
                                // Tailwind ring string a redesign may reword.
                                data-selected={s.seq === selectedSeq ? 'true' : undefined}
                                // WHICH DELEGATE PRODUCED IT, as a fact too
                                // (#3473 part 3). Comma-joined because a step
                                // inside two overlapping delegations belongs to
                                // both, and naming one would be a guess.
                                data-delegates={
                                    delegatesClaiming(spans, s).join(',') || undefined
                                }
                            >
                                <div className="flex flex-wrap items-center gap-tight">
                                    <span className="text-xs tabular-nums text-content-subtle">
                                        {t('runs.detail.seq', { seq: s.seq + 1 })}
                                    </span>
                                    {/* The specialist, ON the step, so a reader
                                        scanning the timeline does not have to
                                        hold the span boundaries in their head.
                                        Quiet: the step's own status and kind are
                                        the louder signals. */}
                                    {delegatesClaiming(spans, s).length > 0 && (
                                        <span className="text-xs text-content-subtle">
                                            {t('runs.detail.delegation.stepBadge', {
                                                agents: delegatesClaiming(spans, s).join(', '),
                                            })}
                                        </span>
                                    )}
                                    <StatusBadge variant={STEP_STATUS_VARIANT[s.status] ?? 'neutral'}>
                                        {label(stepStatusLabelKey(s.status), s.status)}
                                    </StatusBadge>
                                    <span className="text-sm font-medium text-content-emphasis">
                                        {t(`runs.detail.kind.${s.kind}`)}
                                    </span>
                                    {/* The tool, when this kind has one. Rendered
                                        from the column where the step recorded it
                                        and from the definition where a failure
                                        did not. */}
                                    {s.tool && (
                                        <code className="text-xs text-content-muted">{s.tool}</code>
                                    )}
                                    {/* THE RUNG, beside the tool that reaches it.
                                        Inline text rather than a StatusBadge on
                                        purpose: `status` is the only field here
                                        whose meaning is a traffic light, and the
                                        per-file badge budget exists precisely to
                                        stop a row becoming a wall of colour in
                                        which the one badge that matters stops
                                        being read. */}
                                    {s.scope && (
                                        <span className="text-xs text-content-subtle">
                                            {t(`runs.detail.scope.${s.scope}`)}
                                        </span>
                                    )}
                                    {/* WHAT THE GUARD FOUND. Rendered only when
                                        one ran: a step with no verdict was never
                                        scanned, and a chip reading "clean" there
                                        would answer a question nobody asked of
                                        it. Rule ids ride in the title so the row
                                        stays one line and the detail is a hover
                                        away. */}
                                    {s.guardVerdict && (
                                        <span className="text-xs text-content-subtle">
                                            {t(`runs.detail.guard.${s.guardVerdict}`)}
                                        </span>
                                    )}
                                    {/* WHICH RULES FIRED, as visible text.
                                        Not a `title=` tooltip: the ad-hoc
                                        `title=` ratchet caps those in `src/app`
                                        and this is none of its three documented
                                        escape valves, and not a `<Tooltip>`
                                        either — portalising a Radix tooltip per
                                        step is the wrong cost for a ledger that
                                        can run to the step cap. Visible also
                                        beats hover-only here: an assessor
                                        reading which rule stopped a step should
                                        not have to find it with a mouse. */}
                                    {s.guardRuleIds.length > 0 && (
                                        <code className="text-xs text-content-muted">
                                            {s.guardRuleIds.join(', ')}
                                        </code>
                                    )}
                                    {/* WHAT IT SPENT. `!= null` rather than a
                                        truthiness test: a model call that really
                                        reported zero tokens is a fact worth
                                        showing, and `0 &&` would hide it. */}
                                    {s.costTokens != null && (
                                        <span className="text-xs tabular-nums text-content-subtle">
                                            {t('runs.detail.stepTokens', { count: s.costTokens })}
                                        </span>
                                    )}
                                    {/* THE ART 12 ROW THIS STEP PRODUCED.
                                        Point 4 of the plan asks that a step
                                        reach its decision-log row. There is no
                                        foreign key to follow — `AiDecisionLog`
                                        carries no `runId`, because it is the
                                        regulator's record of a DECISION rather
                                        than the engine's bookkeeping — so the
                                        join is `(tenantId, inputDigest)` and
                                        the digest recorded on the step is the
                                        key.

                                        Rendered only where a digest exists. A
                                        tool call has a guard verdict and NO
                                        decision row, so linking every guarded
                                        step would land half of them on an
                                        empty table — which is the failure the
                                        decisions page's own note warned about
                                        when it declined to wire this half
                                        before there was a key. */}
                                    {s.decisionDigest && (
                                        <a
                                            className="text-xs underline text-content-subtle"
                                            href={`${tenantHref('/agents/decisions')}?digest=${encodeURIComponent(s.decisionDigest)}`}
                                        >
                                            {t('runs.detail.decisionLink')}
                                        </a>
                                    )}
                                    {s.label && (
                                        <span className="text-xs text-content-subtle">{s.label}</span>
                                    )}
                                    <span className="ml-auto text-xs text-content-subtle">
                                        {formatDateTime(s.at)}
                                    </span>
                                </div>
                                <Payload label={t('runs.detail.inputLabel')} json={s.inputJson} />
                                <Payload label={t('runs.detail.outputLabel')} json={s.outputJson} />
                                {s.proposals.length > 0 && (
                                    /* WHAT THIS STEP QUEUED. A PROPOSE step's
                                       own payload records only `{count: N}` —
                                       the items deliberately do not live on the
                                       step — so without this the ledger says a
                                       propose happened and nothing about what
                                       it proposed. */
                                    <ul className="flex flex-wrap gap-tight text-xs">
                                        {s.proposals.map((p) => (
                                            <li key={p.id}>
                                                <a
                                                    className="underline text-content-muted"
                                                    data-testid={`step-proposal-${p.id}`}
                                                    href={`${tenantHref('/agents/proposals')}#proposal-${p.id}`}
                                                >
                                                    {t('runs.detail.proposal', {
                                                        kind: label(proposalKindLabelKey(p.kind), p.kind),
                                                        status: label(proposalStatusLabelKey(p.status), p.status),
                                                    })}
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </li>
                        ))}
                        </ol>
                    </>
                )}
            </div>
            <ConfirmDialog
                showModal={confirmAbort}
                setShowModal={(next) => {
                    const value = typeof next === 'function' ? next(confirmAbort) : next;
                    if (!value) setConfirmAbort(false);
                }}
                tone="danger"
                title={t('runs.abortConfirmTitle')}
                description={t('runs.abortConfirmBody', { workflow: run.workflowName })}
                confirmLabel={t('runs.abort')}
                onConfirm={async () => {
                    setConfirmAbort(false);
                    await act('abort');
                }}
            />
        </EntityDetailLayout>
    );
}
