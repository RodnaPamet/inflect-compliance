'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/hooks';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

/**
 * The kill switch, on the agent it stops.
 *
 * NOT the register's SUSPEND, and the distinction is the whole reason this
 * exists as a second control rather than a rename of the first. Suspension is
 * a DISPATCH control: registration is evaluated once per invocation, so it
 * refuses the next REQUEST and does nothing at all to a run already in
 * flight — the exact case a stop control exists for. This is a BOUNDARY
 * control, re-read uncached at step 0 of every tool call, which is what lets
 * it stop a run mid-way.
 *
 * A consequence the UI has to carry: engaging does NOT change
 * `RegisteredAgent.status`. The badge in the header stays ACTIVE, and ACTIVE
 * with a kill in force is a coherent state rather than a bug. The banner is
 * the only thing that says so, which is why it renders above every tab
 * instead of inside one.
 *
 * Both directions collect a reason, and neither uses the confirm-dialog
 * primitive: that one has no `children` and renders its description inside a
 * paragraph, so a textarea cannot live in it. The server refuses a blank
 * reason anyway — a stop with no stated reason is an outage nobody can review
 * afterwards — so the field is not decoration.
 */

/**
 * The scheduled drill's canary. It is a real, committed kill against an id
 * that resolves to no registered agent, engaged and lifted nightly — so an
 * unfiltered list shows one lifted row per tenant per day and pushes the real
 * incident history out of the window within months. Filtered here rather than
 * imported from the server module that declares it, which reaches Prisma and
 * does not belong in a client bundle.
 */
const DRILL_CANARY_AGENT_ID = '__kill-switch-drill-canary__';

const MAX_REASON = 2000;

/** `Date` fields arrive as ISO strings over JSON. */
interface KillSwitchRow {
    id: string;
    scope: 'AGENT' | 'TENANT';
    agentId: string | null;
    reason: string;
    engagedByUserId: string;
    engagedAt: string;
    liftedAt: string | null;
    liftedByUserId: string | null;
    liftReason: string | null;
}

interface KillSwitchListResponse {
    inForce: KillSwitchRow[];
    history: KillSwitchRow[];
}

/**
 * Widest scope wins, matching the boundary: it resolves platform over tenant
 * over agent, so a banner naming the narrower one would tell an operator that
 * lifting this agent's kill is enough to start it again.
 */
function findInForce(rows: KillSwitchRow[] | undefined, agentId: string): KillSwitchRow | null {
    const real = (rows ?? []).filter((r) => r.agentId !== DRILL_CANARY_AGENT_ID);
    return real.find((r) => r.agentId === null) ?? real.find((r) => r.agentId === agentId) ?? null;
}

/**
 * `inForceOnly` because this control answers "is anything stopping this agent
 * right now". The history belongs on the breaker tab, where the incident
 * timeline already lives.
 *
 * Skipped entirely (a null key) without the permission: the endpoint refuses
 * the GET as well as the writes, and a component that fetches only to be
 * refused writes a denial row on every mount.
 */
function useKillState(agentId: string, canKill: boolean, refreshToken?: number) {
    const { data, mutate } = useTenantSWR<KillSwitchListResponse>(
        canKill ? '/admin/agents/kill-switch?inForceOnly=true' : null,
    );

    useEffect(() => {
        if (canKill) void mutate();
    }, [refreshToken, canKill, mutate]);

    const inForce = useMemo(() => findInForce(data?.inForce, agentId), [data, agentId]);
    return { inForce, mutate };
}

