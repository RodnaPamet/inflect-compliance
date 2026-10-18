'use client';

/* TODO(swr-migration): fetch-on-mount + setState, matching the parent
 * EntraProviderWizard. Migrate together to useTenantSWR. */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Trash } from '@inflect/ui/components/ui/icons/nucleo/trash';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { NumberStepper } from '@/components/ui/number-stepper';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';
import { Tooltip } from '@/components/ui/tooltip';
import { useToastWithUndo } from '@/components/ui/hooks';
import { ENTRA_MAPPABLE_ROLES } from '@/app-layer/schemas/entra-group-mapping.schemas';
import { usePermissions } from '@/lib/tenant-context-provider';
import { isOwnerManagedRole } from '@/lib/roles';

interface GroupMapping {
    id: string;
    aadGroupId: string;
    aadGroupName: string | null;
    role: string;
    priority: number;
}

/**
 * EI-2 — manage the tenant's Entra security-group → IC-role mappings. At
 * sign-in (EI-3) a user's resolved groups are matched against these rows to
 * sync their membership role. OWNER is intentionally not offered — ownership
 * stays manually granted. AI_ADMIN is offered to an OWNER only, and only an
 * OWNER may remove such a mapping (#3699 deploy 2; the API enforces both).
 */
export function GroupMappingsSection({ apiUrl }: { apiUrl: (path: string) => string }) {
    const t = useTranslations('admin');
    const tRoles = useTranslations('roles');
    const roleLabel = useCallback(
        (r: string) => (tRoles.has(r) ? tRoles(r) : r),
        [tRoles],
    );
    const canManageOwnerRoles = usePermissions().admin.owner_management;
    const roleOptions = useMemo(
        () =>
            ENTRA_MAPPABLE_ROLES.filter((r) => canManageOwnerRoles || !isOwnerManagedRole(r)).map((r) => ({
                value: r,
                label: roleLabel(r),
            })),
        [canManageOwnerRoles, roleLabel],
    );
    const [rows, setRows] = useState<GroupMapping[]>([]);
    const [groupId, setGroupId] = useState('');
    const [groupName, setGroupName] = useState('');
    const [role, setRole] = useState<string>('READER');
    const [priority, setPriority] = useState(0);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const triggerUndoToast = useToastWithUndo();

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/sso/entra/group-mappings'));
            if (!res.ok) return;
            setRows(await res.json());
        } catch {
            /* read-only load; ignore */
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void load(); }, [load]);

    const add = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/sso/entra/group-mappings'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    aadGroupId: groupId.trim(),
                    aadGroupName: groupName.trim() || undefined,
                    role,
                    priority,
                }),
            });
            if (!res.ok) {
                setError(
                    res.status === 409
                        ? t('entra.mappings.errExists')
                        : res.status === 403
                          ? t('entra.mappings.errDenied')
                          : t('entra.mappings.errInvalidGuid'),
                );
                return;
            }
            setGroupId('');
            setGroupName('');
            setRole('READER');
            setPriority(0);
            await load();
        } catch {
            setError(t('entra.mappings.errNetwork'));
        } finally {
            setSaving(false);
        }
    }, [apiUrl, groupId, groupName, role, priority, load, t]);

    const remove = useCallback(
        (m: GroupMapping) => {
            setRows((rs) => rs.filter((r) => r.id !== m.id)); // optimistic
            triggerUndoToast({
                message: t('entra.mappings.removed', { name: m.aadGroupName ?? m.aadGroupId }),
                undoMessage: t('entra.mappings.undo'),
                action: async () => {
                    const res = await fetch(apiUrl(`/sso/entra/group-mappings/${m.id}`), {
                        method: 'DELETE',
                    });
                    // fetch only rejects on network error — surface HTTP failures
                    // so onError fires and the optimistic removal is rolled back.
                    if (!res.ok && res.status !== 404) {
                        throw new Error(`Delete failed (${res.status})`);
                    }
                },
                undoAction: () => load(),
                onError: () => {
                    setError(t('entra.mappings.errRemove'));
                    void load();
                },
            });
        },
        [apiUrl, triggerUndoToast, load, t],
    );

    return (
        <Card className="space-y-default p-6">
            <Heading level={3}>{t('entra.mappings.title')}</Heading>
            <p className="text-sm text-content-muted">
                {t('entra.mappings.description')}
            </p>

            {error && <InlineNotice variant="error">{error}</InlineNotice>}

            {rows.length === 0 ? (
                <EmptyState
                    title={t('entra.mappings.emptyTitle')}
                    description={t('entra.mappings.emptyDesc')}
                />
            ) : (
                <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle">
                    {rows.map((m) => (
                        <li key={m.id} className="flex items-center gap-default px-4 py-default">
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-content-default">
                                    {m.aadGroupName ?? m.aadGroupId}
                                </div>
                                {m.aadGroupName && (
                                    <div className="truncate font-mono text-xs text-content-muted">
                                        {m.aadGroupId}
                                    </div>
                                )}
                            </div>
                            <StatusBadge variant="neutral">{roleLabel(m.role)}</StatusBadge>
                            <span className="w-20 text-right text-xs text-content-muted">
                                {t('entra.mappings.priorityBadge', { priority: m.priority })}
                            </span>
                            <Tooltip
                                content={t('entra.mappings.ownerOnlyMapping', { role: roleLabel(m.role) })}
                                disabled={canManageOwnerRoles || !isOwnerManagedRole(m.role)}
                            >
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    icon={<Trash />}
                                    aria-label={t('entra.mappings.removeAria', { name: m.aadGroupName ?? m.aadGroupId })}
                                    disabled={!canManageOwnerRoles && isOwnerManagedRole(m.role)}
                                    onClick={() => remove(m)}
                                />
                            </Tooltip>
                        </li>
                    ))}
                </ul>
            )}

            {/* Add-mapping row */}
            <div className="grid grid-cols-1 gap-default sm:grid-cols-[1fr_1fr_auto_auto_auto] sm:items-end">
                <FormField label={t('entra.mappings.groupObjectId')}>
                    <Input
                        id="entra-mapping-group-id"
                        placeholder="00000000-0000-0000-0000-000000000000"
                        value={groupId}
                        onChange={(e) => setGroupId(e.target.value)}
                    />
                </FormField>
                <FormField label={t('entra.mappings.displayName')}>
                    <Input
                        id="entra-mapping-group-name"
                        placeholder={t('entra.mappings.displayNamePlaceholder')}
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                    />
                </FormField>
                <FormField label={t('entra.mappings.role')} hint={t('entra.mappings.roleHint')}>
                    <Combobox
                        id="entra-mapping-role"
                        options={roleOptions}
                        selected={roleOptions.find((o) => o.value === role) ?? roleOptions[0]}
                        setSelected={(opt) => setRole(opt?.value ?? 'READER')}
                        matchTriggerWidth
                    />
                </FormField>
                <FormField label={t('entra.mappings.priority')}>
                    <NumberStepper value={priority} onChange={setPriority} min={0} max={1000} />
                </FormField>
                <Button
                    variant="primary"
                    onClick={add}
                    disabled={saving || !groupId.trim()}
                >
                    {saving ? t('entra.mappings.adding') : t('entra.mappings.addMapping')}
                </Button>
            </div>
            {/* AI_ADMIN never wins an equal-priority tie against a role it does
                not contain (`TIE_DECIDABLE_AGAINST`): say so, visibly, while
                the priority is being chosen. */}
            {role === 'AI_ADMIN' && (
                <InlineNotice variant="info">{t('entra.mappings.aiAdminTieHint')}</InlineNotice>
            )}
        </Card>
    );
}
