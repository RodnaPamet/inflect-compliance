'use client';

/**
 * CONNECT A SCANNER (owner decisions, 2026-11-24).
 *
 * One panel for the Inflect half of setting up scanent: choose the scanner's
 * registered agent, register its public key, choose the reports it posts, and
 * create ONE API key bound to that agent carrying the scope of every ticked
 * report. It then shows what to put into scanent's `config.json` and
 * `scanent.env`.
 *
 * It calls the routes that already exist, and adds none:
 *
 *   1. `POST /admin/agents/harness-scanner-keys` — the public key, when one is
 *      pasted (an agent that already has a key may skip it);
 *   2. `POST /admin/agents/:id/tools` — `get_harness_register`, only when
 *      "Also read the register" is ticked and the agent is not granted it yet;
 *   3. `POST /admin/api-keys` — the one key, with its `admin.manage` gate and
 *      its key-creation rate limit. There is no second minting path.
 *
 * They run in that order, and a failure stops the steps after it with the
 * server's own sentence. What already holds is skipped, never repeated.
 *
 * An agent that is not ACTIVE cannot carry a key: the panel says what
 * activation still asks of it and links to its page. It never activates it.
 *
 * The key lives in this component's state and nowhere else; the card unmounts
 * the panel on close, so the key goes with it. The snippets are built here, in
 * the browser, with a placeholder where the key goes.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { CopyButton } from '@/components/ui/copy-button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl, useTenantContext, useTenantHref } from '@/lib/tenant-context-provider';
import type { HarnessScannerKeysView } from '@/lib/agentic/harness-read-model';
import {
    postsAnyReport,
    scannerAgentBlock,
    scannerConfigBlock,
    scannerEnvLines,
    scannerKeyCeiling,
    scannerKeyRequiresExchange,
    scannerKeyScopes,
    type ScannerConnectSelection,
} from '@/lib/agentic/scanner-connect';

/** The register schema's own bound on the field. */
const PUBLIC_KEY_MAX_CHARS = 256;

/** The one MCP tool a scanner calls. */
const REGISTER_TOOL = 'get_harness_register';

/** The step a failure stopped at. */
type FailedStep = 'publicKey' | 'grant' | 'key';

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

async function failureOf(res: Response, fallback: string): Promise<string> {
    const body: unknown = await res.json().catch(() => null);
    return apiErrorMessage(body, fallback);
}

