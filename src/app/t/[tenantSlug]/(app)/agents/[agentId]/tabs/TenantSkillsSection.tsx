'use client';

/**
 * THE SKILLS THIS WORKSPACE AUTHORED (#3680, step 4c) — the half of the Skills
 * tab that is not read-only.
 *
 * Every member the tab admits sees the list: each skill's version in service,
 * its licence and source, the workflows it mounts on, any version open for
 * review, and — for a version the skill text scan refuses — the rule ids and
 * never the text. Only a holder of `admin.agent_skill_review` gets controls:
 * a new skill, and a review sheet per skill. The server is the authority for
 * every act; the controls only decide what is worth offering.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';

import { TenantSkillEditorModal, type TenantSkillEditorTarget } from './TenantSkillEditorModal';
import { TenantSkillSheet } from './TenantSkillSheet';

export interface TenantSkillRow {
    id: string;
    name: string;
    inService: {
        versionId: string;
        version: number;
        license: string;
        sourceRef: string;
        description: string | null;
        workflowKeys: string[];
        instructionBytes: number;
        mount: { ok: true } | { ok: false; reason: string };
    } | null;
    open: { versionId: string; version: number; status: 'DRAFT' | 'IN_REVIEW' } | null;
    refused: { rules: string[]; guardRules: string[] } | null;
}

export function TenantSkillsSection({
    skills,
    workflows,
    canReview,
    onChanged,
}: {
    skills: readonly TenantSkillRow[];
    workflows: readonly { key: string; name: string }[];
    canReview: boolean;
    onChanged: () => void;
}) {
    const t = useTranslations('agents.skills');
    const [editing, setEditing] = useState<TenantSkillEditorTarget | null>(null);
    const [reviewing, setReviewing] = useState<string | null>(null);

    return (
        <section className="space-y-compact" data-testid="agent-skills-tenant">
            <div className="flex items-start justify-between gap-compact">
                <Heading level={2} className="text-base">{t('tenant.title')}</Heading>
                {canReview ? (
                    // Secondary, as the harness tab's card trigger is: a card
                    // action inside a tab, not the page's defining action, and
                    // the product-wide primary ceiling has no slot to spend on
                    // it (`primary-secondary-ratio`).
                    <Button
                        variant="secondary"
                        size="sm"
                        icon={<Plus />}
                        data-testid="tenant-skill-new"
                        onClick={() => setEditing({})}
                    >
                        {t('tenant.newSkill')}
                    </Button>
                ) : null}
            </div>
            <InlineNotice variant="info" title={t('tenant.title')}>
                {t('tenant.description')}
            </InlineNotice>

            {skills.length === 0 ? (
                <p className="text-content-muted text-sm" data-testid="agent-skills-tenant-empty">{t('tenant.empty')}</p>
            ) : (
                skills.map((s) => (
                    <Card key={s.id} className="space-y-tight p-4" data-testid={`tenant-skill-${s.name}`}>
                        <div className="flex flex-wrap items-start justify-between gap-compact">
                            <Heading level={3} className="text-sm">{s.name}</Heading>
                            <div className="flex flex-wrap items-center gap-tight">
                                {s.refused ? <StatusBadge variant="error">{t('tenant.refusedBadge')}</StatusBadge> : null}
                                <StatusBadge variant={s.inService ? 'success' : 'neutral'}>
                                    {s.inService ? t('tenant.inService', { version: s.inService.version }) : t('tenant.notInService')}
                                </StatusBadge>
                                {s.open ? (
                                    <StatusBadge variant="info">
                                        {s.open.status === 'IN_REVIEW'
                                            ? t('tenant.openInReview', { version: s.open.version })
                                            : t('tenant.openDraft', { version: s.open.version })}
                                    </StatusBadge>
                                ) : null}
                            </div>
                        </div>
                        {s.refused ? (
                            <p className="text-content-error text-xs" data-testid={`tenant-skill-${s.name}-refused`}>
                                {t('tenant.refusedRules', { rules: [...s.refused.rules, ...s.refused.guardRules].join(', ') })}
                            </p>
                        ) : null}
                        {s.inService ? (
                            <>
                                {s.inService.description !== null ? (
                                    <p className="text-content-default text-sm">{s.inService.description}</p>
                                ) : null}
                                <dl className="text-content-muted grid grid-cols-2 gap-x-default gap-y-tight text-xs">
                                    <dt>{t('field.licence')}</dt>
                                    <dd>{s.inService.license}</dd>
                                    <dt>{t('field.source')}</dt>
                                    <dd>{s.inService.sourceRef}</dd>
                                    <dt>{t('tenant.mountsOn')}</dt>
                                    <dd>
                                        {s.inService.workflowKeys.length > 0
                                            ? s.inService.workflowKeys.join(', ')
                                            : t('tenant.mountsOnNone')}
                                    </dd>
                                    <dt>{t('field.onActivation')}</dt>
                                    <dd>{t('bytes', { n: s.inService.instructionBytes })}</dd>
                                </dl>
                                {!s.inService.mount.ok ? (
                                    <p className="text-content-error text-xs">
                                        {t('tenant.mountRefused', { reason: s.inService.mount.reason })}
                                    </p>
                                ) : null}
                            </>
                        ) : null}
                        {canReview ? (
                            <div className="flex justify-end">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    data-testid={`tenant-skill-review-${s.name}`}
                                    onClick={() => setReviewing(s.id)}
                                >
                                    {t('tenant.review')}
                                </Button>
                            </div>
                        ) : null}
                    </Card>
                ))
            )}

            {canReview && reviewing ? (
                <TenantSkillSheet
                    skillId={reviewing}
                    onClose={() => setReviewing(null)}
                    onChanged={onChanged}
                    onEdit={(target) => {
                        setReviewing(null);
                        setEditing(target);
                    }}
                />
            ) : null}
            {canReview && editing ? (
                <TenantSkillEditorModal
                    target={editing}
                    workflows={workflows}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        onChanged();
                    }}
                />
            ) : null}
        </section>
    );
}
