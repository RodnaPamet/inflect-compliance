'use client';

/**
 * The integration passport of one external agent connection (#3672).
 *
 * `docs/integration-passport.md` is the specification. This card renders what
 * `GET admin/integration-passport/{id}` returns: the passport built live from
 * the same stored rows the weekly sweep reads, what the last emission said, what
 * the next sweep would raise against it, and the connection's passport findings
 * that are still open. It writes nothing.
 *
 * ═══ OWNER-ONLY, AND GATED AT THE MOUNT ═══
 *
 * The route is `admin.tenant_lifecycle`, because the passport shows the write
 * rung and the prior-state pairings, which are OWNER reads on their own pages.
 * The page mounts this card inside `<RequirePermission tenant_lifecycle>`, so an
 * ADMIN never sends the request — a refused read writes an AUTHZ_DENIED row, and
 * one per page view is noise in the trail rather than a signal.
 *
 * ═══ A 404 OR A 403 RENDERS NOTHING ═══
 *
 * Only `mcp-server` connections have a passport, and the connection page is
 * shared by every provider. The route answers 404 for any other, so the card
 * decides whether it applies from the server's answer rather than from a
 * second copy of the provider rule here. Nothing renders while that answer is
 * outstanding either: a passport frame that appears and then vanishes on an
 * Okta connection would read as a passport that failed to load.
 *
 * ═══ IDENTIFIERS, NOT CONTENT ═══
 *
 * Everything below is a field the specification defines: ids, hashes, rung
 * names, kinds. The server sends no secret, no tool description or schema, and
 * no parameter value, so this component cannot render one even by mistake. The
 * owner's name and address are resolved for display only and are never part of
 * the passport.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { EXTERNAL_TOOL_PREFIX } from '@/lib/mcp/external-tool-name';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import type { IntegrationPassportView } from '@/app-layer/usecases/integration-passport';

type Pin = IntegrationPassportView['current']['pinnedTools'][number];
type Grant = IntegrationPassportView['current']['grantedAgents'][number];
type Pairing = IntegrationPassportView['current']['priorStatePairings'][number];
type ParameterSet = IntegrationPassportView['current']['parameterSets'][number];

type LoadState =
    | { readonly kind: 'loading' }
    | { readonly kind: 'absent' }
    | { readonly kind: 'error' }
    | { readonly kind: 'ready'; readonly view: IntegrationPassportView };

const SEVERITY_VARIANT: Record<string, StatusBadgeVariant> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'info',
};

/** How many hex characters of a digest a person needs to tell two apart. */
const SHORT_DIGEST = 12;

/**
 * `mcp__<id>__lookup` → `lookup`, wherever this connection's prefix appears (a
 * grant's change label is `<agentId>/<qualified tool>`). Display only: the
 * qualified name is the key every row is stored under, and the passport keeps
 * it whole.
 */
function displayToolName(connectionId: string, qualified: string): string {
    return qualified.split(`${EXTERNAL_TOOL_PREFIX}${connectionId}__`).join('');
}

