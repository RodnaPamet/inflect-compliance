'use client';

/**
 * The flow editor's page frame: breadcrumbs back to the agent and its canvas
 * view, and the editor, or — for an agent with no profile version yet — where
 * the first version is written (the Behaviour tab: a flow version carries the
 * instructions and settings of the version it edits, so there must be one).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { InlineNotice } from '@/components/ui/inline-notice';
import { AgentFlowEditor, type AgentFlowEditorProps } from '@/components/processes/agent-flow/AgentFlowEditor';

export function AgentFlowClient({
    tenantSlug,
    agentId,
    agentName,
    editor,
}: {
    tenantSlug: string;
    agentId: string;
    agentName: string;
    editor: AgentFlowEditorProps | null;
}) {
    const t = useTranslations('agentFlow');
    const tAdmin = useTranslations('admin');
    const tAgents = useTranslations('agents');
    return (
        <EntityDetailLayout
            back={{ smart: true }}
            breadcrumbs={[
                { label: tAdmin('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                { label: tAgents('register.breadcrumb'), href: `/t/${tenantSlug}/agents` },
                { label: agentName, href: `/t/${tenantSlug}/agents/${agentId}` },
                { label: t('crumb') },
            ]}
            title={t('title', { name: agentName })}
        >
            {editor === null ? (
                <InlineNotice variant="info" data-testid="agent-flow-no-version">
                    {t('noVersion')}{' '}
                    <Link className="underline" href={`/t/${tenantSlug}/agents/${agentId}`}>
                        {t('openBehaviour')}
                    </Link>
                </InlineNotice>
            ) : (
                <AgentFlowEditor {...editor} />
            )}
        </EntityDetailLayout>
    );
}
