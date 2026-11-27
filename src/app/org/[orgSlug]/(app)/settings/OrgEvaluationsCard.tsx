/**
 * "Evaluations": the platform's three LLM evaluation nightlies, described for
 * an organization's admins, with each one's live on/off state (owner
 * decisions 2026-11-12 and 2026-11-27).
 *
 * ═══ THE SWITCH IS THE PRODUCT'S ═══
 *
 * Ragas, garak and Inspect run as GitHub Actions against a throwaway copy of
 * the app built on the CI runner, never against production. Since 2026-11-27
 * each is switched HERE: the state is a row of `EvalNightlySwitch`, which a
 * scheduled run reads from production over a CI-token endpoint, staying off
 * on any answer but on. The card shows each nightly's state and when it last
 * changed; an ORG_OWNER of an operator organization (`EVALS_SWITCH_ORG_SLUGS`)
 * also gets a switch per nightly (`OrgEvalNightlySwitch`, the card's only
 * client code), and everybody else is told the switches are the platform
 * operator's. The static facts live in `@/lib/evals/evaluation-nightlies`,
 * held to the workflow files by a test.
 *
 * A server component (no `'use client'`). The page renders it only when
 * `evalsCardVisible` says so, and passes the usecase's read.
 */
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { TOUCH_HIT_AREA_CLASS } from '@inflect/ui/components/ui/hit-area';
import { cn } from '@inflect/ui/lib/cn';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import {
    EVAL_NIGHTLIES,
    EVAL_SHARED_KEY_SECRET,
    evalWorkflowRunsUrl,
    formatEvalUsd,
    type EvalNightly,
} from '@/lib/evals/evaluation-nightlies';
import type { EvalNightlySwitches, EvalNightlySwitchState } from '@/app-layer/usecases/eval-nightly-switches';
import { ShadedRow } from '@/components/ui/shaded-row';
import { OrgEvalNightlySwitch } from './OrgEvalNightlySwitch';

const code = (chunks: ReactNode) => <code className="font-mono text-xs">{chunks}</code>;

/**
 * A link on a line of its own: the text is 17px tall, so on a touch screen it
 * answers a 44px square (`TOUCH_HIT_AREA_CLASS`, #5924). The constant comes
 * from the shared module rather than `TextLink`, which is a client module:
 * this card ships no JavaScript.
 */
function ExternalLink({ href, children, testId }: { href: string; children: ReactNode; testId: string }) {
    return (
        <a
            className={cn('relative text-sm text-content-link underline-offset-2 hover:underline', TOUCH_HIT_AREA_CLASS)}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={testId}
        >
            {children}
        </a>
    );
}

