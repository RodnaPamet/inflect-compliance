'use client';

/**
 * Admin → Integrations: the customer's own Anthropic workspace (Step 5a of
 * docs/claude-managed-agents-design.md).
 *
 * The PAGE decides whether this card exists: it renders it only when the
 * server lists the `anthropic-workspace` provider, which the server does only
 * when `AGENT_MANAGED_AGENTS` is on (the provider is registered behind it). So
 * a deployment with the switch off shows no card, and the generic connection
 * form never offers the provider either (`CARD_OWNED_PROVIDERS`).
 *
 * The card offers three things and no host: the workspace ID, the API key and
 * "Keep sessions in my workspace", OFF unless ticked (owner decision 4). It
 * saves and tests through the same `admin.manage` routes as every other
 * connection, and offers its controls only where those routes would accept the
 * request (`useOffersAdminApiWrite`), exactly as the SharePoint card does.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { useOffersAdminApiWrite } from '@/lib/auth/use-offers-admin-api-write';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

export const ANTHROPIC_WORKSPACE_PROVIDER = 'anthropic-workspace';

export interface AnthropicWorkspaceConnection {
    id: string;
    provider: string;
    isEnabled: boolean;
    configJson: Record<string, unknown> | null;
    lastTestStatus: string | null;
}

interface Props {
    /** This tenant's `anthropic-workspace` connections, from the page's list. */
    connections: AnthropicWorkspaceConnection[];
    /** Reload the page's list after a change. */
    onChanged: () => Promise<void> | void;
}

type Notice = { variant: 'success' | 'error'; text: string } | null;

