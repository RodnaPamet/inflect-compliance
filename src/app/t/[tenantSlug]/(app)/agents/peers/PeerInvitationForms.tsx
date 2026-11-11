'use client';

/**
 * A2A PEER INVITATIONS (#3752; owner decisions 2026-11-11) — the two forms
 * that replace setting up a connection by hand on both sides.
 *
 *   · INVITE (`InvitePeerForm`): who answers for the peer that accepts, its
 *     supplier and tier, and the one receiving agent and workflows it may
 *     reach. Creates one code, shown ONCE (`InvitationCodePanel`), to hand to
 *     the other workspace.
 *   · ACCEPT (`AcceptInvitationForm`): paste a code, read the inviting
 *     workspace's card, and approve it. The one act pins that card as read,
 *     exchanges tokens with the inviter, and stores the outbound connection.
 *
 * The inviting side still approves the accepting side's card on that peer's
 * page: an acceptance pins nothing there, and nothing flows until a person
 * does.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { CopyText } from '@/components/ui/copy-text';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import type { PeerChoice } from './RegisterPeerForm';

const RISK_TIERS = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;

/** What both forms pick from: the register's live agents and the workflows a peer's task can start. */
export interface InvitationChoices {
    owners: PeerChoice[];
    vendors: PeerChoice[];
    agents: PeerChoice[];
    workflows: PeerChoice[];
}

/** The fields an invitation and an acceptance both carry. */
function useGrantFields(choices: InvitationChoices) {
    const t = useTranslations('agents');
    const [owner, setOwner] = useState<ComboboxOption | null>(null);
    const [vendor, setVendor] = useState<ComboboxOption | null>(null);
    const [riskTier, setRiskTier] = useState<ComboboxOption | null>(null);
    const [agent, setAgent] = useState<ComboboxOption | null>(null);
    const [workflows, setWorkflows] = useState<ComboboxOption[]>([]);
    const complete = owner !== null && vendor !== null && riskTier !== null && agent !== null && workflows.length > 0;
    const values = () => ({
        ownerUserId: owner!.value,
        vendorId: vendor!.value,
        riskTier: riskTier!.value,
        receivingAgentId: agent!.value,
        workflowKeys: workflows.map((w) => w.value),
    });
    const opts = (list: PeerChoice[]): ComboboxOption[] => list.map((c) => ({ value: c.id, label: c.label }));
    const fields = (prefix: string) => (
        <div className="grid grid-cols-1 gap-default md:grid-cols-2">
            <FormField label={t('peers.invite.owner')} description={t('peers.invite.ownerHint')} required>
                <Combobox
                    id={`${prefix}-owner`}
                    options={opts(choices.owners)}
                    selected={owner}
                    setSelected={setOwner}
                    placeholder={t('peers.register.ownerPlaceholder')}
                    matchTriggerWidth
                    forceDropdown
                    buttonProps={{ className: 'w-full' }}
                    caret
                />
            </FormField>
            <FormField label={t('peers.register.vendor')} description={t('peers.invite.vendorHint')} required>
                <Combobox
                    id={`${prefix}-vendor`}
                    options={opts(choices.vendors)}
                    selected={vendor}
                    setSelected={setVendor}
                    placeholder={t('peers.register.vendorPlaceholder')}
                    matchTriggerWidth
                    forceDropdown
                    buttonProps={{ className: 'w-full' }}
                    caret
                />
            </FormField>
            <FormField label={t('peers.register.riskTier')} required>
                <Combobox
                    hideSearch
                    id={`${prefix}-risk-tier`}
                    options={RISK_TIERS.map((tier) => ({ value: tier, label: t(`peers.register.tier.${tier}`) }))}
                    selected={riskTier}
                    setSelected={setRiskTier}
                    placeholder={t('peers.register.riskTierPlaceholder')}
                    matchTriggerWidth
                    buttonProps={{ className: 'w-full' }}
                    caret
                />
            </FormField>
            <FormField label={t('peers.credential.agentLabel')} description={t('peers.invite.agentHint')} required>
                <Combobox
                    id={`${prefix}-agent`}
                    options={opts(choices.agents)}
                    selected={agent}
                    setSelected={setAgent}
                    placeholder={t('peers.credential.agentPlaceholder')}
                    matchTriggerWidth
                    forceDropdown
                    buttonProps={{ className: 'w-full' }}
                    caret
                />
            </FormField>
            <FormField label={t('peers.credential.workflowsLabel')} description={t('peers.invite.workflowsHint')} required>
                <Combobox
                    id={`${prefix}-workflows`}
                    multiple
                    options={opts(choices.workflows)}
                    selected={workflows}
                    setSelected={setWorkflows}
                    placeholder={t('peers.credential.workflowsPlaceholder')}
                    matchTriggerWidth
                    forceDropdown
                />
            </FormField>
        </div>
    );
    return { complete, values, fields };
}

// ─── INVITE ────────────────────────────────────────────────────────────

export function InvitePeerForm({
    choices,
    onCreated,
    onCancel,
}: {
    choices: InvitationChoices;
    onCreated: (code: string) => void;
    onCancel: () => void;
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const grant = useGrantFields(choices);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        if (!grant.complete) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/agents/peers/invitations'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(grant.values()),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                setError(apiErrorMessage(body, t('peers.invite.failed')));
                return;
            }
            onCreated((body as { code: string }).code);
        } catch {
            setError(t('peers.invite.failed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card className="space-y-default" data-testid="peer-invite-form">
            <Heading level={2}>{t('peers.invite.heading')}</Heading>
            <p className="text-sm text-content-muted">{t('peers.invite.intro')}</p>
            {grant.fields('peer-invite')}
            {error && (
                <InlineNotice variant="error" data-testid="peer-invite-error">
                    {error}
                </InlineNotice>
            )}
            <div className="flex flex-wrap gap-compact">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!grant.complete || busy}
                    loading={busy}
                    onClick={() => void submit()}
                    data-testid="peer-invite-submit"
                >
                    {t('peers.invite.submit')}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                    {t('peers.register.cancel')}
                </Button>
            </div>
        </Card>
    );
}