function NightlyEntry({
    nightly,
    state,
    canSwitch,
    formatDateTime,
}: {
    nightly: EvalNightly;
    state: EvalNightlySwitchState;
    canSwitch: boolean;
    formatDateTime: (iso: string) => string;
}) {
    const t = useTranslations('org.settings.evaluations');
    const id = `org-evals-${nightly.key}`;
    const budget = t(`${nightly.key}.budget`, {
        amount: formatEvalUsd(nightly.budgetUsd),
        cap: nightly.sharedCapUsd === null ? '' : formatEvalUsd(nightly.sharedCapUsd),
        decision: nightly.budgetDecision,
    });
    const since =
        state.changedAt === null
            ? t('state.neverSwitched')
            : t(state.enabled ? 'state.onSince' : 'state.offSince', { when: formatDateTime(state.changedAt) });

    return (
        <ShadedRow as="li" data-testid={id} data-enabled={state.enabled ? 'true' : 'false'}>
            {/* Wraps: at 360px the name and the badge did not fit one line,
                and the badge ran past the screen edge (#5924). */}
            <div className="flex flex-wrap items-center gap-compact">
                <span className="font-medium text-content-emphasis">{t(`${nightly.key}.name`)}</span>
                <span className="ml-auto" data-testid={`${id}-badge`}>
                    <StatusBadge variant={state.enabled ? 'success' : 'neutral'} size="sm">
                        {t(state.enabled ? 'badge.on' : 'badge.off')}
                    </StatusBadge>
                </span>
            </div>
            <dl className="mt-2 space-y-tight text-sm">
                <div className="grid gap-tight sm:grid-cols-[10rem_1fr]">
                    <dt className="text-content-muted">{t('labels.tests')}</dt>
                    <dd>{t(`${nightly.key}.tests`)}</dd>
                </div>
                <div className="grid gap-tight sm:grid-cols-[10rem_1fr]">
                    <dt className="text-content-muted">{t('labels.schedule')}</dt>
                    <dd>{t('schedule', { time: nightly.scheduleUtc })}</dd>
                </div>
                <div className="grid gap-tight sm:grid-cols-[10rem_1fr]">
                    <dt className="text-content-muted">{t('labels.budget')}</dt>
                    <dd>{budget}</dd>
                </div>
                <div className="grid gap-tight sm:grid-cols-[10rem_1fr]">
                    <dt className="text-content-muted">{t('labels.state')}</dt>
                    <dd data-testid={`${id}-since`}>{since}</dd>
                </div>
                <div className="grid gap-tight sm:grid-cols-[10rem_1fr]">
                    <dt className="text-content-muted">{t('labels.switch')}</dt>
                    <dd data-testid={`${id}-switch`}>
                        {canSwitch ? (
                            <OrgEvalNightlySwitch nightly={nightly.key} initialEnabled={state.enabled} budget={budget} />
                        ) : (
                            t('switchHeldByOperator')
                        )}
                    </dd>
                </div>
                <div className="grid gap-tight sm:grid-cols-[10rem_1fr]">
                    <dt className="text-content-muted">{t('labels.key')}</dt>
                    <dd>
                        {t.rich('key', { dedicated: nightly.dedicatedKeySecret, shared: EVAL_SHARED_KEY_SECRET, code })}
                    </dd>
                </div>
                <div className="grid gap-tight sm:grid-cols-[10rem_1fr]">
                    <dt className="text-content-muted">{t('labels.runs')}</dt>
                    <dd>
                        <ExternalLink href={evalWorkflowRunsUrl(nightly.workflowFile)} testId={`${id}-runs-link`}>
                            {t('runsLink', { workflow: nightly.workflowFile })}
                        </ExternalLink>
                    </dd>
                </div>
            </dl>
        </ShadedRow>
    );
}

/**
 * `formatDateTime` is the reader's-locale helper the page takes from
 * `getDateFormatters()`: a server component renders outside the tree that
 * binds the ambient date locale, so it must not use the bare helpers.
 */
export function OrgEvaluationsCard({
    switches,
    formatDateTime,
}: {
    switches: EvalNightlySwitches;
    formatDateTime: (iso: string) => string;
}) {
    const t = useTranslations('org.settings.evaluations');
    return (
        <Card data-testid="org-evaluations">
            <div className="space-y-default">
                <div>
                    <Heading level={2} className="mb-1">{t('title')}</Heading>
                    <p className="text-sm text-content-muted">{t('description')}</p>
                </div>

                {!switches.canSwitch && (
                    <InlineNotice variant="info" icon={null}>
                        <span data-testid="org-evals-read-only">{t('readOnly')}</span>
                    </InlineNotice>
                )}

                <ul className="list-disc space-y-tight pl-5 text-sm text-content-default">
                    <li>{t('shared.offByDefault')}</li>
                    <li>{t('shared.failClosed')}</li>
                    <li>{t('shared.manualRun')}</li>
                    <li>{t.rich('shared.key', { shared: EVAL_SHARED_KEY_SECRET, code })}</li>
                </ul>

                <ul className="space-y-default">
                    {EVAL_NIGHTLIES.map((nightly) => (
                        <NightlyEntry
                            key={nightly.key}
                            nightly={nightly}
                            state={switches.nightlies[nightly.key]}
                            canSwitch={switches.canSwitch}
                            formatDateTime={formatDateTime}
                        />
                    ))}
                </ul>
            </div>
        </Card>
    );
}
