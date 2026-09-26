'use client';

/**
 * The external-tool catalogue and its approvals. Granting happens elsewhere.
 *
 * ── THIS PAGE BASELINES. IT DOES NOT GRANT ──────────────────────────────────
 *
 * Granting an external tool already has a surface, and a better one: the agent
 * detail page's Tools tab, which shows the rung each tool requires, marks a
 * grant the catalogue no longer declares as inert, offers revoke, and carries
 * the re-assessment the register does when an agent's reach changes. None of
 * that belongs in a second, thinner copy here.
 *
 * What has no surface is the BASELINE. `listAgentTools` builds the grant
 * picker as `[...MCP_TOOL_NAMES, ...externalPins]` — read from the pin table,
 * never from a live `tools/list` — so an external tool appears there only once
 * somebody has approved its definition. Its own words: "the ordering is
 * load-bearing: baseline, then grant. An unbaselined external tool is not
 * offered, and a grant cannot be made for it."
 *
 * So this page is the first half of that ordering, and the Tools tab is the
 * second. Approving here is what makes a tool appear there.
 *
 * ── WHAT IS SHOWN BEFORE AN APPROVAL IS ASKED FOR ───────────────────────────
 *
 * The description and the argument schema, in full. The whole content of an
 * approval is that a person read the text the far end will hand the model, so a
 * page that asked for approval while showing only a name would be collecting a
 * signature on an unread document. The text is rendered as data — never
 * interpreted, never markdown — because it is not ours.
 *
 * ── THE HASH TRAVELS WITH THE APPROVAL ──────────────────────────────────────
 *
 * `expectedManifestHash` is sent from the catalogue read that produced the text
 * on screen. The server re-reads the live catalogue and refuses if it moved, so
 * an approval cannot land on a definition that changed between reading and
 * clicking — a window the server's own schema comment calls out as wider here
 * than for a built-in, because the far end chooses when to change.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge } from '@/components/ui/status-badge';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import { AgentsViewsMenu } from '../AgentsViewsMenu';

interface ConnectionRow {
    id: string;
    name: string;
    lastTestStatus: string | null;
}

/** One tool as the catalogue reports it — the server's shape, not a re-model. */
interface CatalogueTool {
    toolName: string;
    advertisedName: string;
    status: string;
    blocked: boolean;
    liveDescription: string;
    liveSchema: string;
    liveManifestHash: string;
    approvedManifestHash: string | null;
    approvedAt: string | null;
    revision: number | null;
}

/**
 * Manifest status → badge tone. `unknown` falls to neutral rather than to a
 * reassuring tone: a status this build does not recognise is not a pass.
 */
const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
    APPROVED: 'success',
    UNAPPROVED: 'neutral',
    CHANGED: 'warning',
    REVOKED: 'error',
};

