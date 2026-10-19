'use client';

/**
 * Register a shadow agent from its SHADOW_AGENT finding (#3712) —
 * `POST /admin/agents/intake`, the registration intake of #3669.
 *
 * One request makes a DRAFT register row and a provisional AI-system entry at
 * UNCLASSIFIED. The dialog asks for what a scan cannot observe: who is
 * accountable, and how far the agent reaches.
 *
 * THE OWNER IS A PERSON'S CHOICE, NEVER A SUGGESTION'S. The picker is the
 * shared `<UserCombobox>`, which reads `/users/assignable` — ACTIVE members of
 * this workspace only, the population the intake accepts. It starts EMPTY. An
 * owner suggestion, when one is supplied, is shown above it as read-only
 * provenance in the intake's own person-free shape (what it rested on, never
 * whom it named), so there is nothing in it to copy. The owner must also be
 * CONFIRMED, by a checkbox that names nobody until a person is chosen and is
 * cleared whenever the choice changes, so a confirmation is always of the
 * person on screen. Without both the dialog sends nothing, and the intake would
 * refuse `OWNER_NOT_CONFIRMED` anyway.
 *
 * NO EXPOSURE AXIS IS PRE-SELECTED. The register's own form pre-selects the
 * least-exposing value; here that would under-state the risk of an agent
 * nobody vouched for, so autonomy, data access, reversibility and provenance
 * all start unanswered and the submit waits for every one.
 *
 * THE API STILL DECIDES. A refusal (an owner who is no longer active, an agent
 * registered meanwhile) arrives as the server's sentence, shown inline and as a
 * toast, and the dialog stays open over it.
 *
 * The body is exactly what the strict `RegistrationIntakeSchema` takes: no
 * tier, no questionnaire — the entry is classified on the AI-system page.
 *
 * THE SUGGESTION IS A STORED ONE, AND IT NAMES NOBODY (#3728). A
 * `discovered-agent-review` run's parsed owner suggestion is stored server-side
 * (`DiscoveredAgentAttribution`) and reaches this dialog through the shadow
 * row as status, grade and signals — never the person it named, which the
 * harness tab's payload does not carry (the #3687 rule). The dialog renders it
 * as text, offers to KEEP it (on by default; unticking discards it), and sends
 * `attribution: { runId }` only while it is kept — a run id, from which the
 * intake reads the stored row and records the provenance. Nothing in the
 * suggestion reaches the owner picker.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { UserCombobox, type Member } from '@/components/ui/user-combobox';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { unwrapCappedList, type CappedList } from '@/lib/list-backfill-cap';
import { useTenantApiUrl, useTenantContext } from '@/lib/tenant-context-provider';
import {
    AGENT_AUTONOMY_MAX,
    AGENT_AUTONOMY_MIN,
    AGENT_DATA_ACCESS_SCOPES,
    AGENT_PROVENANCES,
    AGENT_REVERSIBILITIES,
} from '@/app-layer/schemas/agent-registry.schemas';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { redactPointerCredentials, type ShadowRow, type ShadowSuggestion } from '@/lib/agentic/harness-read-model';

/** The intake schema's bounds on the fields this dialog sends. */
const NAME_MIN = 2;
const NAME_MAX = 200;
const TEXT_MAX = 4000;

type Scope = (typeof AGENT_DATA_ACCESS_SCOPES)[number];
type Reversibility = (typeof AGENT_REVERSIBILITIES)[number];
type Provenance = (typeof AGENT_PROVENANCES)[number];
type DeploymentRole = 'DEPLOYER' | 'PROVIDER';

/** What the dialog sends, or `null` while anything required is missing. */
export interface IntakeDraft {
    ownerUserId: string | null;
    confirmOwner: boolean;
    name: string;
    description: string;
    autonomyLevel: number | null;
    dataAccessScope: Scope | null;
    reversibility: Reversibility | null;
    provenance: Provenance | null;
    vendorId: string | null;
    deploymentRole: DeploymentRole;
    purpose: string;
    /**
     * The review run of the stored suggestion the person KEPT, or absent/null
     * when there is none or they discarded it. It becomes `attribution:
     * { runId }` and nothing else: it is a run id, and the owner is not read
     * from it.
     */
    keptSuggestionRunId?: string | null;
}

