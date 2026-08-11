'use client';

/* RQ-5 — Risk hierarchy: org trees with recursive ALE roll-up + treemap. */
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { InfoTooltip } from '@/components/ui/tooltip';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useTenantApiUrl, useTenantHref, useMoneyFormatter, useTenantContext } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTranslations } from 'next-intl';
import { RiskPicker } from '../_shared/RiskPicker';
import { AnalyticsState } from '../_shared/AnalyticsState';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';

interface Agg { nodeId: string; nodeName: string; riskCount: number; totalAle: number; children: Agg[] }

/** Flatten the roll-up tree into node options for the parent + link pickers. */
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
// RQ3-OB-A — money speaks the tenant's currency (useMoneyFormatter).

function TreeRow({
    node, depth, max, onRename, onDelete, canWrite,
}: {
    node: Agg; depth: number; max: number;
    onRename: (nodeId: string, name: string) => void;
    onDelete: (node: Agg) => void;
    /** Every node write calls assertCanWrite server-side. */
    canWrite: boolean;
}) {
    const money = useMoneyFormatter();
    const t = useTranslations('risks');
    const [renaming, setRenaming] = useState(false);
    const [draft, setDraft] = useState(node.nodeName);
    return (
        <>
            <div className="group flex items-center gap-default py-tight text-sm" style={{ paddingLeft: `${depth * 16}px` }}>
                {canWrite && renaming ? (
                    <span className="flex w-full sm:w-48 items-center gap-tight">
                        <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 py-0" />
                        <Button size="sm" variant="ghost" onClick={() => { if (draft.trim()) onRename(node.nodeId, draft.trim()); setRenaming(false); }}>{t('edit.save')}</Button>
                    </span>
                ) : (
                    <span className="w-full sm:w-48 truncate text-content-emphasis">{node.nodeName}</span>
                )}
                <div className="flex-1">
                    <ProgressBar value={node.totalAle} max={max || 1} aria-label={t('hierarchy.aleShareAria', { name: node.nodeName })} />
                </div>
                <span className="w-24 sm:w-28 text-right tabular-nums text-content-muted">{money(node.totalAle)}</span>
                <span className="w-16 text-right tabular-nums text-content-subtle">{node.riskCount}</span>
                {/* PR-L — per-node rename / delete so a mis-created node is fixable. */}
                {canWrite && (
                <span className="flex w-24 justify-end gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                    <Button size="sm" variant="ghost" onClick={() => { setDraft(node.nodeName); setRenaming((v) => !v); }} data-testid={`node-rename-${node.nodeId}`}>{t('hierarchy.rename')}</Button>
                    <Button size="sm" variant="ghost" className="text-content-error" onClick={() => onDelete(node)} data-testid={`node-delete-${node.nodeId}`}>{t('hierarchy.deleteNode')}</Button>
                </span>
                )}
            </div>
            {node.children.map((c) => <TreeRow key={c.nodeId} node={c} depth={depth + 1} max={max} onRename={onRename} onDelete={onDelete} canWrite={canWrite} />)}
        </>
    );
}