export function ExternalToolsClient({
    tenantSlug,
    connections,
    canReviewProposals,
    canInvestigate,
}: {
    tenantSlug: string;
    connections: readonly ConnectionRow[];
    canReviewProposals: boolean;
    canInvestigate: boolean;
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();

    const [connectionId, setConnectionId] = useState<string>(connections[0]?.id ?? '');
    const [tools, setTools] = useState<CatalogueTool[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const loadCatalogue = useCallback(async () => {
        if (!connectionId) return;
        setLoading(true);
        setError(null);
        setTools(null);
        try {
            const res = await fetch(
                apiUrl(`/admin/agents/external-tools?connectionId=${encodeURIComponent(connectionId)}`),
            );
            const data = await res.json();
            if (!res.ok) {
                // The server's own reason, when it gave one. A catalogue read
                // reaches a third party, so "it failed" without the reason
                // leaves an operator unable to tell a credential problem from
                // an unreachable server.
                setError(data?.error?.message ?? data?.error ?? t('externalTools.loadFailed'));
                return;
            }
            setTools(data.tools ?? []);
        } catch {
            setError(t('externalTools.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, connectionId, t]);

    useEffect(() => {
        void loadCatalogue();
    }, [loadCatalogue]);

    const approve = async (tool: CatalogueTool) => {
        setBusy(tool.toolName);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/agents/external-tools'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    connectionId,
                    // The name the SERVER advertises, which is what the
                    // approval endpoint keys on.
                    toolName: tool.advertisedName,
                    // From the same read that produced the text above.
                    expectedManifestHash: tool.liveManifestHash,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data?.error?.message ?? data?.error ?? t('externalTools.approveFailed'));
                return;
            }
            await loadCatalogue();
        } catch {
            setError(t('externalTools.approveFailed'));
        } finally {
            setBusy(null);
        }
    };


    const connectionOptions = connections.map((c) => ({ value: c.id, label: c.name }));

    return (
        <div className="space-y-section">
            <PageHeader
                back={{ smart: true }}
                title={t('externalTools.title')}
                description={t('externalTools.description')}
                actions={
                    <AgentsViewsMenu
                        tenantSlug={tenantSlug}
                        current="external-tools"
                        canReviewProposals={canReviewProposals}
                        canInvestigate={canInvestigate}
                    />
                }
            />

            {connections.length === 0 ? (
                <EmptyState
                    title={t('externalTools.noConnectionsTitle')}
                    description={t('externalTools.noConnectionsDesc')}
                />
            ) : (
                <>
                    <div className="flex flex-wrap items-end gap-default">
                        <div className="w-full sm:w-64">
                            <FormField label={t('externalTools.connectionLabel')}>
                                <Combobox
                                    id="external-tools-connection"
                                    options={connectionOptions}
                                    selected={connectionOptions.find((o) => o.value === connectionId) ?? null}
                                    setSelected={(o) => o && setConnectionId(String(o.value))}
                                />
                            </FormField>
                        </div>
                        <Button variant="secondary" onClick={() => void loadCatalogue()} disabled={loading}>
                            {t('externalTools.refresh')}
                        </Button>
                    </div>

                    {/* Says where the other half of the ordering lives, because
                        a page that approves and never grants otherwise looks
                        like it is missing a button. */}
                    <p className="text-sm text-content-muted">{t('externalTools.grantHint')}</p>

                    {error && <p className="text-sm text-content-error">{error}</p>}

                    {loading && <p className="text-sm text-content-muted">{t('externalTools.loading')}</p>}

                    {/* An empty catalogue and a catalogue not yet read are
                        different facts, so only a completed read renders the
                        empty state. */}
                    {!loading && tools !== null && tools.length === 0 && (
                        <EmptyState
                            title={t('externalTools.emptyTitle')}
                            description={t('externalTools.emptyDesc')}
                        />
                    )}

                    {!loading && tools !== null && tools.length > 0 && (
                        <ol className={cn(cardVariants({ density: 'none' }), 'divide-y divide-border-subtle')}>
                            {tools.map((tool) => {
                                const approved = tool.approvedManifestHash === tool.liveManifestHash;
                                return (
                                    <li key={tool.toolName} className="space-y-tight p-4">
                                        <div className="flex flex-wrap items-center gap-tight">
                                            <StatusBadge variant={STATUS_VARIANT[tool.status] ?? 'neutral'}>
                                                {tool.status}
                                            </StatusBadge>
                                            <span className="text-sm font-medium text-content-emphasis">
                                                {tool.advertisedName}
                                            </span>
                                            {tool.revision != null && (
                                                <span className="text-xs text-content-subtle tabular-nums">
                                                    {t('externalTools.revision', { revision: tool.revision })}
                                                </span>
                                            )}
                                            <span className="ml-auto flex items-center gap-tight">
                                                <Button
                                                    variant="secondary"
                                                    size="xs"
                                                    onClick={() => void approve(tool)}
                                                    disabled={busy === tool.toolName}
                                                >
                                                    {approved
                                                        ? t('externalTools.reapprove')
                                                        : t('externalTools.approve')}
                                                </Button>
                                            </span>
                                        </div>

                                        {/* The far end's text, rendered as data. */}
                                        <p className="whitespace-pre-wrap text-sm text-content-muted">
                                            {tool.liveDescription}
                                        </p>

                                        <details>
                                            <summary className="cursor-pointer text-xs text-content-subtle">
                                                {t('externalTools.schemaLabel')}
                                            </summary>
                                            <pre className="mt-1 overflow-x-auto rounded bg-bg-subtle p-2 text-xs text-content-muted">
                                                {tool.liveSchema}
                                            </pre>
                                        </details>

                                        <div className="flex flex-wrap gap-default text-xs text-content-subtle">
                                            <code className="text-content-muted">
                                                {tool.liveManifestHash.slice(0, 12)}
                                            </code>
                                            {tool.blocked && (
                                                <span className="text-content-error">
                                                    {t('externalTools.blocked')}
                                                </span>
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </>
            )}
        </div>
    );
}