/**
 * The request body, built ONLY from a complete draft. `null` is "send nothing":
 * no confirmed owner, an unanswered axis, or a third-party agent with no
 * supplier. The owner comes from the draft's owner fields alone — the kept
 * suggestion travels as a run id in `attribution`, and no line here reads an
 * owner from it.
 */
export function intakeRequestBody(findingId: string, d: IntakeDraft): Record<string, unknown> | null {
    const name = d.name.trim();
    if (!d.ownerUserId || d.confirmOwner !== true) return null;
    if (name.length < NAME_MIN || name.length > NAME_MAX) return null;
    if (d.autonomyLevel === null || d.dataAccessScope === null || d.reversibility === null || d.provenance === null) {
        return null;
    }
    if (d.provenance === 'THIRD_PARTY' && !d.vendorId) return null;
    const description = d.description.trim();
    const purpose = d.purpose.trim();
    return {
        findingId,
        ownerUserId: d.ownerUserId,
        confirmOwner: true,
        name,
        ...(description ? { description } : {}),
        autonomyLevel: d.autonomyLevel,
        dataAccessScope: d.dataAccessScope,
        reversibility: d.reversibility,
        provenance: d.provenance,
        ...(d.provenance === 'THIRD_PARTY' ? { vendorId: d.vendorId } : {}),
        deploymentRole: d.deploymentRole,
        ...(purpose ? { purpose } : {}),
        ...(d.keptSuggestionRunId ? { attribution: { runId: d.keptSuggestionRunId } } : {}),
    };
}

const AUTONOMY_LEVELS = Array.from(
    { length: AGENT_AUTONOMY_MAX - AGENT_AUTONOMY_MIN + 1 },
    (_, i) => AGENT_AUTONOMY_MIN + i,
);

/**
 * What an owner suggestion rested on, as the harness tab holds it (#3728) —
 * and nothing more: no person's reference, so there is nothing here to copy
 * into the owner.
 */
export type IntakeSuggestionView = ShadowSuggestion;

