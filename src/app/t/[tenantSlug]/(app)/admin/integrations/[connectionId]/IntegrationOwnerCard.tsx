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
 * provider. The card decides from the connection's PROVIDER, which the page
 * passes in from its own read of the connection — the stored owner comes with
 * it, so what the card shows is what is saved. It used to download every
 * connection in the workspace to learn this one's provider, and hid itself
 * silently when that read failed (#4870).
 *
 * ═══ NOTHING IS SAVED UNTIL SAVE IS PRESSED ═══
 *
 * Picking a person, or clearing the picker, changes local state only. The
 * write is its own route rather than a field on the connection upsert: the
 * upsert defaults `isEnabled` to true, so naming an owner through it would
 * re-enable a disabled connection. The server refuses an owner without an
 * ACTIVE membership of this tenant; the refusal is shown, not swallowed.
 */
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantApiUrl, useTenantContext } from '@/lib/tenant-context-provider';
import { UserCombobox } from '@/components/ui/user-combobox';
import { FormField } from '@/components/ui/form-field';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import { apiErrorMessage } from '@/lib/api-error';
import type { ConnectionHeader } from './connection-header';

const MCP_SERVER_PROVIDER = 'mcp-server';

export function IntegrationOwnerCard({ connection }: { connection: ConnectionHeader }) {
    const t = useTranslations('admin.integrations.owner');
    const apiUrl = useTenantApiUrl();
    const { tenantSlug } = useTenantContext();
    const connectionId = connection.id;

    /** The owner as stored. */
    const [saved, setSaved] = useState<string | null>(connection.ownerUserId);
    /** The owner as picked. Local until Save. */
    const [picked, setPicked] = useState<string | null>(connection.ownerUserId);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

    const save = useCallback(async () => {
        setSaving(true);
        setMsg(null);
        try {
            const res = await fetch(apiUrl(`/admin/integrations/${connectionId}/owner`), {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ownerUserId: picked }),
            });
            if (!res.ok) {
                // The server's own sentence: the active-member rule is one
                // refusal among several (a 403, a missing connection).
                const refusal = await res.json().catch(() => null);
                setMsg({ ok: false, text: apiErrorMessage(refusal, t('saveFailed')) });
                return;
            }
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

    if (connection.provider !== MCP_SERVER_PROVIDER) return null;

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