export function AgentKillSwitchAction({
    agentId,
    canKill,
    refreshToken,
}: {
    agentId: string;
    canKill: boolean;
    refreshToken?: number;
}) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const { inForce, mutate } = useKillState(agentId, canKill, refreshToken);

    const [engaging, setEngaging] = useState(false);
    const [lifting, setLifting] = useState(false);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    const closeAll = useCallback(() => {
        if (busy) return;
        setEngaging(false);
        setLifting(false);
        setReason('');
        setFailure(null);
    }, [busy]);

    const openEngage = useCallback(() => {
        setReason('');
        setFailure(null);
        setEngaging(true);
    }, []);

    const openLift = useCallback(() => {
        setReason('');
        setFailure(null);
        setLifting(true);
    }, []);

    const trimmed = reason.trim();
    const canSubmit = !busy && trimmed.length > 0 && trimmed.length <= MAX_REASON;

    const engage = useCallback(async () => {
        setBusy(true);
        setFailure(null);
        try {
            const res = await fetch(apiUrl('/admin/agents/kill-switch'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId, reason: trimmed }),
            });
            if (!res.ok) {
                // `apiErrorMessage` rather than reading `error` off the body:
                // the envelope's `error` is an OBJECT, and rendering one as a
                // React child throws inside the page error boundary — a
                // failure that only ever fires on the failure path, which is
                // exactly where nobody is looking.
                const body = await res.json().catch(() => null);
                setFailure(apiErrorMessage(body, t('agentDetail.kill.engageError')));
                return;
            }
            // Engaging twice is idempotent by design and returns the existing
            // row, so the status code cannot tell "I stopped it" from "it was
            // already stopped". Revalidating and reading the banner is the
            // only honest answer either way.
            await mutate();
            setEngaging(false);
            setReason('');
            toast.success(t('agentDetail.kill.engagedToast'));
        } catch {
            setFailure(t('agentDetail.kill.engageError'));
        } finally {
            setBusy(false);
        }
    }, [apiUrl, agentId, trimmed, mutate, toast, t]);

    const lift = useCallback(async () => {
        if (!inForce) return;
        setBusy(true);
        setFailure(null);
        try {
            const res = await fetch(apiUrl('/admin/agents/kill-switch'), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ switchId: inForce.id, liftReason: trimmed }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                setFailure(apiErrorMessage(body, t('agentDetail.kill.liftError')));
                return;
            }
            await mutate();
            setLifting(false);
            setReason('');
            toast.success(t('agentDetail.kill.liftedToast'));
        } catch {
            setFailure(t('agentDetail.kill.liftError'));
        } finally {
            setBusy(false);
        }
    }, [apiUrl, inForce, trimmed, mutate, toast, t]);

    if (!canKill) return null;

    const tenantWide = inForce?.agentId === null;

    return (
        <>
            {inForce ? (
                <Button variant="secondary" size="sm" id="agent-kill-lift-btn" onClick={openLift}>
                    {tenantWide
                        ? t('agentDetail.kill.liftActionTenant')
                        : t('agentDetail.kill.liftAction')}
                </Button>
            ) : (
                // A ghost tinted with the error content token rather than the
                // filled destructive variant: this button only OPENS a dialog.
                // The red fill is spent on the control that commits, inside it.
                <Button
                    variant="ghost"
                    size="sm"
                    className="text-content-error"
                    id="agent-kill-engage-btn"
                    onClick={openEngage}
                >
                    {t('agentDetail.kill.engageAction')}
                </Button>
            )}

            {engaging && (
                <Modal
                    showModal
                    setShowModal={(v) => {
                        if (!v) closeAll();
                    }}
                    size="md"
                    preventDefaultClose={busy}
                >
                    <Modal.Header
                        title={t('agentDetail.kill.engageTitle')}
                        description={t('agentDetail.kill.engagePrompt')}
                    />
                    <Modal.Body>
                        {failure && <InlineNotice variant="error">{failure}</InlineNotice>}
                        <FormField label={t('agentDetail.kill.reasonLabel')} required>
                            <Textarea
                                id="agent-kill-reason"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                rows={3}
                                maxLength={MAX_REASON}
                                autoFocus
                                className="w-full"
                            />
                        </FormField>
                        <p className="mt-1 text-xs text-content-subtle">
                            {t('agentDetail.kill.charCount', { count: reason.length })}
                        </p>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={closeAll}
                            disabled={busy}
                        >
                            {t('agentDetail.kill.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            loading={busy}
                            disabled={!canSubmit}
                            id="agent-kill-engage-confirm"
                            onClick={() => void engage()}
                        >
                            {t('agentDetail.kill.engageConfirm')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            )}

            {lifting && inForce && (
                <Modal
                    showModal
                    setShowModal={(v) => {
                        if (!v) closeAll();
                    }}
                    size="md"
                    preventDefaultClose={busy}
                >
                    {/* Tenant-wide and per-agent lifts get different copy in
                        all three places — title, description and button. The
                        endpoint takes a switch id and does not care which it
                        is, so the wording on this dialog is the only thing
                        between an operator and restarting a fleet they meant
                        to restart one of. */}
                    <Modal.Header
                        title={
                            tenantWide
                                ? t('agentDetail.kill.liftTitleTenant')
                                : t('agentDetail.kill.liftTitle')
                        }
                        description={
                            tenantWide
                                ? t('agentDetail.kill.liftPromptTenant')
                                : t('agentDetail.kill.liftPrompt')
                        }
                    />
                    <Modal.Body>
                        {failure && <InlineNotice variant="error">{failure}</InlineNotice>}
                        <FormField label={t('agentDetail.kill.liftReasonLabel')} required>
                            <Textarea
                                id="agent-kill-lift-reason"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                rows={3}
                                maxLength={MAX_REASON}
                                autoFocus
                                className="w-full"
                            />
                        </FormField>
                        <p className="mt-1 text-xs text-content-subtle">
                            {t('agentDetail.kill.charCount', { count: reason.length })}
                        </p>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={closeAll}
                            disabled={busy}
                        >
                            {t('agentDetail.kill.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            loading={busy}
                            disabled={!canSubmit}
                            id="agent-kill-lift-confirm"
                            onClick={() => void lift()}
                        >
                            {tenantWide
                                ? t('agentDetail.kill.liftConfirmTenant')
                                : t('agentDetail.kill.liftConfirm')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            )}
        </>
    );
}

/**
 * The in-force banner. A separate export so the shell can put it above the tab
 * switch while the trigger sits in the header: the layout has an actions slot
 * and no banner slot, and a stop that is visible on only one tab is a stop
 * somebody can miss.
 *
 * Both components read the same key, so the fetch is deduped into one request
 * and one cache entry.
 */
export function AgentKillSwitchBanner({
    agentId,
    canKill,
    refreshToken,
}: {
    agentId: string;
    canKill: boolean;
    refreshToken?: number;
}) {
    const t = useTranslations('admin');
    const { inForce } = useKillState(agentId, canKill, refreshToken);

    if (!inForce) return null;

    return (
        <InlineNotice
            variant="error"
            title={
                inForce.agentId === null
                    ? t('agentDetail.kill.bannerTenantTitle')
                    : t('agentDetail.kill.bannerAgentTitle')
            }
        >
            {t('agentDetail.kill.bannerDetail', {
                reason: inForce.reason,
                when: formatDateTime(inForce.engagedAt),
            })}
        </InlineNotice>
    );
}
