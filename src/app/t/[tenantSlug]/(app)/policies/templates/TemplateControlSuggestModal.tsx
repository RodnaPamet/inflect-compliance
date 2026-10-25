'use client';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';

// Mirror of the server SuggestionResult shape (policy-template-mapping.ts).
export interface SuggestedControlDTO {
    controlId: string;
    controlName: string;
    controlCode: string | null;
    requirements: { code: string; title: string; provenance: 'from_toolkit' | 'curated' }[];
    provenance: 'from_toolkit' | 'curated';
    preChecked: boolean;
}
export interface SuggestedFrameworkGroupDTO {
    frameworkKey: string;
    frameworkLabel: string;
    suggestions: SuggestedControlDTO[];
}
export interface SuggestionResultDTO {
    templateExternalRef: string;
    frameworks: SuggestedFrameworkGroupDTO[];
    totalSuggested: number;
}

interface Props {
    policyTitle: string;
    result: SuggestionResultDTO;
    /**
     * Called with the chosen controlIds → caller POSTs the link + navigates.
     * A rejection keeps the dialog open and shows the error's message.
     */
    onConfirm: (controlIds: string[]) => Promise<void>;
    /** Skip linking → navigate to the new policy. */
    onSkip: () => void;
}

export function TemplateControlSuggestModal({ policyTitle, result, onConfirm, onSkip }: Props) {
    const t = useTranslations('policies');
    // Pre-check from_toolkit suggestions; leave curated unchecked — the
    // tenant opts into our judgment explicitly.
    const [checked, setChecked] = useState<Record<string, boolean>>(() => {
        const init: Record<string, boolean> = {};
        for (const fw of result.frameworks) {
            for (const s of fw.suggestions) init[s.controlId] = s.preChecked;
        }
        return init;
    });
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const selectedIds = useMemo(
        () => Object.entries(checked).filter(([, v]) => v).map(([id]) => id),
        [checked],
    );

    const toggle = (id: string) =>
        setChecked((prev) => ({ ...prev, [id]: !prev[id] }));

    const handleConfirm = async () => {
        if (!selectedIds.length) { onSkip(); return; }
        setSubmitting(true);
        setError(null);
        try {
            await onConfirm(selectedIds);
        } catch (err: unknown) {
            setError(err instanceof Error && err.message ? err.message : t('templates.linkFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal showModal setShowModal={(o) => (o ? null : onSkip())}>
            <Modal.Header title={t('templates.suggestTitle', { title: policyTitle })} />
            <Modal.Body>
                <div className="space-y-default">
                    {error && (
                        <InlineNotice variant="error" icon={null} id="suggest-error">
                            {error}
                        </InlineNotice>
                    )}
                    <p className="text-sm text-content-muted">
                        {t.rich('templates.suggestBody', {
                            count: result.totalSuggested,
                            strong: (c) => <strong>{c}</strong>,
                        })}
                    </p>

                    {result.frameworks.map((fw) => (
                        <div key={fw.frameworkKey} className="space-y-tight">
                            <Heading level={3} className="text-sm">{fw.frameworkLabel}</Heading>
                            <ul className="space-y-tight">
                                {fw.suggestions.map((s) => (
                                    <li
                                        key={s.controlId}
                                        className="flex items-start gap-compact rounded border border-border-subtle p-compact"
                                    >
                                        <Checkbox
                                            id={`suggest-${s.controlId}`}
                                            aria-label={t('templates.linkControlAria', { name: s.controlName })}
                                            checked={!!checked[s.controlId]}
                                            onCheckedChange={() => toggle(s.controlId)}
                                            className="mt-0.5"
                                        />
                                        <div className="flex-1">
                                            <div className="flex items-center gap-tight flex-wrap">
                                                <span className="text-sm font-medium">
                                                    {s.controlCode ? `${s.controlCode} — ` : ''}{s.controlName}
                                                </span>
                                                <StatusBadge variant={s.provenance === 'from_toolkit' ? 'info' : 'neutral'}>
                                                    {s.provenance === 'from_toolkit' ? t('templates.suggestToolkit') : t('templates.suggestCurated')}
                                                </StatusBadge>
                                            </div>
                                            <p className="text-xs text-content-subtle mt-0.5">
                                                {t('templates.satisfies', { codes: s.requirements.map((r) => r.code).join(', ') })}
                                            </p>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}

                    <p className="text-xs text-content-subtle italic">
                        {t('templates.curatedNote')}
                    </p>
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button variant="ghost" onClick={onSkip} disabled={submitting} id="suggest-skip">
                        {t('templates.skip')}
                    </Button>
                    <Button variant="primary" onClick={handleConfirm} disabled={submitting} id="suggest-confirm">
                        {submitting ? t('templates.linking') : t('templates.linkNControls', { count: selectedIds.length })}
                    </Button>
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}
