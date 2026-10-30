'use client';

/**
 * CONNECT AN AGENT YOU RUN (Step 3a of `docs/claude-agent-sdk-design.md`, #4155).
 *
 * Mints an API key bound to this agent and hands the customer the configuration
 * that points their own agent at Inflect's `/api/mcp`: Agent SDK options in
 * TypeScript and Python, or what to paste into Anthropic's Console for a
 * Managed Agent. The customer types no command.
 *
 * The mint is the api-keys route itself, `POST /admin/api-keys`, with its
 * `admin.manage` gate and its key-creation rate limit. There is no second
 * minting path. What this sheet decides is only what it ASKS for:
 *
 *   • the scopes the agent's grants need, and no more (`connectKeyScopes`);
 *   • this agent as the binding;
 *   • an autonomy ceiling no higher than the agent's own level. The options
 *     stop at that level, and the usecase refuses anything above it.
 *
 * The key lives in this component's state and nowhere else. The parent
 * unmounts the sheet on close, so the key goes with it. The snippets are built
 * here, in the browser, and read the key from an environment variable, so no
 * request after the mint carries it.
 *
 * The actions sit at the end of the body, not in a `Sheet.Footer`, for the same
 * reason the behaviour editor gives: a footer's last action must be a primary,
 * and the page has no primary to spend.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { CopyButton } from '@/components/ui/copy-button';
import { ErrorState } from '@/components/ui/error-state';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Heading } from '@/components/ui/typography';
import { SkeletonCard } from '@/components/ui/skeleton';
import { PanelTabs } from '@/components/controls-shared/PanelTabs';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import {
    INFLECT_KEY_ENV,
    agentSdkPython,
    agentSdkTypeScript,
    connectKeyScopes,
    managedAgentConfig,
    unscopedGrants,
} from '@/lib/agentic/connect-wizard';

/** The part of the agent the wizard reads. */
export interface ConnectAgentSubject {
    id: string;
    name: string;
    status: string;
    autonomyLevel: number;
}

interface GrantsPayload {
    granted: Array<{ toolName: string }>;
}

type ConnectTab = 'sdk' | 'console';

/** Why the sheet explains rather than mints. */
type Blocked = 'permission' | 'grantsUnreadable' | 'inactive' | 'grantsEmpty';

/** L0 up to the agent's own level, and never above it. */
const ceilingOptions = (agentLevel: number): ComboboxOption[] =>
    Array.from({ length: agentLevel + 1 }, (_, level) => ({ value: String(level), label: `L${level}` }));

function CodeBlock({ code, testId, copyLabel }: { code: string; testId: string; copyLabel: string }) {
    return (
        <div className="relative">
            <pre
                className="max-h-80 overflow-auto whitespace-pre rounded border border-border-subtle p-3 pr-10 text-xs text-content-default"
                data-testid={testId}
            >
                {code}
            </pre>
            <div className="absolute right-2 top-2">
                <CopyButton value={code} label={copyLabel} />
            </div>
        </div>
    );
}

