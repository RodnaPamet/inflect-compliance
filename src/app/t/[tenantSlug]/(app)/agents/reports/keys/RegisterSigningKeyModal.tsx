'use client';

/**
 * Register an Ed25519 public key in one of the three signing-key registers on
 * `/agents/reports` — ONE dialog for all three, because they ask the same
 * thing (step 8b; the scanner register's own dialog since #3687):
 *
 *   - `scanner`  — `POST /admin/agents/harness-scanner-keys` `{ agentId, publicKey }`
 *   - `prober`   — `POST /admin/agents/prober-keys` `{ agentId, publicKey }`
 *   - `approver` — `POST /admin/probe-approver-keys` `{ label, publicKey }`
 *
 * An agent is chosen from the register, never typed: the candidates are the
 * live, non-retired rows the usecase accepts. With none, the dialog says so and
 * offers no submit — an empty picker with a live button would invite a request
 * the API can only refuse. An approver key belongs to no agent; it names who
 * holds it instead.
 *
 * The server checks the key (32 raw bytes), and refuses one already registered
 * and, for the two probe registers, one live in the other (409). Every refusal
 * is shown inline as the server worded it, and the dialog stays open.
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

/** The register schemas' own bounds. */
const PUBLIC_KEY_MAX_CHARS = 256;
const LABEL_MAX_CHARS = 120;

export type SigningKeyRegister = 'scanner' | 'prober' | 'approver';

/** The agents a key may be bound to, as the card's server read listed them. */
export interface SigningKeyCandidates {
    readonly rows: readonly { readonly id: string; readonly name: string }[];
    readonly truncated: boolean;
}

const REGISTER: Readonly<
    Record<
        SigningKeyRegister,
        {
            endpoint: string;
            /** Prefix of every element id and test id, kept from each card's own history. */
            prefix: string;
            /** Where the dialog's words live under `agents`. */
            copy: string;
            titleKey: string;
            descriptionKey: string;
        }
    >
> = {
    scanner: {
        endpoint: '/admin/agents/harness-scanner-keys',
        prefix: 'harness-key',
        copy: 'harness.keysModal',
        titleKey: 'harness.keysModal.title',
        descriptionKey: 'harness.keysModal.description',
    },
    prober: {
        endpoint: '/admin/agents/prober-keys',
        prefix: 'prober-key',
        copy: 'reports.probes.registerModal',
        titleKey: 'reports.probes.registerModal.prober.title',
        descriptionKey: 'reports.probes.registerModal.prober.description',
    },
    approver: {
        endpoint: '/admin/probe-approver-keys',
        prefix: 'approver-key',
        copy: 'reports.probes.registerModal',
        titleKey: 'reports.probes.registerModal.approver.title',
        descriptionKey: 'reports.probes.registerModal.approver.description',
    },
};

type Props =
    | { register: 'scanner' | 'prober'; candidates: SigningKeyCandidates; onClose: () => void }
    | { register: 'approver'; onClose: () => void };

export function RegisterSigningKeyModal(props: Props) {
    const { register, onClose } = props;
    const t = useTranslations('agents');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();
    const { endpoint, prefix, copy, titleKey, descriptionKey } = REGISTER[register];
    const c = (key: string) => `${copy}.${key}`;

    const [agent, setAgent] = useState<ComboboxOption | null>(null);
    const [label, setLabel] = useState('');
    const [publicKey, setPublicKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const candidates = props.register === 'approver' ? null : props.candidates;
    const options: ComboboxOption[] = candidates ? candidates.rows.map((r) => ({ value: r.id, label: r.name })) : [];
    const trimmedKey = publicKey.trim();
    const trimmedLabel = label.trim();
    const keyOk = trimmedKey.length > 0 && trimmedKey.length <= PUBLIC_KEY_MAX_CHARS;
    const subjectOk = candidates ? agent !== null : trimmedLabel.length > 0 && trimmedLabel.length <= LABEL_MAX_CHARS;
    const canSubmit = keyOk && subjectOk && !busy;

    const submit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl(endpoint), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                    candidates ? { agentId: agent?.value, publicKey: trimmedKey } : { label: trimmedLabel, publicKey: trimmedKey },
                ),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                const message = apiErrorMessage(body, t(c('failed')));
                setError(message);
                toast.error(message);
                return;
            }
            toast.success(t(c('saved')));
            onClose();
            router.refresh();
        } catch {
            const message = t(c('failed'));
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
            title={t(titleKey)}
            preventDefaultClose={busy}
        >
            <Modal.Header title={t(titleKey)} description={t(descriptionKey)} />
            <Modal.Form
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <Modal.Body>
                    <div className="space-y-default" data-testid={`${prefix}-register-modal`}>
                        {error && (
                            <InlineNotice variant="error" data-testid={`${prefix}-register-error`}>
                                {error}
                            </InlineNotice>
                        )}
                        {candidates &&
                            (options.length === 0 ? (
                                <InlineNotice variant="warning" title={t(c('noCandidates'))} data-testid={`${prefix}-no-candidates`}>
                                    {t(c('noCandidatesHint'))}
                                </InlineNotice>
                            ) : (
                                <FormField label={t(c('agentLabel'))} required>
                                    <Combobox
                                        id={`${prefix}-agent`}
                                        options={options}
                                        selected={agent}
                                        setSelected={setAgent}
                                        placeholder={t(c('agentPlaceholder'))}
                                        searchPlaceholder={t(c('agentSearch'))}
                                        matchTriggerWidth
                                        forceDropdown
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                            ))}
                        {candidates?.truncated && (
                            <InlineNotice variant="info" icon={null} data-testid={`${prefix}-agents-truncated`}>
                                {t(c('agentsTruncated'), { count: candidates.rows.length })}
                            </InlineNotice>
                        )}
                        {!candidates && (
                            <FormField label={t(c('labelLabel'))} description={t(c('labelHint'))} required>
                                <Input
                                    id={`${prefix}-label`}
                                    autoComplete="off"
                                    maxLength={LABEL_MAX_CHARS}
                                    value={label}
                                    onChange={(e) => setLabel(e.target.value)}
                                    disabled={busy}
                                />
                            </FormField>
                        )}
                        <FormField label={t(c('publicKeyLabel'))} description={t(c('publicKeyHint'))} required>
                            <Input
                                id={`${prefix}-public-key`}
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
                    <Button type="submit" variant="primary" disabled={!canSubmit} data-testid={`${prefix}-register-submit`}>
                        {busy ? t(c('saving')) : t(c('submit'))}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