export function ConnectScannerSheet({
    view,
    onClose,
}: {
    view: HarnessScannerKeysView;
    onClose: () => void;
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const href = useTenantHref();
    const { tenantSlug } = useTenantContext();
    const router = useRouter();
    const { canMintKeys, canGrantTools } = view.connect;

    const options: ComboboxOption[] = view.candidates.rows.map((c) => ({ value: c.id, label: c.name }));
    const [agentOption, setAgentOption] = useState<ComboboxOption | null>(null);
    const agent = view.candidates.rows.find((c) => c.id === agentOption?.value) ?? null;
    const block = agent ? scannerAgentBlock(agent) : null;
    const liveKeys = agent ? view.keys.rows.filter((k) => k.agentId === agent.id && k.revokedAt === null).length : 0;

    const [publicKey, setPublicKey] = useState('');
    const [sel, setSel] = useState<ScannerConnectSelection>({
        agentReport: true,
        integrations: false,
        agentRules: false,
        readRegister: false,
    });
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<{ step: FailedStep; message: string } | null>(null);
    const [done, setDone] = useState<{ publicKey: boolean; grant: boolean }>({ publicKey: false, grant: false });
    const [key, setKey] = useState<string | null>(null);

    const scopes = useMemo(() => scannerKeyScopes(sel), [sel]);
    const trimmedKey = publicKey.trim();
    const needsPublicKey = liveKeys === 0 && !done.publicKey;
    const keyName = name.trim() || (agent ? t('harness.connect.defaultKeyName', { name: agent.name }).slice(0, 100) : '');
    const canSubmit =
        agent !== null &&
        block === null &&
        postsAnyReport(sel) &&
        (!needsPublicKey || trimmedKey.length > 0) &&
        trimmedKey.length <= PUBLIC_KEY_MAX_CHARS &&
        keyName.length > 0 &&
        !busy;

    const toggle = (field: keyof ScannerConnectSelection) => (checked: boolean) =>
        setSel((prev) => ({ ...prev, [field]: checked }));

    const submit = async () => {
        if (!canSubmit || agent === null) return;
        setBusy(true);
        setFailed(null);
        try {
            if (trimmedKey.length > 0 && !done.publicKey) {
                const registration = { agentId: agent.id, publicKey: trimmedKey };
                const res = await fetch(apiUrl('/admin/agents/harness-scanner-keys'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(registration),
                });
                if (!res.ok) {
                    setFailed({ step: 'publicKey', message: await failureOf(res, t('harness.connect.failed.publicKey')) });
                    return;
                }
                setDone((d) => ({ ...d, publicKey: true }));
            }

            if (sel.readRegister && !done.grant) {
                const grants = await fetch(apiUrl(`/admin/agents/${agent.id}/tools`));
                if (!grants.ok) {
                    setFailed({ step: 'grant', message: await failureOf(grants, t('harness.connect.failed.grant')) });
                    return;
                }
                const payload = (await grants.json()) as { granted?: Array<{ toolName: string }> };
                if (!(payload.granted ?? []).some((g) => g.toolName === REGISTER_TOOL)) {
                    const grant = { toolName: REGISTER_TOOL };
                    const res = await fetch(apiUrl(`/admin/agents/${agent.id}/tools`), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(grant),
                    });
                    if (!res.ok) {
                        setFailed({ step: 'grant', message: await failureOf(res, t('harness.connect.failed.grant')) });
                        return;
                    }
                }
                setDone((d) => ({ ...d, grant: true }));
            }

            const res = await fetch(apiUrl('/admin/api-keys'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: keyName,
                    scopes: scopes,
                    expiresAt: null,
                    agentId: agent.id,
                    maxAutonomyLevel: scannerKeyCeiling(agent.autonomyLevel),
                    requiresTokenExchange: scannerKeyRequiresExchange(sel),
                }),
            });
            if (!res.ok) {
                setFailed({ step: 'key', message: await failureOf(res, t('harness.connect.failed.key')) });
                return;
            }
            const created = (await res.json()) as { plaintext: string };
            setKey(created.plaintext);
        } catch {
            setFailed({ step: 'key', message: t('harness.connect.failed.network') });
        } finally {
            setBusy(false);
        }
    };

    const close = () => {
        if (busy) return;
        // The key list changed when a public key was registered.
        if (done.publicKey) router.refresh();
        onClose();
    };

    const origin = typeof window === 'undefined' ? '' : window.location.origin;
    const copyLabel = t('harness.connect.copy');
    const title = t('harness.connect.title');

    return (
        <Sheet open onOpenChange={(open) => { if (!open) close(); }} title={title}>
            <Sheet.Header>
                <Sheet.Title>{title}</Sheet.Title>
                <Sheet.Description>{t('harness.connect.description')}</Sheet.Description>
            </Sheet.Header>
            <Sheet.Body>
                <div className="space-y-default" data-testid="connect-scanner-sheet">
                    {!canMintKeys ? (
                        <InlineNotice variant="info" data-testid="connect-scanner-blocked-permission">
                            {t('harness.connect.blocked.permission')}
                        </InlineNotice>
                    ) : key !== null && agent !== null ? (
                        <>
                            <InlineNotice variant="warning" title={t('harness.connect.keyOnce')} data-testid="connect-scanner-key">
                                <div className="flex items-center gap-tight">
                                    <code className="flex-1 select-all break-all rounded px-2 py-1 font-mono text-xs">{key}</code>
                                    <CopyButton value={key} label={t('harness.connect.copyKey')} />
                                </div>
                            </InlineNotice>
                            <Heading level={3}>{t('harness.connect.envHeading')}</Heading>
                            <p className="text-sm text-content-muted">{t('harness.connect.envIntro')}</p>
                            <CodeBlock code={scannerEnvLines(sel)} testId="connect-scanner-env" copyLabel={copyLabel} />
                            <Heading level={3}>{t('harness.connect.configHeading')}</Heading>
                            <p className="text-sm text-content-muted">
                                {sel.readRegister ? t('harness.connect.configIntroRegister') : t('harness.connect.configIntro')}
                            </p>
                            <CodeBlock
                                code={JSON.stringify(scannerConfigBlock({ origin, tenantSlug, agentId: agent.id, sel }), null, 2)}
                                testId="connect-scanner-config"
                                copyLabel={copyLabel}
                            />
                            <div className="flex justify-end">
                                <Button type="button" variant="secondary" size="sm" onClick={close} data-testid="connect-scanner-done">
                                    {t('harness.connect.done')}
                                </Button>
                            </div>
                        </>
                    ) : (
                        <form
                            className="space-y-default"
                            data-testid="connect-scanner-form"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void submit();
                            }}
                        >
                            {failed ? (
                                <InlineNotice
                                    variant="error"
                                    title={t(`harness.connect.failedAt.${failed.step}`)}
                                    data-testid={`connect-scanner-error-${failed.step}`}
                                >
                                    {failed.message}
                                </InlineNotice>
                            ) : null}

                            {options.length === 0 ? (
                                <InlineNotice variant="warning" data-testid="connect-scanner-no-candidates">
                                    {t('harness.connect.registerHasNoScanner')}
                                </InlineNotice>
                            ) : (
                                <FormField label={t('harness.connect.agentLabel')} description={t('harness.connect.agentHint')} required>
                                    <Combobox
                                        id="connect-scanner-agent"
                                        options={options}
                                        selected={agentOption}
                                        setSelected={(opt) => {
                                            setAgentOption(opt);
                                            setFailed(null);
                                            setDone({ publicKey: false, grant: false });
                                        }}
                                        placeholder={t('harness.connect.agentPlaceholder')}
                                        searchPlaceholder={t('harness.connect.agentSearch')}
                                        matchTriggerWidth
                                        forceDropdown
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                            )}

                            {agent !== null && block !== null ? (
                                <InlineNotice variant="info" data-testid={`connect-scanner-agent-${block}`}>
                                    {t(`harness.connect.agentBlocked.${block}`, { name: agent.name })}{' '}
                                    <Link className="underline" href={href(`/agents/${agent.id}`)}>
                                        {t('harness.connect.openAgent')}
                                    </Link>
                                </InlineNotice>
                            ) : null}

                            {agent !== null && block === null ? (
                                <>
                                    <FormField
                                        label={t('harness.connect.publicKeyLabel')}
                                        description={
                                            liveKeys > 0
                                                ? t('harness.connect.publicKeyHintHasKey', { count: liveKeys })
                                                : t('harness.connect.publicKeyHint')
                                        }
                                        required={needsPublicKey}
                                    >
                                        <Input
                                            id="connect-scanner-public-key"
                                            className="font-mono"
                                            autoComplete="off"
                                            spellCheck={false}
                                            maxLength={PUBLIC_KEY_MAX_CHARS}
                                            value={publicKey}
                                            onChange={(e) => setPublicKey(e.target.value)}
                                            disabled={busy || done.publicKey}
                                        />
                                    </FormField>

                                    <div className="space-y-tight" role="group" aria-labelledby="connect-scanner-reports-label">
                                        <p id="connect-scanner-reports-label" className="text-sm font-medium text-content-emphasis">
                                            {t('harness.connect.reportsLabel')}
                                        </p>
                                        {(['agentReport', 'integrations', 'agentRules'] as const).map((field) => (
                                            <label key={field} className="flex items-start gap-tight text-sm text-content-default">
                                                <Checkbox
                                                    id={`connect-scanner-${field}`}
                                                    checked={sel[field]}
                                                    disabled={busy}
                                                    onCheckedChange={(c) => toggle(field)(c === true)}
                                                />
                                                <span>{t(`harness.connect.report.${field}`)}</span>
                                            </label>
                                        ))}
                                        {canGrantTools ? (
                                            <label className="flex items-start gap-tight text-sm text-content-default">
                                                <Checkbox
                                                    id="connect-scanner-readRegister"
                                                    checked={sel.readRegister}
                                                    disabled={busy}
                                                    onCheckedChange={(c) => toggle('readRegister')(c === true)}
                                                />
                                                <span>{t('harness.connect.report.readRegister')}</span>
                                            </label>
                                        ) : null}
                                        {!postsAnyReport(sel) ? (
                                            <p className="text-xs text-content-error" data-testid="connect-scanner-none-ticked">
                                                {t('harness.connect.noneTicked')}
                                            </p>
                                        ) : null}
                                    </div>

                                    <FormField label={t('harness.connect.keyName')}>
                                        <Input
                                            id="connect-scanner-key-name"
                                            value={name}
                                            placeholder={t('harness.connect.defaultKeyName', { name: agent.name }).slice(0, 100)}
                                            maxLength={100}
                                            onChange={(e) => setName(e.target.value)}
                                            disabled={busy}
                                        />
                                    </FormField>

                                    <FormField label={t('harness.connect.scopes')} description={t('harness.connect.scopesHint')}>
                                        <p className="font-mono text-xs text-content-default" data-testid="connect-scanner-scopes">
                                            {scopes.join(', ')}
                                        </p>
                                    </FormField>
                                </>
                            ) : null}

                            <div className="flex flex-wrap justify-end gap-tight">
                                <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={close}>
                                    {t('harness.connect.cancel')}
                                </Button>
                                <Button
                                    type="submit"
                                    variant="secondary"
                                    size="sm"
                                    disabled={!canSubmit}
                                    data-testid="connect-scanner-submit"
                                >
                                    {busy ? t('harness.connect.connecting') : t('harness.connect.submit')}
                                </Button>
                            </div>
                        </form>
                    )}
                </div>
            </Sheet.Body>
        </Sheet>
    );
}
