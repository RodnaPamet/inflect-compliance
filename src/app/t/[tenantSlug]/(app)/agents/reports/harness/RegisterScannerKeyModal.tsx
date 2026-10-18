'use client';

/**
 * Register a scanner's Ed25519 public key (#3687) —
 * `POST /admin/agents/harness-scanner-keys` with `{ agentId, publicKey }`.
 *
 * The agent is chosen from the register, never typed: the candidates are the
 * live, non-retired rows `addHarnessScannerKey` accepts. With none, the dialog
 * says so and offers no submit — an empty picker with a live button would
 * invite a request the API can only refuse.
 *
 * The server checks the key (it must decode to 32 raw bytes) and refuses a
 * key already registered (409); either refusal is shown inline as the server
 * worded it, and the dialog stays open.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import type { HarnessScannerKeysView } from '@/lib/agentic/harness-read-model';

/** The register schema's own bound on the field. */
const PUBLIC_KEY_MAX_CHARS = 256;

export function RegisterScannerKeyModal({
    candidates,
    onClose,
}: {
    candidates: HarnessScannerKeysView['candidates'];
    onClose: () => void;
}) {
    const t = useTranslations('agents');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();

    const [agent, setAgent] = useState<ComboboxOption | null>(null);
    const [publicKey, setPublicKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const options: ComboboxOption[] = candidates.rows.map((c) => ({ value: c.id, label: c.name }));
    const noCandidates = options.length === 0;
    const trimmedKey = publicKey.trim();
    const canSubmit = agent !== null && trimmedKey.length > 0 && trimmedKey.length <= PUBLIC_KEY_MAX_CHARS && !busy;

    const submit = async () => {
        if (!canSubmit || agent === null) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/agents/harness-scanner-keys'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: agent.value, publicKey: trimmedKey }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                const message = apiErrorMessage(body, t('harness.keysModal.failed'));
                setError(message);
                toast.error(message);
                return;
            }
            toast.success(t('harness.keysModal.saved'));
            onClose();
            router.refresh();
        } catch {
            const message = t('harness.keysModal.failed');
            setError(message);
            toast.error(message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            showModal
            setShowModal={(v) => {
                if (!v && !busy) onClose();
            }}
            size="md"
            title={t('harness.keysModal.title')}
            preventDefaultClose={busy}
        >
            <Modal.Header title={t('harness.keysModal.title')} description={t('harness.keysModal.description')} />
            <Modal.Form
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <Modal.Body>
                    <div className="space-y-default" data-testid="harness-key-register-modal">
                        {error && (
                            <InlineNotice variant="error" data-testid="harness-key-register-error">
                                {error}
                            </InlineNotice>
                        )}
                        {noCandidates ? (
                            <InlineNotice
                                variant="warning"
                                title={t('harness.keysModal.noCandidates')}
                                data-testid="harness-key-no-candidates"
                            >
                                {t('harness.keysModal.noCandidatesHint')}
                            </InlineNotice>
                        ) : (
                            <FormField label={t('harness.keysModal.agentLabel')} required>
                                <Combobox
                                    id="harness-key-agent"
                                    options={options}
                                    selected={agent}
                                    setSelected={setAgent}
                                    placeholder={t('harness.keysModal.agentPlaceholder')}
                                    searchPlaceholder={t('harness.keysModal.agentSearch')}
                                    matchTriggerWidth
                                    forceDropdown
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>
                        )}
                        {candidates.truncated && (
                            <InlineNotice variant="info" icon={null} data-testid="harness-key-agents-truncated">
                                {t('harness.keysModal.agentsTruncated', { count: candidates.rows.length })}
                            </InlineNotice>
                        )}
                        <FormField
                            label={t('harness.keysModal.publicKeyLabel')}
                            description={t('harness.keysModal.publicKeyHint')}
                            required
                        >
                            <Input
                                id="harness-key-public-key"
                                className="font-mono"
                                autoComplete="off"
                                spellCheck={false}
                                maxLength={PUBLIC_KEY_MAX_CHARS}
                                value={publicKey}
                                onChange={(e) => setPublicKey(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
                        {tCommon('cancel')}
                    </Button>
                    <Button type="submit" variant="primary" disabled={!canSubmit} data-testid="harness-key-register-submit">
                        {busy ? t('harness.keysModal.saving') : t('harness.keysModal.submit')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