/**
 * The code, ONCE. It lives only in this component's state: never in a URL, a
 * store or the page data, and it is gone on Done or on leaving the page.
 */
export function InvitationCodePanel({ code, onDone }: { code: string; onDone: () => void }) {
    const t = useTranslations('agents');
    return (
        <Card className="space-y-default" data-testid="peer-invite-code-panel">
            <Heading level={2}>{t('peers.invite.codeTitle')}</Heading>
            <InlineNotice variant="warning">{t('peers.invite.codeNotice')}</InlineNotice>
            <CopyText value={code} label={t('peers.invite.copyCode')}>
                <span className="font-mono text-xs break-all" data-testid="peer-invite-code">
                    {code}
                </span>
            </CopyText>
            <Button type="button" variant="secondary" size="sm" onClick={onDone} data-testid="peer-invite-code-done">
                {t('peers.invite.done')}
            </Button>
        </Card>
    );
}

// ─── ACCEPT ────────────────────────────────────────────────────────────

interface Preview {
    cardUrl: string;
    card: { name?: string; url?: string; description?: string } & Record<string, unknown>;
    cardHash: string;
    keyFingerprint: string;
}

export function AcceptInvitationForm({
    choices,
    onAccepted,
    onCancel,
}: {
    choices: InvitationChoices;
    onAccepted: (accepted: { peerId: string; name: string }) => void;
    onCancel: () => void;
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const grant = useGrantFields(choices);
    const [invitation, setInvitation] = useState('');
    const [preview, setPreview] = useState<Preview | null>(null);
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const read = async () => {
        setBusy(true);
        setError(null);
        setPreview(null);
        try {
            const res = await fetch(apiUrl('/admin/agents/peers/invitations/preview'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ invitation: invitation.trim() }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                setError(apiErrorMessage(body, t('peers.accept.readFailed')));
                return;
            }
            const p = body as Preview;
            setPreview(p);
            if (!name.trim() && typeof p.card.name === 'string') setName(p.card.name.slice(0, 200));
        } catch {
            setError(t('peers.accept.readFailed'));
        } finally {
            setBusy(false);
        }
    };

    const complete = preview !== null && name.trim().length > 0 && grant.complete;

    const accept = async () => {
        if (!complete || !preview) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/agents/peers/invitations/accept'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    invitation: invitation.trim(),
                    // The hash the person read: the server refuses if the card moved since.
                    reviewedCardHash: preview.cardHash,
                    name: name.trim(),
                    ...grant.values(),
                }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                setError(apiErrorMessage(body, t('peers.accept.failed')));
                return;
            }
            onAccepted({ peerId: (body as { peerId: string }).peerId, name: name.trim() });
        } catch {
            setError(t('peers.accept.failed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card className="space-y-default" data-testid="peer-accept-form">
            <Heading level={2}>{t('peers.accept.heading')}</Heading>
            <p className="text-sm text-content-muted">{t('peers.accept.intro')}</p>
            <FormField label={t('peers.accept.code')} description={t('peers.accept.codeHint')} required>
                <Textarea
                    id="peer-accept-code"
                    rows={2}
                    value={invitation}
                    maxLength={4096}
                    className="font-mono text-xs"
                    onChange={(e) => {
                        setInvitation(e.target.value);
                        setPreview(null);
                    }}
                />
            </FormField>
            {!preview && (
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={invitation.trim().length === 0 || busy}
                    loading={busy}
                    onClick={() => void read()}
                    data-testid="peer-accept-read"
                >
                    {t('peers.accept.read')}
                </Button>
            )}
            {preview && (
                <div className="space-y-default" data-testid="peer-accept-preview">
                    <Heading level={3}>{t('peers.accept.cardTitle')}</Heading>
                    <dl className="grid grid-cols-1 gap-compact text-sm md:grid-cols-2">
                        <div>
                            <dt className="text-content-muted">{t('peers.accept.cardUrl')}</dt>
                            <dd className="font-mono text-xs break-all">{preview.cardUrl}</dd>
                        </div>
                        <div>
                            <dt className="text-content-muted">{t('peers.accept.cardHash')}</dt>
                            <dd className="font-mono text-xs break-all" data-testid="peer-accept-card-hash">
                                {preview.cardHash}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-content-muted">{t('peers.accept.keyFingerprint')}</dt>
                            <dd className="font-mono text-xs break-all">{preview.keyFingerprint}</dd>
                        </div>
                    </dl>
                    <pre
                        className="max-h-64 overflow-auto rounded-md border border-border-subtle bg-bg-subtle p-compact text-xs"
                        data-testid="peer-accept-card-text"
                    >
                        {JSON.stringify(preview.card, null, 2)}
                    </pre>
                    <FormField label={t('peers.register.name')} required>
                        <Input id="peer-accept-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
                    </FormField>
                    {grant.fields('peer-accept')}
                    <InlineNotice variant="info">{t('peers.accept.approveNotice')}</InlineNotice>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!complete || busy}
                        loading={busy}
                        onClick={() => void accept()}
                        data-testid="peer-accept-submit"
                    >
                        {t('peers.accept.submit')}
                    </Button>
                </div>
            )}
            {error && (
                <InlineNotice variant="error" data-testid="peer-accept-error">
                    {error}
                </InlineNotice>
            )}
            <div>
                <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                    {t('peers.register.cancel')}
                </Button>
            </div>
        </Card>
    );
}
