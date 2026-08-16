'use client';

/**
 * Shared "add evidence" form — the single canonical add-evidence surface
 * used by the Control, Task, Risk and Asset evidence tabs so they are
 * EXACTLY the same. Upload a file (title + browse, brand-tinted file
 * button) OR link a URL + note; a chosen file takes precedence (the URL
 * fields disable). Presentational only — each page owns its state +
 * submit handler and passes them in, plus the element ids it needs to
 * keep stable for E2E selectors.
 */
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { ProgressBar } from '@/components/ui/progress-bar';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { EVIDENCE_ACCEPT, formatBytes } from '@/lib/evidence-upload-limits';

// Was a third copy of the accept string, byte-identical to the other two.
const FILE_ACCEPT = EVIDENCE_ACCEPT;

export interface EvidenceAddFormIds {
    trigger: string;
    form: string;
    title: string;
    file: string;
    url: string;
    note: string;
    error: string;
    submit: string;
}

export interface EvidenceAddFormProps {
    ids: EvidenceAddFormIds;
    canWrite: boolean;
    show: boolean;
    onToggleShow: () => void;
    file: File | null;
    onFileChange: (file: File | null) => void;
    fileInputRef: React.RefObject<HTMLInputElement | null>;
    title: string;
    onTitleChange: (value: string) => void;
    url: string;
    onUrlChange: (value: string) => void;
    note: string;
    onNoteChange: (value: string) => void;
    onSubmit: (e: React.FormEvent) => void;
    error: string;
    /** A file upload is in flight — shows the progress bar + "Uploading…". */
    uploading: boolean;
    /** A URL link is in flight — shows "Linking…". */
    saving: boolean;
}

// This copy had lost the `< 1024` branch the other two kept, so a 500-byte
// file rendered "0.5 KB". Now the shared one.
const formatSize = formatBytes;

export function EvidenceAddForm({
    ids,
    canWrite,
    show,
    onToggleShow,
    file,
    onFileChange,
    fileInputRef,
    title,
    onTitleChange,
    url,
    onUrlChange,
    note,
    onNoteChange,
    onSubmit,
    error,
    uploading,
    saving,
}: EvidenceAddFormProps) {
    const t = useTranslations('panels.evidenceForm');
    return (
        <>
            {canWrite && (
                <div className="flex justify-end">
                    {/* Trigger: icon + bare noun, per the action-button
                        vocabulary — the Plus glyph carries the verb. The
                        SUBMIT button below keeps its verbed form
                        (`t('add')` = "Add evidence"), because a confirm
                        surface must declare the action, not just name the
                        subject. They used to share one key. */}
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        onClick={onToggleShow}
                        id={ids.trigger}
                    >
                        {t('addTrigger')}
                    </Button>
                </div>
            )}
            {show && canWrite && (
                <form
                    onSubmit={onSubmit}
                    className={cn(cardVariants({ density: 'compact' }), 'space-y-default')}
                    id={ids.form}
                >
                    <div className="space-y-compact">
                        <FormField label={t('labelTitle')}>
                            <Input
                                type="text"
                                placeholder={t('placeholderTitle')}
                                value={title}
                                onChange={(e) => onTitleChange(e.target.value)}
                                id={ids.title}
                            />
                        </FormField>
                        <FormField label={t('uploadFile')}>
                            {/* Still a raw <input type="file">: the Input
                                primitive styles a text-shaped control, and the
                                `file:*` utilities below target the browser's own
                                file-picker button, which the primitive does not
                                expose. Wrapped in FormField so the label,
                                spacing, and htmlFor wiring are consistent. */}
                            <input
                                ref={fileInputRef}
                                type="file"
                                className="input w-full file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-[var(--brand-default)] file:text-content-emphasis"
                                onChange={(e) => onFileChange(e.target.files?.[0] || null)}
                                id={ids.file}
                                accept={FILE_ACCEPT}
                            />
                        </FormField>
                            {file && (
                                <p className="mt-1 text-xs text-content-muted">
                                    {file.name} ({formatSize(file.size)})
                                </p>
                            )}
                    </div>
                    <div className="space-y-compact border-t border-border-subtle pt-3">
                        <FormField label={t('orLinkUrl')}>
                            <Input
                                type="url"
                                placeholder={t('urlPlaceholder')}
                                value={url}
                                onChange={(e) => onUrlChange(e.target.value)}
                                id={ids.url}
                                disabled={!!file}
                            />
                        </FormField>
                        <Textarea
                            rows={2}
                            placeholder={t('noteOptional')}
                            value={note}
                            onChange={(e) => onNoteChange(e.target.value)}
                            id={ids.note}
                            disabled={!!file}
                        />
                    </div>
                    {error && (
                        <div
                            className="text-content-error text-sm bg-bg-error rounded px-3 py-2"
                            id={ids.error}
                        >
                            {error}
                        </div>
                    )}
                    {/* Indeterminate, NOT `value={60}`. The upload goes
                        through `fetch`, which exposes no upload-progress
                        events, so no real fraction is available here —
                        the old hardcoded 60% looked like measured
                        progress and then sat still, making a slow upload
                        indistinguishable from a stuck one. If this ever
                        moves to XHR (`upload.onprogress`), pass the real
                        `value` and drop `indeterminate`. */}
                    {uploading && (
                        <ProgressBar
                            indeterminate
                            size="md"
                            variant="brand"
                            aria-label={t('uploadingAria')}
                        />
                    )}
                    <Button
                        type="submit"
                        variant="primary"
                        disabled={uploading || saving || (!file && !url.trim())}
                        id={ids.submit}
                    >
                        {uploading ? t('uploading') : saving ? t('linking') : t('add')}
                    </Button>
                </form>
            )}
        </>
    );
}
