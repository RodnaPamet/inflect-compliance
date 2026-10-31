'use client';

/* RQ-5 — Risk hierarchy: org trees with recursive ALE roll-up + treemap. */
import { useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { InfoTooltip } from '@/components/ui/tooltip';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ProgressBar } from '@/components/ui/progress-bar';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useTenantApiUrl, useTenantHref, useMoneyFormatter, useTenantContext } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTranslations } from 'next-intl';
import { RiskPicker } from '../_shared/RiskPicker';
import { AnalyticsState } from '../_shared/AnalyticsState';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { apiErrorMessage } from '@/lib/api-error';

interface Agg {
    nodeId: string;
    nodeName: string;
    riskCount: number;
    totalAle: number;
    /** #4772 — the risks attached to this node itself. */
    risks?: Array<{ id: string; title: string }>;
    children: Agg[];
}

function flattenNodes(nodes: Agg[], depth = 0, out: ComboboxOption[] = []): ComboboxOption[] {
    for (const n of nodes) {
        out.push({ value: n.nodeId, label: `${'— '.repeat(depth)}${n.nodeName}` });
        if (n.children.length) flattenNodes(n.children, depth + 1, out);
    }
    return out;
}
const TYPES = [
    { value: 'BUSINESS_UNIT', labelKey: 'hierarchy.typeBusinessUnit' },
    { value: 'GEOGRAPHY', labelKey: 'hierarchy.typeGeography' },
    { value: 'ASSET_CLASS', labelKey: 'hierarchy.typeAssetClass' },
    { value: 'CUSTOM', labelKey: 'hierarchy.typeCustom' },
] as const;

/** The message for a failed write: the server's reason, or the fallback for an outage. */
async function failureOf(res: Response | null, fallback: string): Promise<string> {
    if (!res || res.status >= 500) return fallback;
    const body: unknown = await res.json().catch(() => null);
    return apiErrorMessage(body, fallback);
}

