'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';

import type { AgentTabProps } from './types';

/**
 * WHAT THIS AGENT CAN BE TAUGHT — the Flue skill corpus (#3470).
 *
 * Read-only, and it takes no `onChanged`: nothing here writes. A skill is a
 * reviewed Markdown document in the repository; changing one is a pull
 * request, not a form.
 *
 * ── THE CLAIM THIS PANEL MAKES, AND THE ONE IT REFUSES TO ───────────────────
 *
 * It lists the CORPUS — every skill the product ships — not "the skills this
 * agent used". An agent does not declare skills; a workflow definition does,
 * and a run loads what its definition asked for. A per-agent subset would mean
 * inventing a binding that does not exist, and on a compliance surface an
 * invented binding is worse than a broader true statement.
 *
 * So the notice says it plainly, and each row names the workflow definitions
 * that declare it. A skill with no declaring workflow is shipped and unused —
 * visible rather than hidden, because "we ship expertise nothing loads" is
 * itself worth seeing.
 *
 * ── WHY THE CATALOGUE NUMBER IS ON SCREEN ───────────────────────────────────
 *
 * Skills are progressively disclosed: every mounted skill costs its name and
 * description in EVERY system prompt on EVERY turn, while its instructions
 * cost nothing until the model activates it. That per-turn cost is what bounds
 * how many skills a workflow may mount, and it is invisible everywhere else.
 *
 * ── REFUSED SKILLS ARE SHOWN, BY RULE ID ONLY (#3667) ───────────────────────
 *
 * A skill the load-time text scan refused is on disk and cannot be mounted; a
 * run whose workflow declares it fails closed. The panel lists it with the rule
 * ids that fired and the workflows it now stops. Its text never reaches this
 * page — the payload does not carry it — because the text is what is under
 * suspicion, and a review surface that rendered it would deliver it.
 */
interface SkillRow {
    name: string;
    description: string;
    license: string;
    sourceRef: string | null;
    version: string | null;
    declaredBy: string[];
    instructionBytes: number;
}
interface RefusedRow {
    name: string;
    rules: string[];
    guardRules: string[];
    declaredBy: string[];
}
interface Payload {
    skills: SkillRow[];
    refused?: RefusedRow[];
    catalogBytes: number;
    catalogBudgetBytes: number;
}

export function SkillsTab({ agentId, refreshToken }: AgentTabProps) {
    const t = useTranslations('agents.skills');
    const { data, error, isLoading, mutate } = useTenantSWR<Payload>('/admin/agents/skills');
    useEffect(() => { void mutate(); }, [refreshToken, mutate]);

    if (isLoading) return <SkeletonCard />;
    if (error) return <ErrorState title={t('loadFailed')} onRetry={() => { void mutate(); }} />;
    if (!data) return <SkeletonCard />;

    const refused = data.refused ?? [];
    if (data.skills.length === 0 && refused.length === 0) {
        return <InlineEmptyState title={t('empty.title')} description={t('empty.description')} />;
    }

    return (
        <div className="space-y-section" data-testid={`agent-skills-${agentId}`}>
            <InlineNotice variant="info" title={t('scope.title')}>
                {t('scope.description')}
            </InlineNotice>

            <p className="text-content-muted text-xs">
                {t('catalogCost', { used: data.catalogBytes, budget: data.catalogBudgetBytes })}
            </p>

            {refused.length > 0 ? (
                <div className="space-y-compact" data-testid="agent-skills-refused">
                    <InlineNotice variant="error" title={t('refused.title')}>
                        {t('refused.description')}
                    </InlineNotice>
                    {refused.map((r) => (
                        <Card key={r.name} className="space-y-tight p-4">
                            <div className="flex items-start justify-between gap-compact">
                                <Heading level={3} className="text-sm">{r.name}</Heading>
                                <StatusBadge variant="error">{t('refused.badge')}</StatusBadge>
                            </div>
                            <dl className="text-content-muted grid grid-cols-2 gap-x-default gap-y-tight text-xs">
                                <dt>{t('refused.rules')}</dt>
                                <dd>{[...r.rules, ...r.guardRules].join(', ')}</dd>
                                <dt>{t('refused.stops')}</dt>
                                <dd>{r.declaredBy.length > 0 ? r.declaredBy.join(', ') : t('declaredByNone')}</dd>
                            </dl>
                        </Card>
                    ))}
                </div>
            ) : null}

            <div className="space-y-compact">
                {data.skills.map((s) => (
                    <Card key={s.name} className="space-y-tight p-4">
                        <div className="flex items-start justify-between gap-compact">
                            <Heading level={3} className="text-sm">{s.name}</Heading>
                            <StatusBadge variant={s.declaredBy.length > 0 ? 'success' : 'neutral'}>
                                {s.declaredBy.length > 0
                                    ? t('declaredBy', { keys: s.declaredBy.join(', ') })
                                    : t('declaredByNone')}
                            </StatusBadge>
                        </div>
                        <p className="text-content-default text-sm">{s.description}</p>
                        <dl className="text-content-muted grid grid-cols-2 gap-x-default gap-y-tight text-xs">
                            <dt>{t('field.licence')}</dt>
                            <dd>{s.license}</dd>
                            {s.sourceRef ? (<><dt>{t('field.source')}</dt><dd>{s.sourceRef}</dd></>) : null}
                            {s.version ? (<><dt>{t('field.version')}</dt><dd>{s.version}</dd></>) : null}
                            <dt>{t('field.onActivation')}</dt>
                            <dd>{t('bytes', { n: s.instructionBytes })}</dd>
                        </dl>
                    </Card>
                ))}
            </div>
        </div>
    );
}
