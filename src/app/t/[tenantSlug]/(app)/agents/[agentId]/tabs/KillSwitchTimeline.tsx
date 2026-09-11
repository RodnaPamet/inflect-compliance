'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';

/**
 * THE KILL-SWITCH TIMELINE — "the evidence that agents were stopped between two
 * timestamps" (#2450).
 *
 * The API has returned `history` since the kill switch shipped, the client TYPED
 * it, and no screen read it. Only `inForce` rendered — so the product could
 * answer "is anything stopped right now" and had no answer at all to "was
 * anything ever stopped, by whom, and why". The second question is the one an
 * incident review asks, and 4/4's incident report is built on this field, which
 * is why it lands before that prompt rather than with it.
 *
 * ── THE DRILL CANARY MUST BE FILTERED, OR THIS IS NOISE ─────────────
 *
 * A scheduled drill engages and lifts a real kill against a sentinel agent id
 * EVERY NIGHT. Unfiltered, that is one lifted row per tenant per day, which
 * pushes real incidents out of a bounded window within months — the timeline
 * would be technically complete and practically useless. `AgentKillSwitchAction`
 * filters the same id for the same reason; the constant is duplicated rather
 * than imported because the module that declares it reaches Prisma and does not
 * belong in a client bundle.
 *
 * ── A DELETED ACTOR DOES NOT BLANK THE ROW ──────────────────────────
 *
 * `engagedBy` resolves to null when the user no longer exists. The stop still
 * happened; losing the record because somebody left the company is precisely the
 * failure an audit trail exists to prevent. So the row renders with the id as a
 * fallback and says the actor is gone, rather than rendering nothing.
 */

const DRILL_CANARY_AGENT_ID = '__kill-switch-drill-canary__';

interface Actor {
    id: string;
    name: string | null;
    email: string;
}

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
    engagedBy: Actor | null;
    liftedBy: Actor | null;
}

interface KillSwitchListResponse {
    inForce: KillSwitchRow[];
    history: KillSwitchRow[];
}

function actorLabel(actor: Actor | null, fallbackId: string): string {
    if (!actor) return fallbackId;
    return actor.name ?? actor.email;
}

export function KillSwitchTimeline({
    agentId,
    canRead,
}: {
    agentId: string;
    canRead: boolean;
}) {
    const t = useTranslations('admin');
    // Null key when refused: the endpoint refuses the GET as well as the writes,
    // and fetching only to be refused writes a denial row on every mount.
    const { data } = useTenantSWR<KillSwitchListResponse>(
        canRead ? '/admin/agents/kill-switch' : null,
    );

    const rows = useMemo(() => {
        const all = data?.history ?? [];
        return all.filter(
            (r) =>
                r.agentId !== DRILL_CANARY_AGENT_ID
                // A TENANT-scoped kill stopped THIS agent too — it stops every
                // agent — so it belongs on this agent's timeline. Filtering to
                // `agentId === agentId` would hide the widest stop the product
                // has from the page of every agent it affected.
                && (r.agentId === agentId || r.agentId === null),
        );
    }, [data, agentId]);

    if (!canRead) return null;

    return (
        <div className="space-y-compact" data-testid="kill-switch-timeline">
            <Heading level={2}>{t('agentDetail.kill.historyHeading')}</Heading>

            {rows.length === 0 ? (
                // Stated, not blank. An empty panel cannot be told apart from one
                // that failed to load, and "this agent has never been stopped" is
                // a real and reassuring answer.
                <p className="text-sm text-content-muted" data-testid="kill-switch-timeline-empty">
                    {t('agentDetail.kill.historyEmpty')}
                </p>
            ) : (
                <ol className="space-y-compact">
                    {rows.map((row) => (
                        <li
                            key={row.id}
                            className="border-l-2 border-border-default pl-3 py-1"
                            data-testid="kill-switch-timeline-row"
                        >
                            <div className="flex flex-wrap items-center gap-2">
                                <StatusBadge
                                    variant={row.scope === 'TENANT' ? 'error' : 'warning'}
                                    size="sm"
                                >
                                    {row.scope === 'TENANT'
                                        ? t('agentDetail.kill.scopeTenant')
                                        : t('agentDetail.kill.scopeAgent')}
                                </StatusBadge>
                                <StatusBadge
                                    variant={row.liftedAt ? 'neutral' : 'error'}
                                    size="sm"
                                >
                                    {row.liftedAt
                                        ? t('agentDetail.kill.lifted')
                                        : t('agentDetail.kill.inForce')}
                                </StatusBadge>
                            </div>

                            <p className="mt-1 text-sm text-content-default">
                                {t('agentDetail.kill.engagedLine', {
                                    actor: actorLabel(row.engagedBy, row.engagedByUserId),
                                    at: new Date(row.engagedAt).toLocaleString(),
                                })}
                            </p>
                            <p className="text-sm text-content-muted">
                                {t('agentDetail.kill.reasonLine', { reason: row.reason })}
                            </p>

                            {row.liftedAt && (
                                <>
                                    <p className="mt-1 text-sm text-content-default">
                                        {t('agentDetail.kill.liftedLine', {
                                            actor: actorLabel(row.liftedBy, row.liftedByUserId ?? ''),
                                            at: new Date(row.liftedAt).toLocaleString(),
                                        })}
                                    </p>
                                    {row.liftReason && (
                                        <p className="text-sm text-content-muted">
                                            {t('agentDetail.kill.liftReasonLine', {
                                                reason: row.liftReason,
                                            })}
                                        </p>
                                    )}
                                </>
                            )}
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}
