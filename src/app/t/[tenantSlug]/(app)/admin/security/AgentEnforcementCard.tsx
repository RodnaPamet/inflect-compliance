'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

/**
 * AGENT-REGISTRATION ENFORCEMENT — the switch, and the pre-flight (#2443).
 *
 * ── WHY THIS IS NOT A TOGGLE ────────────────────────────────────────
 *
 * `requireRegisteredAgent` decides whether the register, the tool allowlist,
 * both autonomy terms, the policy card, the circuit breaker and the agent arm of
 * the kill switch mean anything at all. The introducing migration set it FALSE
 * for every pre-existing tenant, deliberately, because the second precondition
 * was unmet: the create-key form sent no `agentId`, so every UI-minted
 * credential stood at `no_binding`. Switching enforcement on without fixing that
 * refuses every one of them at the tool boundary, at once.
 *
 * So this surface is built around the LIST rather than the switch. An operator
 * sees exactly which credentials would stop working, by name, before they can
 * commit — and if that list is non-empty the confirmation says so in the modal
 * they have to type into.
 *
 * ── BOTH DIRECTIONS ARE TYPED, AND THAT IS DELIBERATE ───────────────
 *
 * `docs/destructive-actions.md` sends tenant-wide-consequence actions to a
 * typed-confirmation modal rather than the 5-second undo. Enabling qualifies
 * obviously. DISABLING qualifies too, and is arguably worse: enabling breaks
 * things loudly and visibly, while disabling silently removes a boundary and
 * nothing appears to change. The direction that leaves no trace in the product
 * is the one that most needs a deliberate act, so both ask for the slug.
 */

interface BreakingCredential {
    id: string;
    name: string;
    keyPrefix: string;
    lastUsedAt: string | null;
}

interface Preflight {
    enforcing: boolean;
    breaking: BreakingCredential[];
}