export function ConnectAgentSheet({
    agent,
    canMintKeys,
    canReadGrants,
    onClose,
}: {
    agent: ConnectAgentSubject;
    /** `admin.manage` AND the role-tier admin check `createApiKey` asserts. */
    canMintKeys: boolean;
    /** `admin.agent_tool_exposure`, which the grants read takes. */
    canReadGrants: boolean;
    onClose: () => void;
}) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();

    const { data, error, isLoading } = useTenantSWR<GrantsPayload>(
        canMintKeys && canReadGrants && agent.status === 'ACTIVE' ? `/admin/agents/${agent.id}/tools` : null,
    );
    const grantedTools = useMemo(() => (data?.granted ?? []).map((g) => g.toolName), [data]);
    const keyScopes = useMemo(() => connectKeyScopes(grantedTools), [grantedTools]);
    const unscoped = useMemo(() => unscopedGrants(grantedTools), [grantedTools]);

    const [name, setName] = useState(() => t('agentDetail.connect.defaultKeyName', { name: agent.name }).slice(0, 100));
    const [ceiling, setCeiling] = useState(String(agent.autonomyLevel));
    const [busy, setBusy] = useState(false);
    const [mintError, setMintError] = useState<string | null>(null);
    const [key, setKey] = useState<string | null>(null);
    const [tab, setTab] = useState<ConnectTab>('sdk');

    const origin = typeof window === 'undefined' ? '' : window.location.origin;
    const config = useMemo(() => ({ origin, grantedTools }), [origin, grantedTools]);

    const blocked: Blocked | null = !canMintKeys
        ? 'permission'
        : !canReadGrants
          ? 'grantsUnreadable'
          : agent.status !== 'ACTIVE'
            ? 'inactive'
            : data && grantedTools.length === 0
              ? 'grantsEmpty'
              : null;

    const mint = async () => {
        setBusy(true);
        setMintError(null);
        try {
            const res = await fetch(apiUrl('/admin/api-keys'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim(),
                    scopes: keyScopes,
                    expiresAt: null,
                    agentId: agent.id,
                    maxAutonomyLevel: Number(ceiling),
                }),
            });
            if (!res.ok) {
                const payload: unknown = await res.json().catch(() => null);
                setMintError(apiErrorMessage(payload, t('agentDetail.connect.mintFailed')));
                return;
            }
            const created = (await res.json()) as { plaintext: string };
            setKey(created.plaintext);
        } catch {
            setMintError(t('agentDetail.connect.mintFailed'));
        } finally {
            setBusy(false);
        }
    };

    const title = t('agentDetail.connect.title', { name: agent.name });
    const copyLabel = t('agentDetail.connect.copy');

    return (
        <Sheet open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={title}>
            <Sheet.Header>
                <Sheet.Title>{title}</Sheet.Title>
                <Sheet.Description>{t('agentDetail.connect.description')}</Sheet.Description>
            </Sheet.Header>
            <Sheet.Body>
                <div className="space-y-default" data-testid="connect-agent-sheet">
                    {blocked ? (
                        <InlineNotice variant="info" data-testid={`connect-agent-blocked-${blocked}`}>
                            {t(`agentDetail.connect.blocked.${blocked}`)}
                        </InlineNotice>
                    ) : error ? (
                        <ErrorState
                            title={t('agentDetail.connect.grantsFailedTitle')}
                            description={t('agentDetail.connect.grantsFailedBody')}
                        />
                    ) : isLoading || !data ? (
                        <SkeletonCard lines={3} />
                    ) : key === null ? (
                        <form
                            className="space-y-default"
                            data-testid="connect-agent-form"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void mint();
                            }}
                        >
                            {mintError ? (
                                <InlineNotice variant="error" data-testid="connect-agent-error">{mintError}</InlineNotice>
                            ) : null}
                            <FormField label={t('agentDetail.connect.keyName')} required>
                                <Input
                                    id="connect-agent-key-name"
                                    value={name}
                                    maxLength={100}
                                    onChange={(e) => setName(e.target.value)}
                                    disabled={busy}
                                />
                            </FormField>
                            <FormField
                                label={t('agentDetail.connect.ceiling')}
                                description={t('agentDetail.connect.ceilingHint', { level: agent.autonomyLevel })}
                            >
                                <Combobox
                                    id="connect-agent-ceiling"
                                    hideSearch
                                    options={ceilingOptions(agent.autonomyLevel)}
                                    selected={ceilingOptions(agent.autonomyLevel).find((o) => o.value === ceiling) ?? null}
                                    setSelected={(opt) => {
                                        if (opt) setCeiling(opt.value);
                                    }}
                                    matchTriggerWidth
                                />
                            </FormField>
                            <FormField
                                label={t('agentDetail.connect.scopes')}
                                description={t('agentDetail.connect.scopesHint')}
                            >
                                <p className="font-mono text-xs text-content-default" data-testid="connect-agent-scopes">
                                    {keyScopes.join(', ')}
                                </p>
                            </FormField>
                            {unscoped.length > 0 ? (
                                <InlineNotice variant="warning" data-testid="connect-agent-unscoped">
                                    {t('agentDetail.connect.unscoped', { tools: unscoped.join(', ') })}
                                </InlineNotice>
                            ) : null}
                            <div className="flex flex-wrap justify-end gap-tight">
                                <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onClose}>
                                    {t('agentDetail.connect.cancel')}
                                </Button>
                                <Button
                                    type="submit"
                                    variant="secondary"
                                    size="sm"
                                    disabled={busy || name.trim().length === 0}
                                    data-testid="connect-agent-mint"
                                >
                                    {busy ? t('agentDetail.connect.minting') : t('agentDetail.connect.mint')}
                                </Button>
                            </div>
                        </form>
                    ) : (
                        <>
                            <InlineNotice variant="warning" title={t('agentDetail.connect.keyOnce')} data-testid="connect-agent-key">
                                <div className="flex items-center gap-tight">
                                    <code className="flex-1 select-all break-all rounded px-2 py-1 font-mono text-xs">{key}</code>
                                    <CopyButton value={key} label={t('agentDetail.connect.copyKey')} />
                                </div>
                                <p className="mt-tight text-xs">{t('agentDetail.connect.keyEnv', { env: INFLECT_KEY_ENV })}</p>
                            </InlineNotice>
                            <PanelTabs<ConnectTab>
                                tabs={[
                                    { id: 'sdk', label: t('agentDetail.connect.tabSdk') },
                                    { id: 'console', label: t('agentDetail.connect.tabConsole') },
                                ]}
                                active={tab}
                                onSelect={setTab}
                            />
                            {tab === 'sdk' ? (
                                <div className="space-y-default" data-testid="connect-agent-sdk">
                                    <p className="text-sm text-content-muted">{t('agentDetail.connect.sdkIntro')}</p>
                                    <Heading level={3}>{t('agentDetail.connect.typescript')}</Heading>
                                    <CodeBlock code={agentSdkTypeScript(config)} testId="connect-agent-ts" copyLabel={copyLabel} />
                                    <Heading level={3}>{t('agentDetail.connect.python')}</Heading>
                                    <CodeBlock code={agentSdkPython(config)} testId="connect-agent-py" copyLabel={copyLabel} />
                                    <ul className="list-disc space-y-tight pl-5 text-sm text-content-muted" data-testid="connect-agent-sdk-lines">
                                        {(['mcpServers', 'allowedTools', 'tools', 'settingSources', 'strictMcpConfig', 'permissionMode'] as const).map((line) => (
                                            <li key={line}>
                                                <code className="font-mono text-xs text-content-default">{line}</code>{' '}
                                                {t(`agentDetail.connect.line.${line}`)}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ) : (
                                <ConsolePanel config={managedAgentConfig(config)} copyLabel={copyLabel} />
                            )}
                            <div className="flex justify-end">
                                <Button type="button" variant="secondary" size="sm" onClick={onClose} data-testid="connect-agent-done">
                                    {t('agentDetail.connect.done')}
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            </Sheet.Body>
        </Sheet>
    );
}

function ConsolePanel({ config, copyLabel }: { config: ReturnType<typeof managedAgentConfig>; copyLabel: string }) {
    const t = useTranslations('admin');
    const parts = [
        { id: 'server', value: config.mcpServer },
        { id: 'vault', value: config.vaultCredential },
        { id: 'toolset', value: config.mcpToolset },
    ] as const;
    return (
        <div className="space-y-default" data-testid="connect-agent-console">
            <p className="text-sm text-content-muted">{t('agentDetail.connect.consoleIntro')}</p>
            {parts.map((part) => (
                <div key={part.id} className="space-y-tight">
                    <Heading level={3}>{t(`agentDetail.connect.console.${part.id}.title`)}</Heading>
                    <p className="text-sm text-content-muted">{t(`agentDetail.connect.console.${part.id}.explain`)}</p>
                    <CodeBlock code={JSON.stringify(part.value, null, 2)} testId={`connect-agent-console-${part.id}`} copyLabel={copyLabel} />
                </div>
            ))}
        </div>
    );
}
