'use client';

/**
 * The agent on the canvas: the drawing, and the same graph as a list.
 *
 * Two tabs over ONE graph (`buildAgentViewGraph`). The canvas is the drawing;
 * the Elements tab lists every node with its badges and, where it has one, the
 * reason it is narrowed — readable without a pointer, and what a screen reader
 * gets. Neither tab can change anything.
 *
 * With a `diff` (Phase 2.4: the approver's comparison of the version under
 * review against the version in force), both tabs draw the diff's graph, and
 * the changes are listed in words above them, so a reviewer reads what the
 * approval would change without having to find it on the drawing.
 */
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { buttonVariants } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useAgentViewNodeText } from '@/components/processes/agent-view/agent-view-text';
import type { AgentCanvasProjection } from '@/lib/agentic/agent-canvas-projection';
import { buildAgentViewGraph } from '@/lib/processes/agent-view/agent-canvas-graph';
import type { AgentViewDiff } from '@/lib/processes/agent-view/agent-canvas-diff';

/** tldraw needs `window`; the editor loads in the browser only, inside this segment. */
const AgentCanvasView = dynamic(
    () => import('@/components/processes/agent-view/AgentCanvasView').then((m) => m.AgentCanvasView),
    { ssr: false },
);

type TabKey = 'canvas' | 'elements';

export function AgentCanvasClient({
    tenantSlug,
    projection,
    diff = null,
    compareUnavailable = false,
}: {
    tenantSlug: string;
    projection: AgentCanvasProjection;
    /** The approver's diff, when the page was asked to compare two versions. */
    diff?: AgentViewDiff | null;
    /** A comparison was asked for and there is none to draw: said, not hidden. */
    compareUnavailable?: boolean;
}) {
    const t = useTranslations('agentCanvas');
    const tAdmin = useTranslations('admin');
    const tAgents = useTranslations('agents');
    const textFor = useAgentViewNodeText();
    const [tab, setTab] = useState<TabKey>('canvas');
    const graph = useMemo(() => diff?.graph ?? buildAgentViewGraph(projection), [diff, projection]);
    const profile = projection.profile;

    return (
        <EntityDetailLayout<TabKey>
            // `smart`, as on the agent page: it goes back to wherever the
            // viewer came from (normally the agent page's "Open on canvas"),
            // and a cold load falls back to the canonical parent, `/agents`.
            back={{ smart: true }}
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
            // The editor is offered where the profile layer is shown: the
            // viewer holds the register key and profiles are on, which is
            // what the editor's page asks again (Phase 3).
            actions={
                profile.state === 'SHOWN' ? (
                    <Link
                        href={`/t/${tenantSlug}/processes/agents/${projection.agent.id}/flow`}
                        id="agent-canvas-edit-flow"
                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                    >
                        {t('editFlow')}
                    </Link>
                ) : undefined
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
                {compareUnavailable && (
                    <InlineNotice variant="warning" data-testid="agent-canvas-diff-unavailable">
                        {t('diff.unavailable')}
                    </InlineNotice>
                )}
                {diff !== null && (
                    <div className="space-y-tight" data-testid="agent-canvas-diff">
                        <p className="text-sm font-medium text-content-emphasis">
                            {t('diff.heading', { from: diff.from.version, to: diff.to.version })}
                        </p>
                        {diff.changes.length === 0 ? (
                            <p className="text-sm text-content-muted" data-testid="agent-canvas-diff-none">
                                {t('diff.none')}
                            </p>
                        ) : (
                            <ul className="space-y-tight text-sm" data-testid="agent-canvas-diff-list">
                                {diff.changes.map((c) => (
                                    <li
                                        key={`${c.aspect}:${c.change}:${c.nodeId}:${c.name ?? ''}`}
                                        data-testid={`agent-canvas-diff-${c.aspect}-${c.change}${c.name ? `-${c.name}` : ''}`}
                                        data-change={c.change}
                                    >
                                        {t(`diff.item.${c.aspect}.${c.change}`, {
                                            name: c.name ?? '',
                                            from: c.from ?? '',
                                            to: c.to ?? '',
                                        })}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
                {diff === null && profile.state === 'SHOWN' && !profile.inForce && (
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
                        <AgentCanvasView projection={projection} diff={diff} />
                    </div>
                )}

                {tab === 'elements' && (
                    <ul className="space-y-tight" data-testid="agent-canvas-elements">
                        {graph.nodes.map((n) => {
                            const text = textFor(n);
                            const change = diff?.changeOf[n.id];
                            return (
                                <li
                                    key={n.id}
                                    data-testid={`agent-canvas-element-${n.id}`}
                                    data-kind={n.kind}
                                    data-change={change ?? 'none'}
                                    className="rounded-md border border-border-subtle px-3 py-2"
                                >
                                    <span className="text-xs uppercase text-content-subtle">{t(`kind.${n.kind}`)}</span>{' '}
                                    <span className="font-medium text-content-emphasis">{n.label}</span>
                                    {change !== undefined && (
                                        <span className="block text-xs text-content-emphasis">{t(`diff.mark.${change}`)}</span>
                                    )}
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