export function RegisterShadowAgentModal({
    target,
    suggestion = null,
    onClose,
}: {
    target: ShadowRow;
    /**
     * Read-only provenance, when a suggestion is stored for this agent. The
     * harness tab passes the shadow row's own (`target.suggestion`).
     */
    suggestion?: IntakeSuggestionView | null;
    onClose: () => void;
}) {
    const t = useTranslations('agents');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const { tenantSlug } = useTenantContext();
    const router = useRouter();
    const toast = useToast();

    const [owner, setOwner] = useState<{ id: string; label: string } | null>(null);
    const [confirmOwner, setConfirmOwner] = useState(false);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [autonomyLevel, setAutonomyLevel] = useState<number | null>(null);
    const [dataAccessScope, setDataAccessScope] = useState<Scope | null>(null);
    const [reversibility, setReversibility] = useState<Reversibility | null>(null);
    const [provenance, setProvenance] = useState<Provenance | null>(null);
    const [vendorId, setVendorId] = useState<string | null>(null);
    const [deploymentRole, setDeploymentRole] = useState<DeploymentRole>('DEPLOYER');
    const [purpose, setPurpose] = useState('');
    // Kept unless the person discards it. Keeping records provenance; it never
    // touches the owner state above.
    const [keepSuggestion, setKeepSuggestion] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The vendor register is read only for a third-party agent, the one case
    // the intake requires a supplier.
    const vendors = useTenantSWR<CappedList<{ id: string; name: string }> | { id: string; name: string }[]>(
        provenance === 'THIRD_PARTY' ? '/vendors' : null,
    );
    const vendorOptions: ComboboxOption[] = useMemo(
        () => unwrapCappedList(vendors.data).map((v) => ({ value: v.id, label: v.name })),
        [vendors.data],
    );

    const autonomyOptions: ComboboxOption[] = AUTONOMY_LEVELS.map((n) => ({ value: String(n), label: String(n) }));
    const scopeOptions: ComboboxOption[] = AGENT_DATA_ACCESS_SCOPES.map((s) => ({
        value: s,
        label: t(`register.filterEnums.accessScope.${s}`),
    }));

    const body = intakeRequestBody(target.findingId ?? '', {
        ownerUserId: owner?.id ?? null,
        confirmOwner,
        name,
        description,
        autonomyLevel,
        dataAccessScope,
        reversibility,
        provenance,
        vendorId,
        deploymentRole,
        purpose,
        keptSuggestionRunId: suggestion && keepSuggestion ? suggestion.runId : null,
    });
    const canSubmit = target.findingId !== null && body !== null && !busy;

    const chooseOwner = (userId: string | null, member: Member | null) => {
        // A confirmation is of ONE person: choosing another clears it.
        setConfirmOwner(false);
        setOwner(userId ? { id: userId, label: member?.name ?? member?.email ?? userId } : null);
    };

    const submit = async () => {
        if (!canSubmit || body === null) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/agents/intake'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                // Never `body.error ?? …`: the envelope's `error` is an OBJECT.
                const payload = await res.json().catch(() => null);
                const message = apiErrorMessage(payload, t('harness.registerModal.failed'));
                setError(message);
                toast.error(message);
                return;
            }
            toast.success(t('harness.registerModal.saved'));
            onClose();
            router.refresh();
        } catch {
            const message = t('harness.registerModal.failed');
            setError(message);
            toast.error(message);
        } finally {
            setBusy(false);
        }
    };

    const title = t('harness.registerModal.title');

    return (
        <Modal
            showModal
            setShowModal={(v) => {
                if (!v && !busy) onClose();
            }}
            size="lg"
            title={title}
            preventDefaultClose={busy}
        >
            <Modal.Header
                title={title}
                description={t('harness.registerModal.description', { agent: target.discoveredId })}
            />
            <Modal.Form
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <Modal.Body>
                    <div className="space-y-default" data-testid="harness-register-modal">
                        {error && (
                            <InlineNotice variant="error" data-testid="harness-register-error">
                                {error}
                            </InlineNotice>
                        )}

                        {/* PROVENANCE, read-only. Rendered as text, never as a
                            control, and nothing in it can reach the picker
                            below — it names no person to copy. */}
                        {suggestion && (
                            <InlineNotice
                                variant="info"
                                icon={null}
                                title={t('harness.registerModal.suggestionTitle')}
                                data-testid="harness-register-suggestion"
                            >
                                <p>
                                    {suggestion.status === 'SUGGESTED'
                                        ? t('harness.registerModal.suggestionSuggested', {
                                              grade:
                                                  suggestion.grade === 'STRONG'
                                                      ? t('harness.registerModal.gradeStrong')
                                                      : t('harness.registerModal.gradeWeak'),
                                          })
                                        : suggestion.status === 'AMBIGUOUS'
                                            ? t('harness.registerModal.suggestionAmbiguous')
                                            : suggestion.unmatchedReason === 'OWNER_DEPARTED'
                                                ? t('harness.registerModal.suggestionUnmatchedDeparted')
                                                : t('harness.registerModal.suggestionUnmatchedNoSignal')}
                                </p>
                                {suggestion.signals.length > 0 && (
                                    <ul className="mt-1 space-y-tight text-xs" data-testid="harness-register-suggestion-signals">
                                        {suggestion.signals.map((sig, i) => (
                                            <li key={`${sig.kind}-${i}`}>
                                                <span className="font-mono">{sig.kind}</span>
                                                {' — '}
                                                {/* Model output: text only, with any URL userinfo hidden. */}
                                                <span className="font-mono break-all">{redactPointerCredentials(sig.evidence).text}</span>
                                                {sig.namesPerson && ` (${t('harness.registerModal.signalNamesPerson')})`}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                <p className="mt-1 text-xs text-content-subtle" data-testid="harness-register-suggestion-from">
                                    {t('harness.registerModal.suggestionFrom', {
                                        run: suggestion.runId,
                                        date: formatDateTime(suggestion.runCompletedAt),
                                    })}
                                </p>
                                <p className="mt-1">{t('harness.registerModal.suggestionNever')}</p>
                                <label className="mt-1 flex items-start gap-tight text-sm text-content-default">
                                    <Checkbox
                                        id="harness-register-keep-suggestion"
                                        checked={keepSuggestion}
                                        onCheckedChange={(c) => setKeepSuggestion(c === true)}
                                        disabled={busy}
                                        className="mt-0.5"
                                    />
                                    <span>{t('harness.registerModal.keepSuggestion')}</span>
                                </label>
                            </InlineNotice>
                        )}

                        <FormField
                            label={t('harness.registerModal.ownerLabel')}
                            description={t('harness.registerModal.ownerHint')}
                            required
                        >
                            <UserCombobox
                                id="harness-register-owner"
                                tenantSlug={tenantSlug}
                                selectedId={owner?.id ?? null}
                                onChange={chooseOwner}
                                placeholder={t('register.new.ownerPlaceholder')}
                                disabled={busy}
                            />
                        </FormField>
                        <label className="flex items-start gap-tight text-sm text-content-default">
                            <Checkbox
                                id="harness-register-confirm"
                                checked={confirmOwner}
                                onCheckedChange={(c) => setConfirmOwner(c === true)}
                                disabled={owner === null || busy}
                                className="mt-0.5"
                            />
                            <span>
                                {owner
                                    ? t('harness.registerModal.confirmLabel', { owner: owner.label })
                                    : t('harness.registerModal.confirmNeedsOwner')}
                            </span>
                        </label>

                        <FormField label={t('register.new.nameLabel')} required>
                            <Input
                                id="harness-register-name"
                                type="text"
                                maxLength={NAME_MAX}
                                autoComplete="off"
                                placeholder={t('register.new.namePlaceholder')}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>
                        <FormField label={t('register.new.descriptionLabel')} hint={t('register.new.encryptedHint')}>
                            <Textarea
                                id="harness-register-description"
                                rows={2}
                                maxLength={TEXT_MAX}
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>

                        <div className="space-y-default rounded-lg border border-border-subtle bg-bg-subtle p-3">
                            <p className="text-sm font-medium text-content-emphasis">
                                {t('harness.registerModal.axesHeading')}
                            </p>
                            <p className="text-xs text-content-subtle">{t('harness.registerModal.axesHint')}</p>
                            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                                <FormField
                                    label={t('register.new.autonomyLabel')}
                                    hint={t('register.new.autonomyHint')}
                                    required
                                >
                                    <Combobox
                                        id="harness-register-autonomy"
                                        options={autonomyOptions}
                                        selected={autonomyOptions.find((o) => o.value === String(autonomyLevel)) ?? null}
                                        setSelected={(o) => setAutonomyLevel(o ? Number(o.value) : null)}
                                        placeholder={t('harness.registerModal.choose')}
                                        hideSearch
                                        matchTriggerWidth
                                        forceDropdown
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                                <FormField label={t('register.new.accessLabel')} required>
                                    <Combobox
                                        id="harness-register-access"
                                        options={scopeOptions}
                                        selected={scopeOptions.find((o) => o.value === dataAccessScope) ?? null}
                                        setSelected={(o) => setDataAccessScope((o?.value as Scope | undefined) ?? null)}
                                        placeholder={t('harness.registerModal.choose')}
                                        hideSearch
                                        matchTriggerWidth
                                        forceDropdown
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                            </div>
                            <div className="space-y-tight">
                                <p id="harness-register-reversibility-label" className="text-sm font-medium text-content-emphasis">
                                    {t('register.new.reversibilityLabel')}
                                </p>
                                <RadioGroup
                                    value={reversibility ?? ''}
                                    onValueChange={(v) => setReversibility(v as Reversibility)}
                                    aria-labelledby="harness-register-reversibility-label"
                                    disabled={busy}
                                >
                                    {AGENT_REVERSIBILITIES.map((r) => (
                                        <label key={r} className="flex items-center gap-tight text-sm">
                                            <RadioGroupItem id={`harness-register-reversibility-${r}`} value={r} size="sm" />
                                            {t(`register.reversibility.${r}`)}
                                        </label>
                                    ))}
                                </RadioGroup>
                            </div>
                            <div className="space-y-tight">
                                <p id="harness-register-provenance-label" className="text-sm font-medium text-content-emphasis">
                                    {t('register.new.provenanceLabel')}
                                </p>
                                <RadioGroup
                                    value={provenance ?? ''}
                                    onValueChange={(v) => {
                                        setProvenance(v as Provenance);
                                        if (v !== 'THIRD_PARTY') setVendorId(null);
                                    }}
                                    aria-labelledby="harness-register-provenance-label"
                                    disabled={busy}
                                >
                                    <label className="flex items-center gap-tight text-sm">
                                        <RadioGroupItem id="harness-register-provenance-FIRST_PARTY" value="FIRST_PARTY" size="sm" />
                                        {t('register.new.provenanceFirstParty')}
                                    </label>
                                    <label className="flex items-center gap-tight text-sm">
                                        <RadioGroupItem id="harness-register-provenance-THIRD_PARTY" value="THIRD_PARTY" size="sm" />
                                        {t('register.new.provenanceThirdParty')}
                                    </label>
                                </RadioGroup>
                            </div>
                            {provenance === 'THIRD_PARTY' && (
                                vendors.error ? (
                                    <InlineNotice variant="warning" data-testid="harness-register-vendors-unavailable">
                                        {t('harness.registerModal.vendorsUnavailable')}
                                    </InlineNotice>
                                ) : (
                                    <FormField
                                        label={t('register.new.vendorLabel')}
                                        hint={t('register.new.vendorHint')}
                                        required
                                    >
                                        <Combobox
                                            id="harness-register-vendor"
                                            options={vendorOptions}
                                            selected={vendorOptions.find((o) => o.value === vendorId) ?? null}
                                            setSelected={(o) => setVendorId(o?.value ?? null)}
                                            placeholder={t('register.new.vendorPlaceholder')}
                                            loading={vendors.isLoading}
                                            matchTriggerWidth
                                            forceDropdown
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    </FormField>
                                )
                            )}
                        </div>

                        <div className="space-y-default rounded-lg border border-border-subtle bg-bg-subtle p-3">
                            <p className="text-sm font-medium text-content-emphasis">
                                {t('harness.registerModal.aiSystemHeading')}
                            </p>
                            <p className="text-xs text-content-subtle">{t('harness.registerModal.aiSystemHint')}</p>
                            <div className="space-y-tight">
                                <p id="harness-register-role-label" className="text-sm font-medium text-content-emphasis">
                                    {t('harness.registerModal.roleLabel')}
                                </p>
                                <RadioGroup
                                    value={deploymentRole}
                                    onValueChange={(v) => setDeploymentRole(v as DeploymentRole)}
                                    aria-labelledby="harness-register-role-label"
                                    disabled={busy}
                                >
                                    <label className="flex items-center gap-tight text-sm">
                                        <RadioGroupItem id="harness-register-role-DEPLOYER" value="DEPLOYER" size="sm" />
                                        {t('harness.registerModal.roleDeployer')}
                                    </label>
                                    <label className="flex items-center gap-tight text-sm">
                                        <RadioGroupItem id="harness-register-role-PROVIDER" value="PROVIDER" size="sm" />
                                        {t('harness.registerModal.roleProvider')}
                                    </label>
                                </RadioGroup>
                            </div>
                            <FormField label={t('harness.registerModal.purposeLabel')} hint={t('register.new.encryptedHint')}>
                                <Textarea
                                    id="harness-register-purpose"
                                    rows={2}
                                    maxLength={TEXT_MAX}
                                    value={purpose}
                                    onChange={(e) => setPurpose(e.target.value)}
                                    disabled={busy}
                                />
                            </FormField>
                        </div>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
                        {tCommon('cancel')}
                    </Button>
                    <Button type="submit" variant="primary" disabled={!canSubmit} data-testid="harness-register-submit">
                        {busy ? t('harness.registerModal.submitting') : t('harness.registerModal.submit')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
