'use client';

/**
 * The agent on the canvas: the drawing, and the same graph as a list.
 *
 * Two tabs over ONE graph (`buildAgentViewGraph`). The canvas is the drawing;
 * the Elements tab lists every node with its badges and, where it has one, the
 * reason it is narrowed — readable without a pointer, and what a screen reader
 * gets. Neither tab can change anything.
 */
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useAgentViewNodeText } from '@/components/processes/agent-view/agent-view-text';
import type { AgentCanvasProjection } from '@/lib/agentic/agent-canvas-projection';
import { buildAgentViewGraph } from '@/lib/processes/agent-view/agent-canvas-graph';

/** tldraw needs `window`; the editor loads in the browser only, inside this segment. */
const AgentCanvasView = dynamic(
    () => import('@/components/processes/agent-view/AgentCanvasView').then((m) => m.AgentCanvasView),
    { ssr: false },
);

type TabKey = 'canvas' | 'elements';

export function AgentCanvasClient({
    tenantSlug,
    projection,
}: {
    tenantSlug: string;
    projection: AgentCanvasProjection;
}) {
    const t = useTranslations('agentCanvas');
    const tAdmin = useTranslations('admin');
    const tAgents = useTranslations('agents');
    const textFor = useAgentViewNodeText();
    const [tab, setTab] = useState<TabKey>('canvas');
    const graph = useMemo(() => buildAgentViewGraph(projection), [projection]);
    const profile = projection.profile;

    return (
        <EntityDetailLayout<TabKey>
            // The agent's own page is the parent: the canvas is one view of it.
            breadcrumbs={[
                { label: tAdmin('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                { label: tAgents('register.breadcrumb'), href: `/t/${tenantSlug}/agents` },
                { label: projection.agent.name, href: `/t/${tenantSlug}/agents/${projection.agent.id}` },
                { label: t('tabCanvas') },
            ]}
            title={
                <span className="flex items-center gap-default">
                    {projection.agent.name}
                    <StatusBadge variant="neutral" data-testid="agent-canvas-readonly-badge">
                        {t('readOnly')}
                    </StatusBadge>
                </span>
            }
            tabs={[
                { key: 'canvas', label: t('tabCanvas') },
                { key: 'elements', label: t('tabElements'), count: graph.nodes.length },
            ]}
            activeTab={tab}
            onTabChange={setTab}
        >
            <div className="space-y-default">
                {profile.state !== 'SHOWN' && (
                    <InlineNotice variant="info" data-testid="agent-canvas-profile-absent">
                        {t(`profileAbsent.${profile.state}`)}
                    </InlineNotice>
                )}
                {profile.state === 'SHOWN' && !profile.inForce && (
                    <InlineNotice variant="warning" data-testid="agent-canvas-version-not-in-force">
                        {t('versionNotInForce', { version: profile.version, status: profile.status })}
                    </InlineNotice>
                )}
                <p className="text-sm text-content-muted">{t('legend')}</p>

                {tab === 'canvas' && (
                    <div
                        className="h-[70vh] min-h-96 overflow-hidden rounded-lg border border-border-default"
                        data-testid="agent-canvas-surface"
                    >
                        <AgentCanvasView projection={projection} />
                    </div>
                )}

                {tab === 'elements' && (
                    <ul className="space-y-tight" data-testid="agent-canvas-elements">
                        {graph.nodes.map((n) => {
                            const text = textFor(n);
                            return (
                                <li
                                    key={n.id}
                                    data-testid={`agent-canvas-element-${n.id}`}
                                    data-kind={n.kind}
                                    className="rounded-md border border-border-subtle px-3 py-2"
                                >
                                    <span className="text-xs uppercase text-content-subtle">{t(`kind.${n.kind}`)}</span>{' '}
                                    <span className="font-medium text-content-emphasis">{n.label}</span>
                                    {text.badges.length > 0 && (
                                        <span className="block text-xs text-content-muted">{text.badges.join(' · ')}</span>
                                    )}
                                    {text.reason !== null && (
                                        <span
                                            className="block text-xs text-content-warning"
                                            data-testid={`agent-canvas-element-reason-${n.id}`}
                                        >
                                            {text.reason}
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}

                {profile.state === 'SHOWN' && (
                    <Accordion type="single" collapsible data-testid="agent-canvas-instructions">
                        <AccordionItem value="instructions">
                            <AccordionTrigger>{t('instructions')}</AccordionTrigger>
                            <AccordionContent>
                                <p className="whitespace-pre-wrap text-sm text-content-default">{profile.instructions}</p>
                            </AccordionContent>
                        </AccordionItem>
                    </Accordion>
                )}
            </div>
        </EntityDetailLayout>
    );
}
