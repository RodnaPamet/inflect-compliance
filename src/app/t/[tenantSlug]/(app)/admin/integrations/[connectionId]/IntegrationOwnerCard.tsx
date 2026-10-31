'use client';

/**
 * Who answers for an external agent connection — integration passport field
 * P11 (#3672).
 *
 * Until a connection names an owner, the weekly passport sweep raises
 * CONNECTION_OWNER_MISSING (HIGH) and every other finding on the connection
 * goes to the tenant's OWNER role with no assignee. This card is where the
 * owner is named.
 *
 * `admin.manage`, the connection-write permission, at the route and at the
 * mount — the same key as editing the connection, so an ADMIN who maintains a
 * connection can name who answers for it. The passport itself is OWNER-only
 * and is a separate card.
 *
 * ═══ ONLY FOR `mcp-server` CONNECTIONS ═══
 *
 * Only those have a passport, and the connection page is shared by every
 * provider. The card decides from the connection's PROVIDER, read off the
 * same list the integrations page reads, as the legacy mapping card does — and
 * reads the stored owner from that row, so what it shows is what is saved.
 *
 * ═══ NOTHING IS SAVED UNTIL SAVE IS PRESSED ═══
 *
 * Picking a person, or clearing the picker, changes local state only. The
 * write is its own route rather than a field on the connection upsert: the
 * upsert defaults `isEnabled` to true, so naming an owner through it would
 * re-enable a disabled connection. The server refuses an owner without an
 * ACTIVE membership of this tenant; the refusal is shown, not swallowed.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantApiUrl, useTenantContext } from '@/lib/tenant-context-provider';
import { UserCombobox } from '@/components/ui/user-combobox';
import { FormField } from '@/components/ui/form-field';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';

const MCP_SERVER_PROVIDER = 'mcp-server';

export function IntegrationOwnerCard({ connectionId }: { connectionId: string }) {
    const t = useTranslations('admin.integrations.owner');
    const apiUrl = useTenantApiUrl();
    const { tenantSlug } = useTenantContext();

    /** null = not known yet (or the list failed); false = not an mcp-server connection. */
    const [applies, setApplies] = useState<boolean | null>(null);
    /** The owner as stored. */
    const [saved, setSaved] = useState<string | null>(null);
    /** The owner as picked. Local until Save. */
    const [picked, setPicked] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/admin/integrations'));
                if (!res.ok) throw new Error('load');
                const body: unknown = await res.json();
                const list = Array.isArray(body)
                    ? body
                    : ((body as { connections?: unknown[] }).connections ?? []);
                const mine = (list as { id?: string; provider?: string; ownerUserId?: string | null }[])
                    .find((c) => c.id === connectionId);
                if (!alive) return;
                const isMcp = mine?.provider === MCP_SERVER_PROVIDER;
                setApplies(isMcp);
                if (isMcp) {
                    const stored = mine?.ownerUserId ?? null;
                    setSaved(stored);
                    setPicked(stored);
                }
            } catch {
                // Unknown rather than false, and nothing rendered: a failed list
                // call says nothing about whether this connection has an owner.
                if (alive) setApplies(null);
            }
        })();
        return () => { alive = false; };
    }, [apiUrl, connectionId]);

    const save = useCallback(async () => {
        setSaving(true);
        setMsg(null);
        try {
            const res = await fetch(apiUrl(`/admin/integrations/${connectionId}/owner`), {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ownerUserId: picked }),
            });
            if (!res.ok) throw new Error(String(res.status));
            const body = (await res.json()) as { ownerUserId: string | null };
            setSaved(body.ownerUserId);
            setPicked(body.ownerUserId);
            setMsg({ ok: true, text: body.ownerUserId === null ? t('cleared') : t('saved') });
        } catch {
            setMsg({ ok: false, text: t('saveFailed') });
        } finally {
            setSaving(false);
        }
    }, [apiUrl, connectionId, picked, t]);

    if (applies !== true) return null;

    return (
        <Card className="space-y-default p-6" id="integration-owner" data-testid="integration-owner">
            <div className="space-y-tight">
                <Heading level={2}>{t('title')}</Heading>
                <p className="text-sm text-content-muted">{t('description')}</p>
            </div>

            {saved === null && (
                <InlineNotice variant="warning" data-testid="integration-owner-missing">
                    {t('missing')}
                </InlineNotice>
            )}

            <FormField label={t('label')}>
                <UserCombobox
                    tenantSlug={tenantSlug}
                    id="integration-owner-select"
                    selectedId={picked}
                    onChange={(userId) => { setPicked(userId); setMsg(null); }}
                    placeholder={t('placeholder')}
                />
            </FormField>

            {/* Secondary, not primary: a card on a detail page, and the
                product's primary budget is a one-way ratchet. */}
            <div className="flex items-center gap-tight">
                <Button
                    variant="secondary"
                    onClick={save}
                    disabled={saving || picked === saved}
                    id="integration-owner-save"
                >
                    {t('save')}
                </Button>
                {picked !== null && (
                    <Button
                        variant="ghost"
                        onClick={() => { setPicked(null); setMsg(null); }}
                        disabled={saving}
                        id="integration-owner-clear"
                    >
                        {t('clear')}
                    </Button>
                )}
            </div>

            {msg && (
                <InlineNotice variant={msg.ok ? 'success' : 'error'} data-testid="integration-owner-message">
                    {msg.text}
                </InlineNotice>
            )}
        </Card>
    );
}