export function IntegrationPassportCard({ connectionId }: { connectionId: string }) {
    const t = useTranslations('admin.integrations.passport');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [state, setState] = useState<LoadState>({ kind: 'loading' });

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await fetch(apiUrl(`/admin/integration-passport/${connectionId}`));
                if (res.status === 404 || res.status === 403) {
                    if (alive) setState({ kind: 'absent' });
                    return;
                }
                if (!res.ok) throw new Error(String(res.status));
                const view = (await res.json()) as IntegrationPassportView;
                if (alive) setState({ kind: 'ready', view });
            } catch {
                if (alive) setState({ kind: 'error' });
            }
        })();
        return () => { alive = false; };
    }, [apiUrl, connectionId]);

    const bare = (qualified: string) => displayToolName(connectionId, qualified);

    const pairedTools = useMemo(
        () => new Set(state.kind === 'ready' ? state.view.writeDeclarations.declaredWrite.filter((d) => d.hasPairing).map((d) => d.toolName) : []),
        [state],
    );

    const pinColumns = useMemo(
        () =>
            createColumns<Pin>([
                { id: 'tool', header: t('colTool'), accessorKey: 'toolName', cell: ({ row }) => <span className="font-mono">{displayToolName(connectionId, row.original.toolName)}</span> },
                { id: 'revision', header: t('colRevision'), accessorKey: 'revision', cell: ({ row }) => <span className="tabular-nums">{row.original.revision}</span> },
                {
                    id: 'approval', header: t('colApproval'), accessorKey: 'approvalSource',
                    cell: ({ row }) => (
                        <StatusBadge variant={row.original.approvalSource === 'APPROVED' ? 'success' : 'error'}>
                            {row.original.approvalSource === 'APPROVED' ? t('approved') : t('baseline')}
                        </StatusBadge>
                    ),
                },
                { id: 'approver', header: t('colApprover'), accessorKey: 'approvedByUserId', cell: ({ row }) => <span className="font-mono text-content-muted">{row.original.approvedByUserId ?? '—'}</span> },
                {
                    id: 'annotations', header: t('colAnnotations'), accessorKey: 'annotationsHash',
                    // Inline text, not a second badge on the row: the
                    // approval badge is the row's one loud signal.
                    cell: ({ row }) => row.original.annotationsHash === null
                        ? <span className="font-medium text-content-error">{t('annotationsUnattested')}</span>
                        : <span className="text-content-muted">{t('annotationsAttested')}</span>,
                },
                {
                    id: 'write', header: t('colWrite'), accessorKey: 'declaresWrite',
                    cell: ({ row }) => {
                        const d = row.original.declaresWrite;
                        if (d === null) return <span className="text-content-subtle">{t('writeNotRecorded')}</span>;
                        if (!d) return <span className="text-content-muted">{t('readOnly')}</span>;
                        // A write tool with no prior-state pairing is refused at
                        // dispatch; the marker says why the tool will not run.
                        return pairedTools.has(row.original.toolName)
                            ? <span>{t('writePaired')}</span>
                            : (
                                <span className="font-medium text-content-warning" data-testid={`passport-unpaired-${displayToolName(connectionId, row.original.toolName)}`}>
                                    {t('writeUnpaired')}
                                </span>
                            );
                    },
                },
            ]),
        [t, pairedTools, connectionId],
    );

    const grantColumns = useMemo(
        () =>
            createColumns<Grant>([
                { id: 'agent', header: t('colAgent'), accessorKey: 'agentId', cell: ({ row }) => <span className="font-mono">{row.original.agentId}</span> },
                { id: 'tool', header: t('colTool'), accessorKey: 'toolName', cell: ({ row }) => <span className="font-mono">{displayToolName(connectionId, row.original.toolName)}</span> },
                { id: 'grantedBy', header: t('colGrantedBy'), accessorKey: 'grantedByUserId', cell: ({ row }) => <span className="font-mono text-content-muted">{row.original.grantedByUserId}</span> },
                { id: 'createdAt', header: t('colGrantedAt'), accessorKey: 'createdAt', cell: ({ row }) => <span className="tabular-nums text-content-muted">{formatDateTime(row.original.createdAt)}</span> },
            ]),
        [t, connectionId],
    );

    const pairingColumns = useMemo(
        () =>
            createColumns<Pairing>([
                { id: 'write', header: t('colWriteTool'), accessorKey: 'writeToolName', cell: ({ row }) => <span className="font-mono">{displayToolName(connectionId, row.original.writeToolName)}</span> },
                { id: 'read', header: t('colReadTool'), accessorKey: 'readToolName', cell: ({ row }) => <span className="font-mono">{displayToolName(connectionId, row.original.readToolName)}</span> },
                { id: 'approver', header: t('colApprover'), accessorKey: 'approvedByUserId', cell: ({ row }) => <span className="font-mono text-content-muted">{row.original.approvedByUserId ?? '—'}</span> },
                { id: 'updatedAt', header: t('colUpdatedAt'), accessorKey: 'updatedAt', cell: ({ row }) => <span className="tabular-nums text-content-muted">{formatDateTime(row.original.updatedAt)}</span> },
            ]),
        [t, connectionId],
    );

    const setColumns = useMemo(
        () =>
            createColumns<ParameterSet>([
                { id: 'label', header: t('colLabel'), accessorKey: 'label', cell: ({ row }) => <span>{row.original.label}</span> },
                { id: 'tool', header: t('colTool'), accessorKey: 'toolName', cell: ({ row }) => <span className="font-mono">{displayToolName(connectionId, row.original.toolName)}</span> },
                { id: 'revision', header: t('colRevision'), accessorKey: 'revision', cell: ({ row }) => <span className="tabular-nums">{row.original.revision}</span> },
                { id: 'target', header: t('colTarget'), accessorKey: 'targetPopulation', cell: ({ row }) => <span className="font-mono text-content-muted">{row.original.targetPopulation ?? '—'}</span> },
                {
                    id: 'pending', header: t('colPending'), accessorKey: 'pending',
                    cell: ({ row }) => row.original.pending
                        ? <span className="text-content-info">{t('pendingEdit')}</span>
                        : <span className="text-content-subtle">—</span>,
                },
            ]),
        [t, connectionId],
    );

    if (state.kind === 'loading' || state.kind === 'absent') return null;

    if (state.kind === 'error') {
        return (
            <Card className="space-y-default p-6" id="integration-passport">
                <Heading level={2}>{t('title')}</Heading>
                <InlineNotice variant="error" data-testid="passport-load-error">{t('loadError')}</InlineNotice>
            </Card>
        );
    }

    const { current, lastEmitted, changes, openFindings, owner, writeDeclarations } = state.view;
    const unpaired = writeDeclarations.declaredWrite.filter((d) => !d.hasPairing).map((d) => bare(d.toolName));

    const facts: { key: string; label: string; value: ReactNode }[] = [
        {
            key: 'endpoint', label: t('fieldEndpoint'),
            // The passport holds the origin and a keyed digest, never the URL:
            // its path or query can carry a credential.
            value: current.endpoint.origin !== null
                ? (
                    <span>
                        <span className="font-mono break-all">{current.endpoint.origin}</span>
                        <span className="text-content-muted"> · {t('endpointOriginOnly')}</span>
                    </span>
                )
                : current.endpoint.urlDigest === null ? t('none') : t('endpointNotUrl'),
        },
        { key: 'enabled', label: t('fieldEnabled'), value: current.enabled ? t('enabled') : t('disabled') },
        { key: 'grant', label: t('fieldGrantKind'), value: <span className="font-mono">{current.grantKind}</span> },
        {
            key: 'scope', label: t('fieldScope'),
            value: current.scope.effective === null
                ? t('scopeNotMinted')
                : <span className="font-mono break-all">{current.scope.effective}{current.scope.defaulted ? ` ${t('scopeDefaulted')}` : ''}</span>,
        },
        {
            key: 'audience', label: t('fieldAudience'),
            value: current.audience === 'unknown'
                ? t('audienceUnknown')
                : <span className="font-mono break-all">{current.audience.join(', ')}</span>,
        },
        {
            key: 'rung', label: t('fieldWriteRung'),
            value: (
                <span>
                    <span className="font-mono">{current.writeRung.mode}</span>
                    {current.writeRung.since && <span className="text-content-muted"> · {t('since', { at: formatDateTime(current.writeRung.since) })}</span>}
                </span>
            ),
        },
        {
            key: 'validated', label: t('fieldLastValidated'),
            value: current.lastValidated.at === null
                ? <span className="text-content-warning" data-testid="passport-never-tested">{t('neverTested')}</span>
                : t('lastTest', { status: current.lastValidated.status ?? '—', at: formatDateTime(current.lastValidated.at) }),
        },
    ];

    return (
        <Card className="space-y-default p-6" id="integration-passport" data-testid="integration-passport">
            <div className="space-y-tight">
                <Heading level={2}>{t('title')}</Heading>
                <p className="text-sm text-content-muted">{t('description')}</p>
                <p className="text-xs text-content-subtle" data-testid="passport-emission">
                    <span className="font-mono">{t('digest', { digest: current.digest.slice(0, SHORT_DIGEST) })}</span>
                    {' · '}
                    {lastEmitted === null
                        ? t('neverEmitted')
                        : !lastEmitted.verified
                        ? t('emittedUnverifiableShort', { week: lastEmitted.periodLabel })
                        : lastEmitted.unchangedSince
                        ? t('emittedUnchanged', { week: lastEmitted.periodLabel })
                        : t('emittedChanged', { week: lastEmitted.periodLabel })}
                </p>
            </div>

            {lastEmitted !== null && !lastEmitted.verified && (
                <InlineNotice variant="error" data-testid="passport-prior-unverifiable">
                    {t('emittedUnverifiable', { week: lastEmitted.periodLabel, reason: lastEmitted.reason ?? '—' })}
                </InlineNotice>
            )}

            {current.owner.accountable && owner ? (
                <p className="text-sm" data-testid="passport-owner">
                    {t('ownerIs', { owner: owner.name ?? owner.email ?? owner.userId })}
                </p>
            ) : (
                <InlineNotice variant="warning" data-testid="passport-owner-missing">
                    {current.owner.userId === null ? t('ownerMissing') : t('ownerInactive')}
                </InlineNotice>
            )}

            {current.writeRung.storedUnrecognised !== null && (
                <InlineNotice variant="warning" data-testid="passport-rung-unrecognised">
                    {t('rungUnrecognised', { stored: current.writeRung.storedUnrecognised })}
                </InlineNotice>
            )}

            <dl className="grid grid-cols-1 gap-default sm:grid-cols-2" data-testid="passport-fields">
                {facts.map((f) => (
                    <div key={f.key} className="space-y-tight" data-testid={`passport-field-${f.key}`}>
                        <dt className="text-xs uppercase tracking-wide text-content-subtle">{f.label}</dt>
                        <dd className="text-sm text-content-default">{f.value}</dd>
                    </div>
                ))}
            </dl>

            <div className="space-y-tight">
                <Heading level={3}>{t('pinsTitle')}</Heading>
                {unpaired.length > 0 && (
                    <InlineNotice variant="warning" data-testid="passport-unpaired-writes">
                        {t('unpairedWrites', { tools: unpaired.join(', ') })}
                    </InlineNotice>
                )}
                {writeDeclarations.declarationNotRecorded.length > 0 && (
                    <InlineNotice variant="info" data-testid="passport-declaration-not-recorded">
                        {t('declarationNotRecorded', { tools: writeDeclarations.declarationNotRecorded.map(bare).join(', ') })}
                    </InlineNotice>
                )}
                <DataTable data={[...current.pinnedTools]} columns={pinColumns} getRowId={(r) => r.toolName} emptyState={t('pinsEmpty')} data-testid="passport-pins-table" />
            </div>

            <div className="space-y-tight">
                <Heading level={3}>{t('grantsTitle')}</Heading>
                <DataTable data={[...current.grantedAgents]} columns={grantColumns} getRowId={(r) => `${r.toolName}/${r.agentId}`} emptyState={t('grantsEmpty')} data-testid="passport-grants-table" />
            </div>

            <div className="space-y-tight">
                <Heading level={3}>{t('pairingsTitle')}</Heading>
                <DataTable data={[...current.priorStatePairings]} columns={pairingColumns} getRowId={(r) => r.writeToolName} emptyState={t('pairingsEmpty')} data-testid="passport-pairings-table" />
            </div>

            <div className="space-y-tight">
                <Heading level={3}>{t('setsTitle')}</Heading>
                <DataTable data={[...current.parameterSets]} columns={setColumns} getRowId={(r) => r.id} emptyState={t('setsEmpty')} data-testid="passport-sets-table" />
            </div>

            <div className="space-y-tight" data-testid="passport-changes">
                <Heading level={3}>{t('changesTitle')}</Heading>
                {lastEmitted === null || !lastEmitted.verified ? (
                    <p className="text-sm text-content-muted">{t('changesNoPrior')}</p>
                ) : changes.length === 0 ? (
                    <p className="text-sm text-content-muted">{t('changesNone', { week: lastEmitted.periodLabel })}</p>
                ) : (
                    <ul className="space-y-tight text-sm">
                        {changes.map((c) => (
                            <li key={`${c.code}:${c.item ?? ''}`} className="flex flex-wrap items-center gap-tight">
                                <StatusBadge variant={SEVERITY_VARIANT[c.severity] ?? 'neutral'}>{c.severity}</StatusBadge>
                                <span className="font-mono">{c.code}</span>
                                {c.item && <span className="font-mono text-content-muted">{bare(c.item)}</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="space-y-tight" data-testid="passport-findings">
                <Heading level={3}>{t('findingsTitle')}</Heading>
                {openFindings.length === 0 ? (
                    <p className="text-sm text-content-muted">{t('findingsNone')}</p>
                ) : (
                    <ul className="space-y-tight text-sm">
                        {openFindings.map((f) => (
                            <li key={f.id} className="flex flex-wrap items-center gap-tight">
                                <StatusBadge variant={SEVERITY_VARIANT[f.severity] ?? 'neutral'}>{f.severity}</StatusBadge>
                                <a className="text-content-info underline underline-offset-2" href={tenantHref(`/findings/${f.id}`)}>
                                    {f.title}
                                </a>
                                {f.assigneeUserId === null && <span className="text-content-muted">{t('findingOwnerRole')}</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Card>
    );
}
