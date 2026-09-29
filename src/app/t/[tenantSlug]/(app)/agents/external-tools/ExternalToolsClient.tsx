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

import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge } from '@/components/ui/status-badge';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';

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
    /**
     * Whether the SERVER declares this tool as one that may write (#2861).
     *
     * Derived server-side through `declaresWrite`, the one definition the
     * dispatch and the pairing setter also use -- so what an operator is shown
     * here and what the funnel actually does cannot disagree about which tools
     * write. Three copies of that predicate would be three chances to differ,
     * and the one that mattered would be the quiet one.
     */
    declaresWrite: boolean;
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
    const tenantHref = useTenantHref();

    const [connectionId, setConnectionId] = useState<string>(connections[0]?.id ?? '');
    const [tools, setTools] = useState<CatalogueTool[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    /**
     * Write tool -> the READ nominated to capture what it replaces (#2861).
     *
     * The dispatch REFUSES a write with no pairing, so this map is the
     * difference between a write tool that works and one that is permanently
     * inert. Until this control existed the only way to create an entry was a
     * hand-written request -- the same gap that made #2921's approval API
     * unusable, on the same page.
     */
    const [pairings, setPairings] = useState<Record<string, string>>({});

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

            // The pairings, in the SAME pass. A separate refresh for them would
            // let the two lists disagree on screen, and the one an operator acts
            // on is whichever they happened to look at last.
            //
            // A failure here deliberately does NOT set `error`: the catalogue
            // loaded, and blanking the tool list because a secondary read failed
            // would hide the thing the page is for. The controls then show
            // "none", which is also what they show when there genuinely are
            // none -- the one place this page is imprecise, accepted because the
            // correction is a reload and the alternative is worse.
            try {
                const pr = await fetch(
                    apiUrl(`/admin/external-prior-state-read/${encodeURIComponent(connectionId)}`),
                );
                if (pr.ok) {
                    const body = await pr.json();
                    const next: Record<string, string> = {};
                    for (const row of body.pairings ?? []) next[row.writeToolName] = row.readToolName;
                    setPairings(next);
                }
            } catch {
                setPairings({});
            }
        } catch {
            setError(t('externalTools.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, connectionId, t]);

    /**
     * Nominate, or withdraw, the READ that runs before a write.
     *
     * An empty `readToolName` means WITHDRAW. One control rather than a picker
     * plus a delete button, because the two are the same decision -- and
     * splitting them invites a state where a half-set pairing is representable.
     */
    const setPairing = useCallback(
        async (writeToolName: string, readToolName: string) => {
            setBusy(writeToolName);
            setError(null);
            try {
                const path = apiUrl(
                    `/admin/external-prior-state-read/${encodeURIComponent(connectionId)}`,
                );
                const res = await fetch(path, {
                    method: readToolName ? 'PUT' : 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(readToolName ? { writeToolName, readToolName } : { writeToolName }),
                });
                if (!res.ok) {
                    // The SERVER's sentence. Every refusal the setter raises
                    // names something specific and fixable -- a read on the
                    // wrong connection, a write nominated as the read -- and a
                    // generic failure would send an operator looking for a bug
                    // instead of correcting the choice.
                    const body = await res.json().catch(() => null);
                    setError(body?.error?.message ?? body?.error ?? t('externalTools.pairingFailed'));
                    return;
                }
                setPairings((prev) => {
                    const next = { ...prev };
                    if (readToolName) next[writeToolName] = readToolName;
                    else delete next[writeToolName];
                    return next;
                });
            } catch {
                setError(t('externalTools.pairingFailed'));
            } finally {
                setBusy(null);
            }
        },
        [apiUrl, connectionId, t],
    );

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
                        {/* THE INBOUND LINK to the write ladder for this
                            connection (#2861), and it is load-bearing rather
                            than convenience.

                            `agentic-route-inbound-links` states the defect it
                            exists for: "A route with no inbound link is not a
                            feature with a discoverability problem. It is a
                            feature nobody can use, and it looks identical in CI
                            to one that works." The write-policy route is
                            OWNER-only and reached from nowhere else, so without
                            this the rung could only be set by hand — which is
                            defect #3 of the 2026-09-26 chain repeating, where
                            the approval API on THIS page shipped with no UI at
                            all.

                            Rendered for every reader, not gated on the owner
                            permission. The page behind it carries its own
                            `RequirePermission` with an owner-specific message; a
                            link hidden from an ADMIN would leave them unable to
                            discover that the setting exists or who can change
                            it, which is a worse answer than a clear refusal. */}
                        {connectionId && (
                            // `Link` + `buttonVariants`, not `<Button href>` —
                            // the Button primitive renders a <button> and takes
                            // no href. This is the repo's idiom for a navigating
                            // control (see ReadinessOverviewClient), and it
                            // matters beyond styling: a real anchor is
                            // middle-clickable, focusable in document order and
                            // announced as a link.
                            <Link
                                href={tenantHref(`/admin/external-write-policy/${connectionId}`)}
                                id="external-tools-write-policy-link"
                                className={buttonVariants({ variant: 'secondary' })}
                            >
                                {t('externalTools.writePolicyLink')}
                            </Link>
                        )}
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
                                // The reads an operator may nominate: this
                                // server's own read-only tools. The SAME list
                                // for every write on the connection, because the
                                // setter refuses a read from a different server
                                // -- prior state read from another system is not
                                // merely useless, it is a plausible-looking
                                // record of the wrong object, and the journal
                                // presents it as authoritative.
                                const readTools = tools.filter((x) => !x.declaresWrite);
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

                                        {/* ── THE PRIOR-STATE PAIRING (#2861, #2982) ──
                                            Only for tools the server declares as
                                            writes. A read has nothing to capture,
                                            and offering the control there would
                                            imply a governed write path where there
                                            is none -- the setter refuses that too.

                                            A native <select> rather than the
                                            <Combobox> primitive: the options are
                                            a handful of tool names on one
                                            connection, and Combobox exists for
                                            lists long enough to need searching.
                                            It also keeps this off the
                                            primary-button budget, which a
                                            page-defining action should own rather
                                            than a per-row setting. */}
                                        {tool.declaresWrite && (
                                            <div
                                                className="flex flex-wrap items-center gap-tight rounded border border-border-subtle p-2"
                                                data-testid={`prior-state-pairing-${tool.advertisedName}`}
                                            >
                                                <label
                                                    className="text-xs text-content-muted"
                                                    htmlFor={`prior-state-${tool.advertisedName}`}
                                                >
                                                    {t('externalTools.priorStateLabel')}
                                                </label>
                                                <select
                                                    id={`prior-state-${tool.advertisedName}`}
                                                    className="rounded border border-border-subtle bg-bg-default px-2 py-1 text-xs text-content-emphasis"
                                                    value={pairings[tool.toolName] ?? ''}
                                                    disabled={busy === tool.toolName}
                                                    onChange={(e) => void setPairing(tool.toolName, e.target.value)}
                                                >
                                                    <option value="">{t('externalTools.priorStateNone')}</option>
                                                    {readTools.map((r) => (
                                                        <option key={r.toolName} value={r.toolName}>
                                                            {r.advertisedName}
                                                        </option>
                                                    ))}
                                                </select>
                                                {/* An unpaired write is REFUSED by the
                                                    dispatch. Saying so here is the
                                                    difference between a control an
                                                    operator understands and one they
                                                    discover through a failed run. */}
                                                {!pairings[tool.toolName] && (
                                                    <span className="text-xs text-content-warning">
                                                        {t('externalTools.priorStateMissing')}
                                                    </span>
                                                )}
                                            </div>
                                        )}

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