function TreeRow({
    node, depth, total, onRename, onDelete, onUnlink, canEdit,
}: {
    node: Agg; depth: number; total: number;
    onRename: (nodeId: string, name: string) => Promise<string | null>;
    onDelete: (node: Agg) => void;
    onUnlink: (nodeId: string, riskId: string) => void;
    canEdit: boolean;
}) {
    const money = useMoneyFormatter();
    const t = useTranslations('risks');
    const tenantHref = useTenantHref();
    const [renaming, setRenaming] = useState(false);
    const [draft, setDraft] = useState(node.nodeName);
    const [renameError, setRenameError] = useState<string | null>(null);
    const [showRisks, setShowRisks] = useState(false);
    const ownRisks = node.risks ?? [];
    // #4772 — the editor closes only once the rename landed; a failed rename
    // used to revert the name silently.
    const saveRename = async () => {
        if (!draft.trim()) return;
        const failure = await onRename(node.nodeId, draft.trim());
        if (failure) setRenameError(failure);
        else { setRenameError(null); setRenaming(false); }
    };
    return (
        <>
            <div className="flex flex-wrap items-center gap-default py-tight text-sm" style={{ paddingLeft: `${depth * 16}px` }} data-testid={`node-row-${node.nodeId}`}>
                {canEdit && renaming ? (
                    <span className="flex w-full sm:w-48 items-center gap-tight">
                        <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 py-0" aria-label={t('hierarchy.rename')} />
                        <Button size="sm" variant="ghost" onClick={saveRename} data-testid={`node-rename-save-${node.nodeId}`}>{t('edit.save')}</Button>
                    </span>
                ) : (
                    <span className="w-full sm:w-48 truncate text-content-emphasis">{node.nodeName}</span>
                )}
                <div className="flex-1">
                    {/* #4772 — the bar is this node's share of the tree's total;
                        it used to be relative to the largest top-level node. */}
                    <ProgressBar value={node.totalAle} max={total || 1} aria-label={t('hierarchy.aleShareAria', { name: node.nodeName })} />
                </div>
                <span className="w-24 sm:w-28 text-right tabular-nums text-content-muted">{money(node.totalAle)}</span>
                <span className="w-16 text-right tabular-nums text-content-subtle">{node.riskCount}</span>
                <span className="flex justify-end gap-1">
                    {ownRisks.length > 0 && (
                        <Button size="sm" variant="ghost" onClick={() => setShowRisks((v) => !v)} aria-expanded={showRisks} data-testid={`node-risks-toggle-${node.nodeId}`}>
                            {showRisks ? t('hierarchy.hideRisks') : t('hierarchy.showRisks', { count: ownRisks.length })}
                        </Button>
                    )}
                    {/* PR-L — per-node rename / delete so a mis-created node is
                        fixable. #4772 — always visible: they used to appear only
                        on hover, which a touch screen never has. */}
                    {canEdit && (
                        <>
                            <Button size="sm" variant="ghost" onClick={() => { setDraft(node.nodeName); setRenameError(null); setRenaming((v) => !v); }} data-testid={`node-rename-${node.nodeId}`}>{t('hierarchy.rename')}</Button>
                            <Button size="sm" variant="ghost" className="text-content-error" onClick={() => onDelete(node)} data-testid={`node-delete-${node.nodeId}`}>{t('hierarchy.deleteNode')}</Button>
                        </>
                    )}
                </span>
            </div>
            {renameError && (
                <p className="text-xs text-content-error" role="alert" style={{ paddingLeft: `${depth * 16}px` }} data-testid={`node-rename-error-${node.nodeId}`}>{renameError}</p>
            )}
            {showRisks && (
                <ul className="space-y-tight pb-tight text-xs" style={{ paddingLeft: `${depth * 16 + 16}px` }} data-testid={`node-risks-${node.nodeId}`}>
                    {ownRisks.map((r) => (
                        <li key={r.id} className="flex items-center gap-tight">
                            <Link href={tenantHref(`/risks/${r.id}`)} className="text-content-default underline underline-offset-2">{r.title || r.id}</Link>
                            {canEdit && (
                                <Button size="sm" variant="ghost" onClick={() => onUnlink(node.nodeId, r.id)} data-testid={`node-unlink-${node.nodeId}-${r.id}`}>
                                    {t('hierarchy.unlinkRisk')}
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {node.children.map((c) => <TreeRow key={c.nodeId} node={c} depth={depth + 1} total={total} onRename={onRename} onDelete={onDelete} onUnlink={onUnlink} canEdit={canEdit} />)}
        </>
    );
}

export default function RiskHierarchyPage() {
    const t = useTranslations('risks');
    const apiUrl = useTenantApiUrl();
    const money = useMoneyFormatter();
    const tenantHref = useTenantHref();
    /**
     * Adding a node asserts the write tier. #4772 — renaming, deleting,
     * attaching and detaching go through routes that also take
     * `risks.edit`; gating them on the tier alone offered a custom role
     * controls the server refused.
     */
    const { permissions, appPermissions } = useTenantContext();
    const canWrite = permissions.canWrite;
    const canEdit = canWrite && (appPermissions?.risks?.edit ?? false);
    const [type, setType] = useState('BUSINESS_UNIT');
    const treeQuery = useTenantSWR<{ treemap: Agg[] }>(`/risks/hierarchy?type=${type}`);
    const treemap = treeQuery.data?.treemap ?? [];
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    // P2 — build a real tree (parentId) and attach risks to nodes so the
    // roll-up is non-empty.
    const [parentId, setParentId] = useState<string | null>(null);
    const [linkNodeId, setLinkNodeId] = useState<string | null>(null);
    const [linkRiskId, setLinkRiskId] = useState<string | null>(null);
    const [linkBusy, setLinkBusy] = useState(false);
    const [linkMsg, setLinkMsg] = useState<{ text: string; ok: boolean } | null>(null);
    const [nodeError, setNodeError] = useState<string | null>(null);

    const load = () => treeQuery.mutate();

    const nodeOptions = flattenNodes(treemap);

    /**
     * B2-1 — node writes (add / rename / delete) go through one mutation on
     * the hierarchy key. #4772 — it throws the server's reason for a client
     * error, which each caller shows where the write happened.
     */
    const nodeMutation = useTenantMutation<unknown, { path: string; method: string; body?: unknown }, unknown>({
        key: '/risks/hierarchy',
        mutationFn: async ({ path, method, body }) => {
            const res = await fetch(apiUrl(path), {
                method,
                ...(body === undefined
                    ? {}
                    : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
            }).catch(() => null);
            if (!res || !res.ok) throw new Error(await failureOf(res, t('hierarchy.nodeSaveError')));
            return res.json().catch(() => ({}));
        },
    });
    const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : t('hierarchy.nodeSaveError'));

    const addNode = async () => {
        if (!name.trim()) return;
        setBusy(true);
        setNodeError(null);
        try {
            await nodeMutation.trigger({
                path: '/risks/hierarchy',
                method: 'POST',
                body: { name: name.trim(), type, parentId },
            });
            // Only after the write landed — a failed add keeps the name.
            setName(''); setParentId(null);
        } catch (e) {
            setNodeError(messageOf(e));
        } finally { setBusy(false); }
    };

    const writeLink = async (method: 'POST' | 'DELETE', nodeId: string, riskId: string) => {
        setLinkBusy(true); setLinkMsg(null);
        const fallback = method === 'POST' ? t('hierarchy.linkFailed') : t('hierarchy.unlinkFailed');
        try {
            const res = await fetch(apiUrl(`/risks/hierarchy/${nodeId}/links`), {
                method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ riskId }),
            }).catch(() => null);
            if (res && res.ok) {
                setLinkMsg({ text: method === 'POST' ? t('hierarchy.linkOk') : t('hierarchy.unlinkOk'), ok: true });
                if (method === 'POST') setLinkRiskId(null);
                await load();
            } else {
                setLinkMsg({ text: await failureOf(res, fallback), ok: false });
            }
        } finally { setLinkBusy(false); }
    };

    const linkRisk = async () => {
        if (!linkNodeId || !linkRiskId) return;
        await writeLink('POST', linkNodeId, linkRiskId);
    };

    const renameNode = async (nodeId: string, newName: string): Promise<string | null> => {
        try {
            await nodeMutation.trigger({ path: `/risks/hierarchy/${nodeId}`, method: 'PATCH', body: { name: newName } });
            return null;
        } catch (e) {
            return messageOf(e);
        }
    };
    const [deletingNode, setDeletingNode] = useState<Agg | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const deleteNode = async () => {
        if (!deletingNode) return;
        setDeleteError(null);
        try {
            await nodeMutation.trigger({ path: `/risks/hierarchy/${deletingNode.nodeId}`, method: 'DELETE' });
            setDeletingNode(null);
        } catch (e) {
            // The dialog stays open, with the reason in it.
            setDeleteError(messageOf(e));
        }
    };

    const total = treemap.reduce((s, n) => s + n.totalAle, 0);
    const typeOptions = TYPES.map((tt) => ({ value: tt.value, label: t(tt.labelKey) }));

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('breadcrumbRoot'), href: tenantHref('/risks') }, { label: t('hierarchy.breadcrumb') }]} />
            <Heading level={1}>{t('hierarchy.title')}</Heading>

            <Card className="space-y-default p-6">
                {/* #4772 — a radio group, so the tree shown is announced; it was
                    four plain buttons with no pressed state. */}
                <ToggleGroup
                    ariaLabel={t('hierarchy.typeLabel')}
                    options={typeOptions}
                    selected={type}
                    selectAction={(v) => setType(v)}
                />
                {canWrite && (
                <div className="flex flex-wrap items-end gap-default">
                    <label className="block flex-1"><span className="text-xs text-content-muted">{t('hierarchy.newNodeName')}</span>
                        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('hierarchy.newNodePlaceholder')} />
                    </label>
                    <label className="block w-full sm:w-48"><span className="text-xs text-content-muted">{t('hierarchy.parentLabel')}</span>
                        <Combobox
                            id="hierarchy-parent"
                            options={[{ value: '', label: t('hierarchy.parentNone') }, ...nodeOptions]}
                            selected={nodeOptions.find((o) => o.value === parentId) ?? { value: '', label: t('hierarchy.parentNone') }}
                            setSelected={(opt) => setParentId(opt && opt.value !== '' ? String(opt.value) : null)}
                            placeholder={t('hierarchy.parentNone')}
                        />
                    </label>
                    {nodeError && (
                        <span className="text-xs text-content-error" role="alert" data-testid="hierarchy-node-error">
                            {nodeError}
                        </span>
                    )}
                    <Button variant="primary" onClick={addNode} disabled={busy || !name.trim()}>{t('hierarchy.addNode')}</Button>
                </div>
                )}

                {/* P2 — attach a risk to a node so the roll-up is non-empty.
                    #4772 — detaching is done from the node's own list of
                    risks below, where you can see what is attached. */}
                {canEdit && (
                <div className="flex flex-wrap items-end gap-default border-t border-border-subtle pt-default">
                    <label className="block flex-1"><span className="text-xs text-content-muted">{t('hierarchy.linkRiskLabel')}</span>
                        <RiskPicker id="hierarchy-link-risk" value={linkRiskId} onChange={setLinkRiskId} placeholder={t('hierarchy.linkRiskPlaceholder')} />
                    </label>
                    <label className="block w-full sm:w-48"><span className="text-xs text-content-muted">{t('hierarchy.linkNodeLabel')}</span>
                        <Combobox
                            id="hierarchy-link-node"
                            options={nodeOptions}
                            selected={nodeOptions.find((o) => o.value === linkNodeId) ?? null}
                            setSelected={(opt) => setLinkNodeId(opt ? String(opt.value) : null)}
                            placeholder={t('hierarchy.linkNodePlaceholder')}
                        />
                    </label>
                    <Button variant="secondary" onClick={linkRisk} disabled={linkBusy || !linkNodeId || !linkRiskId}>{t('hierarchy.linkRisk')}</Button>
                </div>
                )}
                {linkMsg && <InlineNotice variant={linkMsg.ok ? 'success' : 'error'}>{linkMsg.text}</InlineNotice>}
            </Card>

            <Card className="space-y-default p-6">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-tight">
                        <Heading level={2}>{t('hierarchy.rollup')}</Heading>
                        <InfoTooltip title={t('hierarchy.conceptTitle')} content={t('hierarchy.conceptHelp')} />
                    </div>
                    <span className="text-sm text-content-muted">{t('hierarchy.totalAleYr', { money: money(total) })}</span>
                </div>
                <AnalyticsState
                    isLoading={treeQuery.isLoading}
                    error={treeQuery.error}
                    isEmpty={treemap.length === 0}
                    emptyText={t('hierarchy.empty')}
                    errorText={t('hierarchy.loadError')}
                >
                    <div>
                        <div className="flex items-center gap-default border-b border-border-subtle pb-tight text-xs text-content-subtle">
                            <span className="w-full sm:w-48">{t('hierarchy.colNode')}</span><span className="flex-1">{t('hierarchy.colAleShare')}</span><span className="w-24 sm:w-28 text-right">{t('hierarchy.colTotalAle')}</span><span className="w-16 text-right">{t('hierarchy.colRisks')}</span>
                        </div>
                        {treemap.map((n) => (
                            <TreeRow
                                key={n.nodeId}
                                node={n}
                                depth={0}
                                total={total}
                                onRename={renameNode}
                                onDelete={(node) => { setDeleteError(null); setDeletingNode(node); }}
                                onUnlink={(nodeId, riskId) => void writeLink('DELETE', nodeId, riskId)}
                                canEdit={canEdit}
                            />
                        ))}
                    </div>
                </AnalyticsState>
            </Card>

            <ConfirmDialog
                showModal={deletingNode !== null}
                setShowModal={(v) => { if (!v) setDeletingNode(null); }}
                tone="danger"
                title={t('hierarchy.deleteNodeTitle')}
                description={deleteError ?? t('hierarchy.deleteNodeConfirm', { name: deletingNode?.nodeName ?? '' })}
                confirmLabel={t('hierarchy.deleteNode')}
                onConfirm={deleteNode}
                onCancel={() => setDeletingNode(null)}
            />
        </div>
    );
}
