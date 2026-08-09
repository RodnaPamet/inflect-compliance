'use client';
import { formatDate } from '@/lib/format-date';
import { SkeletonCard } from '@/components/ui/skeleton';
import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { AppIcon } from '@/components/icons/AppIcon';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast, useToastWithUndo } from '@/components/ui/hooks';
import { cardVariants } from '@/components/ui/card';
import { Plus, UserPlus, Xmark } from '@/components/ui/icons/nucleo';
import { RequirePermission } from '@/components/require-permission';
import { Tooltip } from '@/components/ui/tooltip';
import { AUDIT_PACK_STATUS_VARIANT, DEFAULT_STATUS_VARIANT } from '../_lib/status-variants';
import { cn } from '@/lib/cn';

interface PackAccessRef { auditPackId: string; grantedAt: string }
interface AuditorRow {
    id: string;
    email: string;
    name: string | null;
    status: 'INVITED' | 'ACTIVE' | 'REVOKED';
    createdAt: string;
    packAccess: PackAccessRef[];
}
interface PackRow { id: string; name: string; status: string }

const STATUS_BADGE: Record<AuditorRow['status'], StatusBadgeVariant> = {
    INVITED: 'neutral', ACTIVE: 'success', REVOKED: 'warning',
};

export default function AuditorsManagementPage() {
    const params = useParams();
    const tenantSlug = params.tenantSlug as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);
    const tx = useTranslations('audits');
    const toast = useToast();

    const [auditors, setAuditors] = useState<AuditorRow[]>([]);
    const [packs, setPacks] = useState<PackRow[]>([]);
    const [loading, setLoading] = useState(true);

    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteName, setInviteName] = useState('');
    const [inviting, setInviting] = useState(false);

    const [selectedPack, setSelectedPack] = useState<Record<string, string>>({});
    const [busyAuditor, setBusyAuditor] = useState<string | null>(null);
    const [revokeAccountTarget, setRevokeAccountTarget] = useState<AuditorRow | null>(null);
    // Account-level revoke is a TYPED confirmation, not a click-through: it
    // cascades across every pack grant the auditor holds, which is the
    // documented Epic 67 exception where a 5-second undo window is too short.
    const [revokeAccountConfirmText, setRevokeAccountConfirmText] = useState('');
    const [revokingAccount, setRevokingAccount] = useState(false);
    const triggerUndoToast = useToastWithUndo();

    const loadAuditors = useCallback(() => {
        return fetch(apiUrl('/audits/auditors'))
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load'))))
            .then((d: AuditorRow[]) => setAuditors(Array.isArray(d) ? d : []))
            .catch(() => toast.error(tx('auditorsAdmin.loadError')));
    }, [apiUrl, toast, tx]);

    useEffect(() => {
        Promise.all([
            fetch(apiUrl('/audits/auditors')).then((r) => (r.ok ? r.json() : [])),
            fetch(apiUrl('/audits/packs')).then((r) => (r.ok ? r.json() : [])),
        ])
            .then(([a, p]) => {
                setAuditors(Array.isArray(a) ? a : []);
                setPacks(Array.isArray(p) ? p : []);
            })
            .catch(() => toast.error(tx('auditorsAdmin.loadError')))
            .finally(() => setLoading(false));
    }, [apiUrl, toast, tx]);

    const packName = useCallback(
        (id: string) => packs.find((p) => p.id === id)?.name ?? tx('auditorsAdmin.packFallback'),
        [packs, tx],
    );

    const submitInvite = async (e: React.FormEvent) => {
        e.preventDefault();
        if (inviting) return;
        setInviting(true);
        try {
            const res = await fetch(apiUrl('/audits/auditors'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: inviteEmail, name: inviteName || undefined }),
            });
            if (res.ok) {
                // PR-O — surface reactivation: inviting an existing/REVOKED
                // auditor flips them back to ACTIVE. Say so, rather than a
                // generic "invited" that hides the state change.
                const data = await res.json().catch(() => null);
                setInviteOpen(false);
                setInviteEmail('');
                setInviteName('');
                await loadAuditors();
                toast.success(data?.reactivated ? tx('auditorsAdmin.reactivateSuccess') : tx('auditorsAdmin.inviteSuccess'));
            } else {
                toast.error(tx('auditorsAdmin.inviteError'));
            }
        } catch {
            toast.error(tx('auditorsAdmin.inviteError'));
        } finally {
            setInviting(false);
        }
    };

    const grantAccess = async (auditorId: string) => {
        const packId = selectedPack[auditorId];
        if (!packId) return;
        // A revoked auditor has no active grants; refuse to re-open access
        // without an explicit re-invite (which flips them back to ACTIVE).
        // The UI hides the grant affordance for REVOKED rows; this is the
        // defensive backstop.
        if (auditors.find((a) => a.id === auditorId)?.status === 'REVOKED') {
            toast.error(tx('auditorsAdmin.grantRevokedError'));
            return;
        }
        setBusyAuditor(auditorId);
        try {
            const res = await fetch(apiUrl('/audits/auditors/access'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auditorId, packId }),
            });
            if (res.ok) {
                setSelectedPack((s) => ({ ...s, [auditorId]: '' }));
                await loadAuditors();
                toast.success(tx('auditorsAdmin.grantSuccess'));
            } else {
                toast.error(tx('auditorsAdmin.grantError'));
            }
        } catch {
            toast.error(tx('auditorsAdmin.grantError'));
        } finally {
            setBusyAuditor(null);
        }
    };

    /**
     * Drop ONE pack grant — routine, reversible, so it takes the Epic 67
     * undo-toast rather than a click-through confirm. Canonical wiring per
     * docs/destructive-actions.md: snapshot, optimistic remove, trigger.
     * The DELETE only fires after the 5-second window elapses; Undo cancels
     * it outright, so a mis-click never reaches the server.
     */
    const revokeAccess = (auditorId: string, packId: string) => {
        const snapshot = auditors;
        setAuditors((cur) =>
            cur.map((a) =>
                a.id === auditorId
                    ? { ...a, packAccess: a.packAccess.filter((pa) => pa.auditPackId !== packId) }
                    : a,
            ),
        );
        triggerUndoToast({
            message: tx('auditorsAdmin.revokeSuccess'),
            undoMessage: tx('auditorsAdmin.undo'),
            action: async () => {
                const res = await fetch(apiUrl('/audits/auditors/access'), {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ auditorId, packId }),
                });
                if (!res.ok) throw new Error('revoke');
                await loadAuditors();
            },
            // Undo and failure both restore what the user could see.
            undoAction: () => setAuditors(snapshot),
            onError: () => {
                setAuditors(snapshot);
                toast.error(tx('auditorsAdmin.revokeError'));
            },
        });
    };

    // PR-O — account-level revoke: flip the whole AuditorAccount to REVOKED and
    // drop every pack grant in one action (distinct from removing a single pack).
    const revokeAccount = async (auditorId: string) => {
        setRevokingAccount(true);
        try {
            const res = await fetch(apiUrl(`/audits/auditors/${auditorId}`), { method: 'DELETE' });
            if (res.ok) {
                await loadAuditors();
                toast.success(tx('auditorsAdmin.revokeAccountSuccess'));
            } else {
                toast.error(tx('auditorsAdmin.revokeAccountError'));
            }
        } finally {
            setRevokingAccount(false);
        }
    };

    const closeRevokeAccount = () => {
        setRevokeAccountTarget(null);
        setRevokeAccountConfirmText('');
    };
    /** What the operator must type. The auditor's email — unambiguous, and
     *  visible on the row they clicked. */
    const revokeAccountToken = revokeAccountTarget?.email ?? '';

    if (loading) {
        return (
            <div className="p-8">
                <SkeletonCard lines={4} />
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-compact">
                <div>
                    <PageBreadcrumbs
                        items={[
                            { label: tx('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                            { label: tx('crumb.audits'), href: `/t/${tenantSlug}/audits` },
                            { label: tx('auditorsAdmin.crumb') },
                        ]}
                        className="mb-1"
                    />
                    <Heading level={1} id="auditors-admin-heading">{tx('auditorsAdmin.title')}</Heading>
                    <p className="text-content-muted text-sm">{tx('auditorsAdmin.subtitle')}</p>
                </div>
                <RequirePermission resource="audits" action="manage">
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        onClick={() => setInviteOpen(true)}
                        id="invite-auditor-btn"
                    >
                        {tx('auditorsAdmin.inviteAuditor')}
                    </Button>
                </RequirePermission>
            </div>

            {auditors.length === 0 ? (
                <div className={cardVariants({ density: 'none' })}>
                    <EmptyState
                        icon={UserPlus}
                        title={tx('auditorsAdmin.emptyTitle')}
                        description={tx('auditorsAdmin.emptyDesc')}
                    />
                </div>
            ) : (
                <div className="space-y-default">
                    {auditors.map((a) => {
                        const grantedIds = new Set(a.packAccess.map((p) => p.auditPackId));
                        // Carry the pack status as option `meta` so the picker can
                        // badge DRAFT vs FROZEN vs EXPORTED packs distinctly (they
                        // used to render identically). `label` stays a plain string
                        // so search + trigger display keep working.
                        const options: ComboboxOption<string>[] = packs
                            .filter((p) => !grantedIds.has(p.id))
                            .map((p) => ({ value: p.id, label: p.name, meta: p.status }));
                        const chosen = selectedPack[a.id] ?? '';
                        const isRevoked = a.status === 'REVOKED';
                        return (
                            <div key={a.id} className={cn(cardVariants(), 'space-y-default')} id={`auditor-${a.id}`}>
                                <div className="flex flex-wrap items-center justify-between gap-compact">
                                    <div className="min-w-0">
                                        <p className="font-medium text-sm truncate">{a.name || a.email}</p>
                                        <p className="text-xs text-content-subtle truncate">{a.email}</p>
                                    </div>
                                    <div className="flex items-center gap-tight">
                                        <StatusBadge variant={STATUS_BADGE[a.status]}>{tx(`auditorsAdmin.status${a.status}`)}</StatusBadge>
                                        <span className="text-xs text-content-subtle">{tx('auditorsAdmin.invitedOn', { date: formatDate(a.createdAt) })}</span>
                                        {a.status !== 'REVOKED' && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => setRevokeAccountTarget(a)}
                                                id={`revoke-account-${a.id}`}
                                            >
                                                {tx('auditorsAdmin.revokeAccount')}
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-tight">
                                    <p className="text-xs font-medium text-content-muted">{tx('auditorsAdmin.accessSection')}</p>
                                    {a.packAccess.length === 0 ? (
                                        <p className="text-xs text-content-subtle">{tx('auditorsAdmin.noAccess')}</p>
                                    ) : (
                                        <ul className="flex flex-wrap gap-tight">
                                            {a.packAccess.map((pa) => (
                                                <li key={pa.auditPackId} className="inline-flex items-center gap-tight rounded-full border border-border-subtle bg-bg-elevated px-2 py-1 text-xs">
                                                    <AppIcon name="package" size={12} />
                                                    <span className="truncate max-w-trunc-default">{packName(pa.auditPackId)}</span>
                                                    <Tooltip content={tx('auditorsAdmin.revokeAccessAria', { pack: packName(pa.auditPackId) })}>
                                                        <Button
                                                            variant="ghost"
                                                            size="xs"
                                                            className="-mr-1 h-5 w-5 min-w-0 border-0 px-0 text-content-subtle hover:text-content-error"
                                                            icon={<Xmark className="h-3 w-3" />}
                                                            aria-label={tx('auditorsAdmin.revokeAccessAria', { pack: packName(pa.auditPackId) })}
                                                            onClick={() => revokeAccess(a.id, pa.auditPackId)}
                                                            id={`revoke-access-${a.id}-${pa.auditPackId}`}
                                                        />
                                                    </Tooltip>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>

                                {isRevoked ? (
                                    <p className="text-xs text-content-subtle">{tx('auditorsAdmin.grantRevokedNote')}</p>
                                ) : (
                                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-tight">
                                        <div className="flex-1 min-w-0">
                                            <Combobox
                                                options={options}
                                                selected={options.find((o) => o.value === chosen) ?? null}
                                                setSelected={(opt) => setSelectedPack((s) => ({ ...s, [a.id]: opt?.value ?? '' }))}
                                                placeholder={options.length === 0 ? tx('auditorsAdmin.allGranted') : tx('auditorsAdmin.grantPlaceholder')}
                                                disabled={options.length === 0}
                                                matchTriggerWidth
                                                aria-label={tx('auditorsAdmin.grantPlaceholder')}
                                                optionRight={(opt) =>
                                                    opt.meta ? (
                                                        <StatusBadge variant={AUDIT_PACK_STATUS_VARIANT[opt.meta] ?? DEFAULT_STATUS_VARIANT}>
                                                            {tx(`packStatus.${opt.meta}`)}
                                                        </StatusBadge>
                                                    ) : null
                                                }
                                            />
                                        </div>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => grantAccess(a.id)}
                                            disabled={!chosen || busyAuditor === a.id}
                                            loading={busyAuditor === a.id}
                                            id={`grant-access-${a.id}`}
                                        >
                                            {tx('auditorsAdmin.grant')}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Invite auditor modal */}
            <Modal showModal={inviteOpen} setShowModal={setInviteOpen} size="md" title={tx('auditorsAdmin.inviteTitle')} preventDefaultClose={inviting}>
                <Modal.Header title={tx('auditorsAdmin.inviteTitle')} description={tx('auditorsAdmin.inviteDesc')} />
                <Modal.Form id="invite-auditor-form" onSubmit={submitInvite}>
                    <Modal.Body>
                        <fieldset disabled={inviting} className="m-0 p-0 border-0 space-y-default">
                            <FormField label={tx('auditorsAdmin.emailLabel')} required>
                                <Input
                                    type="email"
                                    value={inviteEmail}
                                    onChange={(e) => setInviteEmail(e.target.value)}
                                    placeholder={tx('auditorsAdmin.emailPlaceholder')}
                                    required
                                    id="invite-auditor-email"
                                />
                            </FormField>
                            <FormField label={tx('auditorsAdmin.nameLabel')}>
                                <Input
                                    value={inviteName}
                                    onChange={(e) => setInviteName(e.target.value)}
                                    placeholder={tx('auditorsAdmin.namePlaceholder')}
                                    id="invite-auditor-name"
                                />
                            </FormField>
                        </fieldset>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button variant="secondary" size="sm" onClick={() => setInviteOpen(false)} disabled={inviting} id="invite-auditor-cancel">
                            {tx('auditorsAdmin.cancel')}
                        </Button>
                        <Button type="submit" variant="primary" size="sm" disabled={inviting || !inviteEmail} id="invite-auditor-submit">
                            {inviting ? tx('auditorsAdmin.inviting') : tx('auditorsAdmin.inviteSubmit')}
                        </Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>

            {/* Account-level revoke — TYPED confirmation.
                This flips the whole AuditorAccount to REVOKED and drops every
                pack grant at once. Epic 67 routes routine removals through the
                undo toast, but names cascading actions as the exception: five
                seconds is not long enough to reconsider revoking an external
                auditor's entire access. Typing the email makes the target
                explicit, so the wrong row cannot be revoked by momentum. */}
            <Modal
                showModal={revokeAccountTarget !== null}
                setShowModal={(open) => { if (!open) closeRevokeAccount(); }}
                title={tx('auditorsAdmin.revokeAccountTitle')}
            >
                <Modal.Body>
                    {revokeAccountTarget && (
                        <div className="space-y-default" id="revoke-account-confirm">
                            <p className="text-sm text-content-default">
                                {tx('auditorsAdmin.revokeAccountDesc', {
                                    name: revokeAccountTarget.name || revokeAccountTarget.email,
                                })}
                            </p>
                            <FormField
                                label={tx('auditorsAdmin.revokeAccountTypeToConfirm', {
                                    name: revokeAccountToken,
                                })}
                                required
                            >
                                <Input
                                    value={revokeAccountConfirmText}
                                    onChange={(e) => setRevokeAccountConfirmText(e.target.value)}
                                    autoComplete="off"
                                    autoFocus
                                    placeholder={revokeAccountToken}
                                    id="revoke-account-confirm-input"
                                />
                            </FormField>
                        </div>
                    )}
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" onClick={closeRevokeAccount}>
                        {tx('auditorsAdmin.cancel')}
                    </Button>
                    <Button
                        variant="destructive"
                        id="revoke-account-confirm-submit"
                        disabled={
                            revokingAccount ||
                            revokeAccountConfirmText.trim() !== revokeAccountToken
                        }
                        onClick={async () => {
                            if (!revokeAccountTarget) return;
                            await revokeAccount(revokeAccountTarget.id);
                            closeRevokeAccount();
                        }}
                    >
                        {tx('auditorsAdmin.revokeAccountConfirm')}
                    </Button>
                </Modal.Actions>
            </Modal>
        </div>
    );
}
