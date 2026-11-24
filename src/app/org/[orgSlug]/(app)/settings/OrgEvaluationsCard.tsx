/**
 * "Evaluations": the platform's two LLM evaluation nightlies, described for an
 * organization's admins (owner decision 2026-11-12).
 *
 * ═══ STATIC, ON PURPOSE ═══
 *
 * garak and Inspect run as GitHub Actions against a throwaway copy of the app
 * built on the CI runner, never against production, and each is switched by a
 * GitHub REPOSITORY variable. The product can read neither the variables nor
 * the runs, so the card shows no live state and makes no request: it says
 * what each nightly tests, when it runs, what it may spend, and where it is
 * switched, with plain links to GitHub. The facts live in
 * `@/lib/evals/evaluation-nightlies`, held to the workflow files by a test.
 *
 * A server component (no `'use client'`): it ships no JavaScript of its own.
 * The page renders it only when `evalsCardVisible` says so.
 */
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { TOUCH_HIT_AREA_CLASS } from '@inflect/ui/components/ui/hit-area';
import { cn } from '@inflect/ui/lib/cn';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import {
    EVAL_NIGHTLIES,
    EVAL_SHARED_KEY_SECRET,
    EVAL_SWITCH_ON_VALUE,
    EVALS_ACTIONS_VARIABLES_URL,
    evalWorkflowRunsUrl,
    formatEvalUsd,
    type EvalNightly,
} from '@/lib/evals/evaluation-nightlies';
import { ShadedRow } from '@/components/ui/shaded-row';

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

function NightlyEntry({ nightly }: { nightly: EvalNightly }) {
    const t = useTranslations('org.settings.evaluations');
    const id = `org-evals-${nightly.key}`;
    const budget = t(`${nightly.key}.budget`, {
        amount: formatEvalUsd(nightly.budgetUsd),
        cap: nightly.sharedCapUsd === null ? '' : formatEvalUsd(nightly.sharedCapUsd),
        decision: nightly.budgetDecision,
    });

    return (
        <ShadedRow as="li" data-testid={id}>
            {/* Wraps: at 360px the name and the badge did not fit one line,
                and the badge ran past the screen edge (#5924). */}
            <div className="flex flex-wrap items-center gap-compact">
                <span className="font-medium text-content-emphasis">{t(`${nightly.key}.name`)}</span>
                <span className="ml-auto">
                    <StatusBadge variant="neutral" size="sm">{t('offByDefault')}</StatusBadge>
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
                    <dt className="text-content-muted">{t('labels.switch')}</dt>
                    <dd data-testid={`${id}-switch`}>
                        {t.rich('switch', { name: nightly.switchVariable, value: EVAL_SWITCH_ON_VALUE, code })}
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

export function OrgEvaluationsCard() {
    const t = useTranslations('org.settings.evaluations');
    return (
        <Card data-testid="org-evaluations">
            <div className="space-y-default">
                <div>
                    <Heading level={2} className="mb-1">{t('title')}</Heading>
                    <p className="text-sm text-content-muted">{t('description')}</p>
                </div>

                <ul className="list-disc space-y-tight pl-5 text-sm text-content-default">
                    <li>{t('shared.offByDefault')}</li>
                    <li>{t('shared.manualRun')}</li>
                    <li>{t.rich('shared.key', { shared: EVAL_SHARED_KEY_SECRET, code })}</li>
                </ul>

                <ul className="space-y-default">
                    {EVAL_NIGHTLIES.map((nightly) => (
                        <NightlyEntry key={nightly.key} nightly={nightly} />
                    ))}
                </ul>

                <p className="text-sm">
                    <ExternalLink href={EVALS_ACTIONS_VARIABLES_URL} testId="org-evals-variables-link">
                        {t('variablesLink')}
                    </ExternalLink>
                </p>
            </div>
        </Card>
    );
}