export default function RiskHierarchyPage() {
    const t = useTranslations('risks');
    const apiUrl = useTenantApiUrl();
    const money = useMoneyFormatter();
    const tenantHref = useTenantHref();
    /**
     * This page had NO permission gate. Every node write calls
     * `assertCanWrite` server-side, so for a READER or AUDITOR the Add
     * button was a guaranteed 403 on every click — and until the write
     * fixes in #1855, a silent one. Gate on the SAME coarse flag the
     * usecase asserts rather than an `appPermissions` sub-key, so the two
     * cannot drift apart.
     */
    const { permissions } = useTenantContext();
    const canWrite = permissions.canWrite;
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

    const load = () => treeQuery.mutate();

    const nodeOptions = flattenNodes(treemap);

    /**
     * B2-1 — the three NODE writes (add / rename / delete) go through a
     * mutation on the hierarchy key.
     *
     * `linkRisk` and `unlinkRisk` in this same file already check `res.ok`
     * and render an InlineNotice, which is what makes these three an
     * inconsistency rather than a convention: the error surface existed and
     * simply was not wired to them. `addNode` cleared the name and parent
     * regardless of outcome; `renameNode` and `deleteNode` had no try, no
     * busy guard and no check at all.
     *
     * Reachable, not theoretical: this page has NO permission gate, so the
     * Add button renders for READER and AUDITOR while `createNode` calls
     * `assertCanWrite` — a guaranteed 403 that, until now, produced no
     * feedback whatsoever.
     */
    const nodeMutation = useTenantMutation<unknown, { path: string; method: string; body?: unknown }, unknown>({
        key: '/risks/hierarchy',
        mutationFn: async ({ path, method, body }) => {
            const res = await fetch(apiUrl(path), {
                method,
                ...(body === undefined
                    ? {}
                    : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
            });
            if (!res.ok) throw new Error(t('hierarchy.nodeSaveError'));
            return res.json().catch(() => ({}));
        },
    });

    const addNode = async () => {
        if (!name.trim()) return;
        setBusy(true);
        try {
            await nodeMutation.trigger({
                path: '/risks/hierarchy',
                method: 'POST',
                body: { name: name.trim(), type, parentId },
            });
            // Only after it landed.
            setName(''); setParentId(null);
        } catch {
            /* visible via nodeMutation.error; the draft stays */
        } finally { setBusy(false); }
    };

    const linkRisk = async () => {
        if (!linkNodeId || !linkRiskId) return;
        setLinkBusy(true); setLinkMsg(null);
        try {
            const res = await fetch(apiUrl(`/risks/hierarchy/${linkNodeId}/links`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ riskId: linkRiskId }),
            });
            if (res.ok) { setLinkMsg({ text: t('hierarchy.linkOk'), ok: true }); setLinkRiskId(null); await load(); }
            else { setLinkMsg({ text: t('hierarchy.linkFailed'), ok: false }); }
        } catch { setLinkMsg({ text: t('hierarchy.linkFailed'), ok: false }); }
        finally { setLinkBusy(false); }
    };

    // PR-L — undo a mis-attached risk link (same pickers, DELETE method).
    const unlinkRisk = async () => {
        if (!linkNodeId || !linkRiskId) return;
        setLinkBusy(true); setLinkMsg(null);
        try {
            const res = await fetch(apiUrl(`/risks/hierarchy/${linkNodeId}/links`), {
                method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ riskId: linkRiskId }),
            });
            if (res.ok) { setLinkMsg({ text: t('hierarchy.unlinkOk'), ok: true }); setLinkRiskId(null); await load(); }
            else { setLinkMsg({ text: t('hierarchy.linkFailed'), ok: false }); }
        } catch { setLinkMsg({ text: t('hierarchy.linkFailed'), ok: false }); }
        finally { setLinkBusy(false); }
    };

    // PR-L — rename / delete a hierarchy node (updateNode / deleteNode).
    const renameNode = async (nodeId: string, newName: string) => {
        try {
            await nodeMutation.trigger({
                path: `/risks/hierarchy/${nodeId}`,
                method: 'PATCH',
                body: { name: newName },
            });
        } catch {
            /* visible via nodeMutation.error */
        }
    };
    const [deletingNode, setDeletingNode] = useState<Agg | null>(null);
    const deleteNode = async () => {
        if (!deletingNode) return;
        try {
            await nodeMutation.trigger({ path: `/risks/hierarchy/${deletingNode.nodeId}`, method: 'DELETE' });
            // Close the dialog only once the node is actually gone.
            setDeletingNode(null);
        } catch {
            /* visible via nodeMutation.error; the dialog stays open */
        }
    };

    const max = treemap.reduce((m, n) => Math.max(m, n.totalAle), 0);
    const total = treemap.reduce((s, n) => s + n.totalAle, 0);

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('breadcrumbRoot'), href: tenantHref('/risks') }, { label: t('hierarchy.breadcrumb') }]} />
            <Heading level={1}>{t('hierarchy.title')}</Heading>

            <Card className="space-y-default p-6">
                <div className="flex flex-wrap gap-tight">
                    {TYPES.map((tt) => (
                        <Button key={tt.value} size="sm" variant={type === tt.value ? 'primary' : 'secondary'} onClick={() => setType(tt.value)}>{t(tt.labelKey)}</Button>
                    ))}
                </div>
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
                    {nodeMutation.error && (
                        <span className="text-xs text-content-error" role="alert" data-testid="hierarchy-node-error">
                            {t('hierarchy.nodeSaveError')}
                        </span>
                    )}
                    <Button variant="primary" onClick={addNode} disabled={busy || !name.trim()}>{t('hierarchy.addNode')}</Button>
                </div>
                )}

                {/* P2 — attach a risk to a node so the roll-up is non-empty. */}
                {canWrite && (
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
                    <Button variant="ghost" onClick={unlinkRisk} disabled={linkBusy || !linkNodeId || !linkRiskId} data-testid="hierarchy-unlink-risk">{t('hierarchy.unlinkRisk')}</Button>
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
                        {treemap.map((n) => <TreeRow key={n.nodeId} node={n} depth={0} max={max} onRename={renameNode} onDelete={setDeletingNode} canWrite={canWrite} />)}
                    </div>
                </AnalyticsState>
            </Card>

            <ConfirmDialog
                showModal={deletingNode !== null}
                setShowModal={(v) => { if (!v) setDeletingNode(null); }}
                tone="danger"
                title={t('hierarchy.deleteNodeTitle')}
                description={t('hierarchy.deleteNodeConfirm', { name: deletingNode?.nodeName ?? '' })}
                confirmLabel={t('hierarchy.deleteNode')}
                onConfirm={deleteNode}
                onCancel={() => setDeletingNode(null)}
            />
        </div>
    );
}