export function AgentEnforcementCard({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('admin');
    // `common` is a SEPARATE namespace, opened explicitly. Calling the cancel
    // string through `t` would resolve it under `admin.` — absent, and next-intl
    // renders a missing key as its own dotted path rather than throwing, so the
    // button would read as a literal dotted path and fail nothing. Minting an
    // `admin` duplicate instead would be a second string for one word, which is
    // how catalogues start drifting.
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();

    const [preflight, setPreflight] = useState<Preflight | null>(null);
    /**
     * A REFUSED probe is not an empty list. `admin.agent_registry` gates this
     * pre-flight (#2444) and this page is reached with `admin.manage`, so a
     * legitimate settings administrator can land here and be refused — in which
     * case the card must say it cannot answer, not render "0 credentials
     * affected" and invite them to switch enforcement on.
     */
    const [unavailable, setUnavailable] = useState(false);
    const [pending, setPending] = useState<'enable' | 'disable' | null>(null);
    const [confirmText, setConfirmText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/security-settings/agent-enforcement'));
            if (!res.ok) { setUnavailable(true); return; }
            setPreflight(await res.json());
        } catch {
            setUnavailable(true);
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { load(); }, [load]);

    async function commit(next: boolean) {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/security-settings'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requireRegisteredAgent: next }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                setError(body?.error ?? t('security.agentEnforcement.saveFailed'));
                return;
            }
            close();
            await load();
        } finally {
            setBusy(false);
        }
    }

    function close() {
        setPending(null);
        setConfirmText('');
        setError(null);
    }

    if (unavailable) {
        return (
            <Card data-testid="agent-enforcement-card">
                <Heading level={2} className="mb-1">{t('security.agentEnforcement.title')}</Heading>
                <p className="text-sm text-content-muted">
                    {t('security.agentEnforcement.unavailable')}
                </p>
            </Card>
        );
    }
    if (!preflight) return null;

    const { enforcing, breaking } = preflight;

    return (
        <Card data-testid="agent-enforcement-card">
            <Heading level={2} className="mb-1">{t('security.agentEnforcement.title')}</Heading>

            {/* THE STATE, in operator language. "Agent registration is not being
                enforced. Any credential can act, registered or not." beats
                "requireRegisteredAgent = false" — the field name is not the
                fact, and nobody outside this codebase can read it as one. */}
            <div className="mb-3 flex items-center gap-tight">
                {enforcing ? (
                    <StatusBadge variant="success" size="sm">{t('security.agentEnforcement.on')}</StatusBadge>
                ) : (
                    <StatusBadge variant="warning" size="sm">{t('security.agentEnforcement.off')}</StatusBadge>
                )}
            </div>
            <p className="text-sm text-content-default mb-3" data-testid="agent-enforcement-state">
                {enforcing
                    ? breaking.length > 0
                        ? t('security.agentEnforcement.enforcingWithUnbound', { count: breaking.length })
                        : t('security.agentEnforcement.enforcingClean')
                    : t('security.agentEnforcement.notEnforcing')}
            </p>

            {/* The pre-flight, shown BEFORE anyone asks for it when enforcement
                is off — the list is the reason the switch is hard, so hiding it
                behind the button would put the work after the decision. */}
            {!enforcing && breaking.length > 0 && (
                <InlineNotice variant="warning" className="mb-3">
                    <div className="space-y-1">
                        <p>{t('security.agentEnforcement.wouldBreak', { count: breaking.length })}</p>
                        <ul className="list-disc pl-5" data-testid="agent-enforcement-breaking">
                            {breaking.map((c) => (
                                <li key={c.id}>
                                    <span className="font-medium">{c.name}</span>{' '}
                                    <code className="text-content-muted">{c.keyPrefix}…</code>
                                </li>
                            ))}
                        </ul>
                    </div>
                </InlineNotice>
            )}

            <Button
                variant={enforcing ? 'ghost' : 'secondary'}
                size="sm"
                onClick={() => setPending(enforcing ? 'disable' : 'enable')}
                data-testid="agent-enforcement-action"
                text={
                    enforcing
                        ? t('security.agentEnforcement.disableAction')
                        : t('security.agentEnforcement.enableAction')
                }
            />

            <Modal showModal={pending !== null} setShowModal={(o) => (o ? null : close())}>
                <Modal.Header
                    title={
                        pending === 'disable'
                            ? t('security.agentEnforcement.disableTitle')
                            : t('security.agentEnforcement.enableTitle')
                    }
                />
                <Modal.Body>
                    <div className="space-y-default" data-testid="agent-enforcement-modal">
                        <p className="text-sm text-content-default">
                            {pending === 'disable'
                                ? t('security.agentEnforcement.disableBody')
                                : t('security.agentEnforcement.enableBody')}
                        </p>

                        {/* The acknowledgement the prompt requires: the operator
                            cannot type past this without the list in front of
                            them. */}
                        {pending === 'enable' && breaking.length > 0 && (
                            <InlineNotice variant="warning" icon={null}>
                                <div className="space-y-1">
                                    <p>{t('security.agentEnforcement.wouldBreak', { count: breaking.length })}</p>
                                    <ul className="list-disc pl-5">
                                        {breaking.map((c) => (
                                            <li key={c.id}>
                                                <span className="font-medium">{c.name}</span>{' '}
                                                <code className="text-content-muted">{c.keyPrefix}…</code>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </InlineNotice>
                        )}

                        <FormField label={t('security.agentEnforcement.typeToConfirm', { slug: tenantSlug })} required>
                            <Input
                                value={confirmText}
                                onChange={(e) => setConfirmText(e.target.value)}
                                autoComplete="off"
                                autoFocus
                                placeholder={tenantSlug}
                                data-testid="agent-enforcement-confirm-input"
                            />
                        </FormField>

                        {error && <InlineNotice variant="error" icon={null}>{error}</InlineNotice>}
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button type="button" variant="ghost" size="sm" onClick={close} text={tCommon('cancel')} />
                    <Button
                        type="button"
                        variant={pending === 'disable' ? 'destructive' : 'secondary'}
                        size="sm"
                        disabled={confirmText !== tenantSlug || busy}
                        onClick={() => commit(pending === 'enable')}
                        data-testid="agent-enforcement-commit"
                        text={
                            pending === 'disable'
                                ? t('security.agentEnforcement.disableAction')
                                : t('security.agentEnforcement.enableAction')
                        }
                    />
                </Modal.Footer>
            </Modal>
        </Card>
    );
}
