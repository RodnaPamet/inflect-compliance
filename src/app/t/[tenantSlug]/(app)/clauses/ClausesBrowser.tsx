'use client';
import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/hooks';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading, Eyebrow } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';

const STATUS_COLORS: Record<string, StatusBadgeVariant> = {
    NOT_STARTED: 'neutral', IN_PROGRESS: 'info', READY: 'success', NEEDS_REVIEW: 'warning',
};

interface ClausesBrowserProps {
    clauses: ClauseRow[];
    tenantSlug: string;
    /** The server's write rule (`assertCanWrite`). Without it the clause is read-only. */
    canEdit: boolean;
}

/**
 * Client island for clause browsing — handles selection state and status updates.
 * Data is pre-fetched server-side and passed via props.
 */
// listClauses → ClauseRepository.list (Clause model + progress-derived
// status/notes/checklist). Element type of the `clauses` list + `selected`.
interface ClauseRow {
    id: string;
    number: string;
    title: string;
    description: string | null;
    artifacts: string | null;
    sortOrder: number;
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'READY' | 'NEEDS_REVIEW';
    notes: string;
    checklist: string[];
    progressId: string | undefined;
}

export function ClausesBrowser({ clauses: initialClauses, tenantSlug, canEdit }: ClausesBrowserProps) {
    const t = useTranslations('clauses');
    const toast = useToast();
    const [clauses, setClauses] = useState<ClauseRow[]>(initialClauses);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selected = clauses.find((c) => c.id === selectedId) ?? null;
    // The notes being edited, per clause, until they are saved.
    const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
    const [savingNotes, setSavingNotes] = useState(false);

    const apiUrl = (path: string) => `/api/t/${tenantSlug}${path}`;

    /**
     * One save for both fields. The list changes only once the server has
     * stored the change: it used to change on any HTTP answer, so a refused
     * save (a 403 for a read-only role) looked saved until the next reload
     * (#4738).
     */
    const save = async (clause: ClauseRow, change: { status?: ClauseRow['status']; notes?: string }): Promise<boolean> => {
        const body = { status: change.status ?? clause.status, ...(change.notes !== undefined && { notes: change.notes }) };
        try {
            const res = await fetch(apiUrl(`/clauses/${clause.id}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(String(res.status));
            const stored = (await res.json().catch(() => null)) as { status?: ClauseRow['status']; notes?: string | null } | null;
            setClauses((prev) => prev.map((c) => (c.id === clause.id
                ? { ...c, status: stored?.status ?? body.status, notes: stored?.notes ?? body.notes ?? c.notes }
                : c)));
            return true;
        } catch {
            toast.error(t('saveFailed'));
            return false;
        }
    };

    const updateStatus = async (clause: ClauseRow, status: ClauseRow['status']) => {
        if (status === clause.status) return;
        if (await save(clause, { status })) toast.success(t('statusSaved'));
    };

    const saveNotes = async (clause: ClauseRow) => {
        const notes = draftNotes[clause.id];
        if (notes === undefined) return;
        setSavingNotes(true);
        const ok = await save(clause, { notes });
        setSavingNotes(false);
        if (ok) {
            setDraftNotes((d) => {
                const rest = { ...d };
                delete rest[clause.id];
                return rest;
            });
            toast.success(t('notesSaved'));
        }
    };

    const statusLabel = (status: string) => {
        const map: Record<string, string> = { NOT_STARTED: t('notStarted'), IN_PROGRESS: t('inProgress'), READY: t('ready'), NEEDS_REVIEW: t('needsReview') };
        return map[status] || status;
    };

    // Status options must rebuild when the i18n bundle changes so the
    // labels follow the active locale without a page reload.
    const statusOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: 'NOT_STARTED', label: t('notStarted') },
            { value: 'IN_PROGRESS', label: t('inProgress') },
            { value: 'READY', label: t('ready') },
            { value: 'NEEDS_REVIEW', label: t('needsReview') },
        ],
        [t],
    );

    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-default">
            <div className="lg:col-span-1 space-y-tight">
                {clauses.map(c => (
                    <button key={c.id} onClick={() => setSelectedId(c.id)}
                        className={cn(cardVariants({ density: 'compact' }), 'w-full text-left hover:bg-bg-muted/50 transition', selected?.id === c.id && 'ring-2 ring-[var(--ring)]')}>
                        <div className="flex items-center justify-between">
                            <span className="font-medium text-sm">{t('clause')} {c.number}</span>
                            <StatusBadge variant={STATUS_COLORS[c.status]}>{statusLabel(c.status)}</StatusBadge>
                        </div>
                        <p className="text-xs text-content-muted mt-1">{c.title}</p>
                    </button>
                ))}
            </div>

            <div className="lg:col-span-2">
                {selected ? (
                    <div className={cn(cardVariants(), 'animate-fadeIn')}>
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-compact mb-4">
                            <Heading level={2}>{t('clause')} {selected.number}: {selected.title}</Heading>
                            {canEdit ? (
                                <div className="w-full sm:w-48">
                                    <Combobox
                                        id="clause-status-select"
                                        name="status"
                                        options={statusOptions}
                                        selected={statusOptions.find(o => o.value === selected.status) ?? null}
                                        setSelected={(o) => {
                                            if (o) void updateStatus(selected, o.value as ClauseRow['status']);
                                        }}
                                        placeholder={t('notStarted')}
                                        hideSearch
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </div>
                            ) : (
                                <StatusBadge variant={STATUS_COLORS[selected.status]} id="clause-status-readonly">
                                    {statusLabel(selected.status)}
                                </StatusBadge>
                            )}
                        </div>
                        <p className="text-sm text-content-default mb-4">{selected.description}</p>
                        <div className="mb-4">
                            <Eyebrow className="mb-2">{t('requiredArtifacts')}</Eyebrow>
                            <p className="text-sm text-content-muted">{selected.artifacts}</p>
                        </div>
                        <div>
                            <Eyebrow className="mb-2">{t('checklist')}</Eyebrow>
                            {/* R2-P3 — was an interactive checkbox input with no
                                state/handler, so ticks were silently lost on
                                every re-render. Rendered as a static reference
                                list until real per-clause progress is modelled
                                (there is no persistence for it today). */}
                            <ul className="space-y-tight">
                                {selected.checklist?.map((item: string, i: number) => (
                                    <li key={i} className="flex items-start gap-tight text-sm text-content-default">
                                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-content-subtle" aria-hidden />
                                        <span>{item}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <div className="mt-4" id="clause-notes">
                            {canEdit ? (
                                <FormField label={t('notes')}>
                                    <Textarea
                                        id="clause-notes-input"
                                        value={draftNotes[selected.id] ?? selected.notes}
                                        onChange={(e) => setDraftNotes((d) => ({ ...d, [selected.id]: e.target.value }))}
                                        placeholder={t('notesPlaceholder')}
                                        rows={4}
                                        maxLength={5000}
                                    />
                                </FormField>
                            ) : (
                                <>
                                    <Eyebrow className="mb-2">{t('notes')}</Eyebrow>
                                    <p className="text-sm text-content-muted whitespace-pre-wrap">{selected.notes || t('noNotes')}</p>
                                </>
                            )}
                            {canEdit && draftNotes[selected.id] !== undefined && draftNotes[selected.id] !== selected.notes && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    className="mt-2"
                                    onClick={() => void saveNotes(selected)}
                                    loading={savingNotes}
                                    id="clause-notes-save"
                                >
                                    {savingNotes ? t('savingNotes') : t('saveNotes')}
                                </Button>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className={cn(cardVariants({ density: 'spacious' }), 'text-center text-content-subtle')}>
                        <p>{t('selectClause')}</p>
                    </div>
                )}
            </div>
        </div>
    );
}