export function AnthropicWorkspaceCard({ connections, onChanged }: Props) {
    const t = useTranslations('admin.anthropicWorkspace');
    const apiUrl = useTenantApiUrl();
    // The same gate the page and the SharePoint card ask (#4466 finding 9):
    // saving needs `admin.manage` and the usecase's `canAdmin`; testing needs
    // `admin.manage` alone.
    const canConfigure = useOffersAdminApiWrite({ key: 'admin.manage', floor: 'canAdmin' });
    const canOperate = useOffersAdminApiWrite({ key: 'admin.manage' });

    const [workspaceId, setWorkspaceId] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [keepSessions, setKeepSessions] = useState(false);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice>(null);

    const post = (body: unknown, method: 'POST' | 'PUT' | 'DELETE' = 'POST') =>
        fetch(apiUrl('/admin/integrations'), {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

    const connect = async () => {
        if (!workspaceId.trim() || !apiKey.trim()) {
            setNotice({ variant: 'error', text: t('fieldsRequired') });
            return;
        }
        setBusy(true);
        setNotice(null);
        try {
            const res = await post({
                provider: ANTHROPIC_WORKSPACE_PROVIDER,
                name: t('connectionName'),
                configJson: { workspaceId: workspaceId.trim(), keepSessions },
                secrets: { apiKey: apiKey.trim() },
            });
            const data: unknown = await res.json().catch(() => null);
            if (!res.ok) {
                setNotice({ variant: 'error', text: apiErrorMessage(data, t('connectFailed')) });
                return;
            }
            setApiKey('');
            setWorkspaceId('');
            setKeepSessions(false);
            setNotice({ variant: 'success', text: t('connected') });
            await onChanged();
        } catch {
            setNotice({ variant: 'error', text: t('connectFailed') });
        } finally {
            setBusy(false);
        }
    };

    const test = async (conn: AnthropicWorkspaceConnection) => {
        setBusy(true);
        setNotice(null);
        try {
            const res = await post(
                { connectionId: conn.id, provider: conn.provider, configJson: conn.configJson ?? {} },
                'PUT',
            );
            const data = (await res.json().catch(() => null)) as { valid?: boolean; error?: unknown } | null;
            if (res.ok && data?.valid) {
                setNotice({ variant: 'success', text: t('testOk') });
            } else {
                setNotice({
                    variant: 'error',
                    text: t('testFailed', { error: apiErrorMessage(data, t('testFailedUnknown')) }),
                });
            }
            await onChanged();
        } catch {
            setNotice({ variant: 'error', text: t('testFailedUnknown') });
        } finally {
            setBusy(false);
        }
    };

    /** Keep sessions on or off, for a saved connection. The key stays as stored. */
    const setKeep = async (conn: AnthropicWorkspaceConnection, keep: boolean) => {
        setBusy(true);
        setNotice(null);
        try {
            const res = await post({
                id: conn.id,
                provider: conn.provider,
                configJson: { ...(conn.configJson ?? {}), keepSessions: keep },
                isEnabled: conn.isEnabled,
            });
            if (!res.ok) {
                const data: unknown = await res.json().catch(() => null);
                setNotice({ variant: 'error', text: apiErrorMessage(data, t('saveFailed')) });
                return;
            }
            setNotice({ variant: 'success', text: t('saved') });
            await onChanged();
        } catch {
            setNotice({ variant: 'error', text: t('saveFailed') });
        } finally {
            setBusy(false);
        }
    };

    const setEnabled = async (conn: AnthropicWorkspaceConnection, enabled: boolean) => {
        setBusy(true);
        setNotice(null);
        try {
            const res = enabled
                ? await post({
                      id: conn.id,
                      provider: conn.provider,
                      configJson: conn.configJson ?? {},
                      isEnabled: true,
                  })
                : await post({ connectionId: conn.id }, 'DELETE');
            if (!res.ok) {
                const data: unknown = await res.json().catch(() => null);
                setNotice({ variant: 'error', text: apiErrorMessage(data, t('saveFailed')) });
                return;
            }
            await onChanged();
        } catch {
            setNotice({ variant: 'error', text: t('saveFailed') });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card className="space-y-default p-6" id="anthropic-workspace-card">
            <Heading level={2}>{t('title')}</Heading>
            <p className="text-sm text-content-muted">{t('intro')}</p>

            <div className="space-y-tight text-sm text-content-default">
                <p className="font-medium">{t('createsHeading')}</p>
                <ul className="list-disc space-y-tight pl-5">
                    <li>{t('createsAgents')}</li>
                    <li>{t('createsEnvironment')}</li>
                    <li>{t('createsSessions')}</li>
                </ul>
                <p>{t('sessionsDeleted')}</p>
                <p>{t('keptStillDeleted')}</p>
            </div>

            {notice && (
                <InlineNotice variant={notice.variant} data-testid="anthropic-workspace-notice">
                    {notice.text}
                </InlineNotice>
            )}

            {connections.map((conn) => {
                const kept = conn.configJson?.keepSessions === true;
                const wsId = typeof conn.configJson?.workspaceId === 'string' ? conn.configJson.workspaceId : '';
                const status = !conn.isEnabled
                    ? { variant: 'neutral' as const, label: t('statusDisabled') }
                    : conn.lastTestStatus === 'ok'
                      ? { variant: 'success' as const, label: t('statusOk') }
                      : conn.lastTestStatus === 'error'
                        ? { variant: 'error' as const, label: t('statusError') }
                        : { variant: 'neutral' as const, label: t('statusUntested') };
                return (
                    <div
                        key={conn.id}
                        className="space-y-default rounded-md border border-border-subtle p-4"
                        data-testid={`anthropic-workspace-connection-${conn.id}`}
                    >
                        <div className="flex flex-wrap items-center gap-default">
                            <span className="font-medium text-content-default">{t('workspaceLabel', { id: wsId })}</span>
                            <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
                            <div className="ml-auto flex gap-tight">
                                {canOperate && conn.isEnabled && (
                                    <Button variant="ghost" size="sm" onClick={() => test(conn)} disabled={busy}>
                                        {t('test')}
                                    </Button>
                                )}
                                {canConfigure && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setEnabled(conn, !conn.isEnabled)}
                                        disabled={busy}
                                    >
                                        {conn.isEnabled ? t('disable') : t('enable')}
                                    </Button>
                                )}
                            </div>
                        </div>
                        <label className="flex items-center gap-tight text-sm text-content-default">
                            <Checkbox
                                id={`anthropic-keep-sessions-${conn.id}`}
                                checked={kept}
                                disabled={!canConfigure || busy}
                                onCheckedChange={(c) => void setKeep(conn, c === true)}
                            />
                            {t('keepSessions')}
                        </label>
                    </div>
                );
            })}

            {canConfigure && connections.length === 0 && (
                <div className="space-y-default" data-testid="anthropic-workspace-form">
                    <FormField label={t('workspaceId')} description={t('workspaceIdHelp')} required>
                        <Input
                            id="anthropic-workspace-id"
                            value={workspaceId}
                            onChange={(e) => setWorkspaceId(e.target.value)}
                            placeholder={t('workspaceIdPlaceholder')}
                            autoComplete="off"
                        />
                    </FormField>
                    <FormField label={t('apiKey')} description={t('apiKeyHelp')} required>
                        <Input
                            id="anthropic-api-key"
                            type="password"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            autoComplete="off"
                        />
                    </FormField>
                    <div className="space-y-tight">
                        <label className="flex items-center gap-tight text-sm text-content-default">
                            <Checkbox
                                id="anthropic-keep-sessions"
                                checked={keepSessions}
                                onCheckedChange={(c) => setKeepSessions(c === true)}
                            />
                            {t('keepSessions')}
                        </label>
                        <p className="text-xs text-content-muted">{t('keepSessionsHelp')}</p>
                    </div>
                    <div className="flex justify-end">
                        <Button variant="secondary" onClick={connect} disabled={busy} id="anthropic-workspace-connect">
                            {busy ? t('connecting') : t('connect')}
                        </Button>
                    </div>
                </div>
            )}
        </Card>
    );
}
