'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic G-3 — Vendor questionnaire builder UI.
 *
 * Single client component. Sections and questions render as cards. Order
 * changes by drag-and-drop (native HTML5, matching FrameworkBuilder) or by
 * each row's Move up / Move down buttons, which are the keyboard path
 * (#4934). Order changes are local until "Save order" calls `POST /reorder`.
 *
 * Adding, editing and removing a section or question call the per-resource
 * routes, which the usecase layer refuses for a published template; the
 * builder then shows a "make a new draft" banner and offers no edits. Each
 * write updates the local model from its response rather than reloading the
 * tree, so an unsaved reorder survives an edit. A removal goes through the
 * undo toast (Epic 67): the row leaves at once and the DELETE is sent when
 * the window closes; Undo puts it back where it was.
 *
 * A choice question is given its options here and a scale question its
 * range (#4934). Before, the form sent neither, so the server refused every
 * choice or scale question and none could be added.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiErrorMessage } from '@/lib/api-error';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
    useTenantApiUrl,
    useTenantHref,
    useTenantContext,
} from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import {
    ChevronUp,
    GripDotsVertical,
    Pen2,
    Plus,
    Trash,
    Xmark,
} from '@inflect/ui/components/ui/icons/nucleo';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { SkeletonDetailPage } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { useToastWithUndo } from '@/components/ui/hooks';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';

type AnswerType =
    | 'YES_NO'
    | 'SINGLE_SELECT'
    | 'MULTI_SELECT'
    | 'TEXT'
    | 'NUMBER'
    | 'SCALE'
    | 'FILE_UPLOAD';

interface ChoiceOption {
    label: string;
    value: string;
    points?: number;
}
interface ScaleConfig {
    min: number;
    max: number;
    labels?: string[];
}

interface Question {
    id: string;
    sectionId: string;
    sortOrder: number;
    prompt: string;
    answerType: AnswerType;
    required: boolean;
    weight: number;
    optionsJson: ChoiceOption[] | null;
    scaleConfigJson: ScaleConfig | null;
}
interface Section {
    id: string;
    sortOrder: number;
    title: string;
    description: string | null;
    questions: Question[];
}
interface TemplateTree {
    id: string;
    key: string;
    version: number;
    name: string;
    description: string | null;
    isPublished: boolean;
    sections: Array<{
        id: string;
        sortOrder: number;
        title: string;
        description: string | null;
    }>;
    questions: Question[];
}

/** What the add and edit forms send for a question. */
interface QuestionDraft {
    prompt: string;
    answerType: AnswerType;
    required: boolean;
    weight: number;
    optionsJson: ChoiceOption[] | null;
    scaleConfigJson: ScaleConfig | null;
}

const ANSWER_TYPES: AnswerType[] = [
    'YES_NO',
    'SINGLE_SELECT',
    'MULTI_SELECT',
    'TEXT',
    'NUMBER',
    'SCALE',
    'FILE_UPLOAD',
];
const isChoice = (type: AnswerType) => type === 'SINGLE_SELECT' || type === 'MULTI_SELECT';

/** The stored row, with its JSON columns read as the shapes the form edits. */
function readQuestion(q: Question): Question {
    return {
        id: q.id,
        sectionId: q.sectionId,
        sortOrder: q.sortOrder,
        prompt: q.prompt,
        answerType: q.answerType,
        required: q.required,
        weight: q.weight,
        optionsJson: Array.isArray(q.optionsJson) ? q.optionsJson : null,
        scaleConfigJson:
            q.scaleConfigJson && typeof q.scaleConfigJson === 'object' ? q.scaleConfigJson : null,
    };
}

function moveItem<T>(items: T[], index: number, dir: -1 | 1): T[] | null {
    const j = index + dir;
    if (index < 0 || j < 0 || j >= items.length) return null;
    const next = [...items];
    [next[index], next[j]] = [next[j], next[index]];
    return next;
}

function insertAt<T>(items: T[], index: number, item: T): T[] {
    const next = [...items];
    next.splice(Math.min(Math.max(index, 0), next.length), 0, item);
    return next;
}

/** Positions follow the list: each section and question is numbered where it sits. */
function renumber(next: Section[]): Section[] {
    return next.map((s, i) => ({
        ...s,
        sortOrder: i,
        questions: s.questions.map((q, qi) => ({ ...q, sectionId: s.id, sortOrder: qi })),
    }));
}

/** A value for each option: a stored one is kept, a new one is made from its wording. */
function optionValues(rows: ReadonlyArray<{ label: string; value?: string }>): string[] {
    const used = new Set<string>();
    return rows.map((row, i) => {
        const base =
            row.value ||
            row.label
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 60) ||
            `option-${i + 1}`;
        let value = base;
        for (let n = 2; used.has(value); n++) value = `${base}-${n}`;
        used.add(value);
        return value;
    });
}

export function VendorTemplateBuilderClient({
    templateId,
}: {
    templateId: string;
}) {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const router = useRouter();
    const { permissions } = useTenantContext();
    const t = useTranslations('admin');
    const triggerUndoToast = useToastWithUndo();

    const [tree, setTree] = useState<TemplateTree | null>(null);
    const [sections, setSections] = useState<Section[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [publishing, setPublishing] = useState(false);
    const [confirmingPublish, setConfirmingPublish] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(
                apiUrl(`/vendor-assessment-templates/${templateId}`),
            );
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                setError(apiErrorMessage(b, t('templateBuilder.loadError')));
                return;
            }
            const treeData = (await res.json()) as TemplateTree;
            setTree(treeData);
            // Build section[] with embedded questions for the
            // editor's local model.
            const grouped: Section[] = treeData.sections.map((s) => ({
                id: s.id,
                sortOrder: s.sortOrder,
                title: s.title,
                description: s.description,
                questions: treeData.questions
                    .filter((q) => q.sectionId === s.id)
                    .sort((a, b) => a.sortOrder - b.sortOrder)
                    .map(readQuestion),
            }));
            setSections(grouped);
            setDirty(false);
        } catch {
            setError(t('templateBuilder.loadErrorNetwork'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, templateId, t]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refresh();
    }, [refresh]);

    const editable = useMemo(
        () => permissions.canWrite && tree && !tree.isPublished,
        [permissions.canWrite, tree],
    );
    const questionCount = sections.reduce((n, s) => n + s.questions.length, 0);

    // ─── Reorder: drag, or Move up / Move down ───
    const [dragging, setDragging] = useState<{
        kind: 'section' | 'question';
        sectionId: string;
        questionId?: string;
    } | null>(null);

    function handleSectionDrop(targetSectionId: string) {
        if (!dragging) return;
        if (dragging.kind === 'section' && dragging.sectionId !== targetSectionId) {
            setSections((prev) => {
                const fromIdx = prev.findIndex((s) => s.id === dragging.sectionId);
                const toIdx = prev.findIndex((s) => s.id === targetSectionId);
                if (fromIdx < 0 || toIdx < 0) return prev;
                const next = [...prev];
                const [moved] = next.splice(fromIdx, 1);
                next.splice(toIdx, 0, moved);
                return renumber(next);
            });
            setDirty(true);
        }
        setDragging(null);
    }

    function handleQuestionDrop(
        targetSectionId: string,
        targetQuestionId: string | null,
    ) {
        if (!dragging || dragging.kind !== 'question') {
            setDragging(null);
            return;
        }
        const fromSectionId = dragging.sectionId;
        const movedQuestionId = dragging.questionId!;
        setSections((prev) => {
            const next = prev.map((s) => ({
                ...s,
                questions: [...s.questions],
            }));
            const fromSec = next.find((s) => s.id === fromSectionId);
            const toSec = next.find((s) => s.id === targetSectionId);
            if (!fromSec || !toSec) return prev;
            const fromIdx = fromSec.questions.findIndex(
                (q) => q.id === movedQuestionId,
            );
            if (fromIdx < 0) return prev;
            const [moved] = fromSec.questions.splice(fromIdx, 1);
            const toIdx =
                targetQuestionId === null
                    ? toSec.questions.length
                    : toSec.questions.findIndex(
                          (q) => q.id === targetQuestionId,
                      );
            toSec.questions.splice(toIdx >= 0 ? toIdx : 0, 0, moved);
            return renumber(next);
        });
        setDirty(true);
        setDragging(null);
    }

    function moveSection(sectionId: string, dir: -1 | 1) {
        setSections((prev) => {
            const next = moveItem(prev, prev.findIndex((s) => s.id === sectionId), dir);
            return next ? renumber(next) : prev;
        });
        setDirty(true);
    }

    function moveQuestion(sectionId: string, questionId: string, dir: -1 | 1) {
        setSections((prev) =>
            renumber(
                prev.map((s) => {
                    if (s.id !== sectionId) return s;
                    const next = moveItem(s.questions, s.questions.findIndex((q) => q.id === questionId), dir);
                    return next ? { ...s, questions: next } : s;
                }),
            ),
        );
        setDirty(true);
    }

    async function saveOrder(): Promise<boolean> {
        if (!editable || !dirty) return true;
        setSaving(true);
        setError(null);
        try {
            const body = {
                sections: sections.map((s) => ({
                    id: s.id,
                    sortOrder: s.sortOrder,
                    questions: s.questions.map((q) => ({
                        id: q.id,
                        sectionId: q.sectionId,
                        sortOrder: q.sortOrder,
                    })),
                })),
            };
            const res = await fetch(
                apiUrl(`/vendor-assessment-templates/${templateId}/reorder`),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                },
            );
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                setError(apiErrorMessage(b, t('templateBuilder.saveError')));
                return false;
            }
            setDirty(false);
            return true;
        } catch {
            setError(t('templateBuilder.saveError'));
            return false;
        } finally {
            setSaving(false);
        }
    }

    async function publish() {
        if (!tree || tree.isPublished || !permissions.canWrite) return;
        setPublishing(true);
        setError(null);
        try {
            // An unsaved order is part of what is being published.
            if (!(await saveOrder())) return;
            const res = await fetch(
                apiUrl(`/vendor-assessment-templates/${templateId}/publish`),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                },
            );
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                setError(apiErrorMessage(b, t('templateBuilder.publishError')));
                return;
            }
            // On success re-fetch — the tree flips to isPublished=true,
            // which swaps the editor for the read-only published banner.
            await refresh();
        } catch {
            setError(t('templateBuilder.publishError'));
        } finally {
            setPublishing(false);
        }
    }

    /** Send a write and return its JSON body, or set the error and return null. */
    async function send<T>(path: string, method: string, body: unknown, fallback: string): Promise<T | null> {
        setError(null);
        try {
            const res = await fetch(apiUrl(`/vendor-assessment-templates/${templateId}${path}`), {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const b = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(apiErrorMessage(b, fallback));
                return null;
            }
            return b as T;
        } catch {
            setError(fallback);
            return null;
        }
    }

    async function addSection(title: string): Promise<boolean> {
        if (!editable) return false;
        const created = await send<{ id: string; title: string; description: string | null }>(
            '/sections',
            'POST',
            { title },
            t('templateBuilder.addSectionError'),
        );
        if (!created) return false;
        setSections((prev) =>
            renumber([
                ...prev,
                { id: created.id, sortOrder: prev.length, title: created.title, description: created.description, questions: [] },
            ]),
        );
        return true;
    }

    async function editSection(sectionId: string, patch: { title: string; description: string | null }): Promise<boolean> {
        if (!editable) return false;
        const updated = await send<{ title: string; description: string | null }>(
            `/sections/${sectionId}`,
            'PATCH',
            patch,
            t('templateBuilder.editSectionError'),
        );
        if (!updated) return false;
        setSections((prev) =>
            prev.map((s) => (s.id === sectionId ? { ...s, title: updated.title, description: updated.description } : s)),
        );
        return true;
    }

    async function addQuestionToSection(sectionId: string, draft: QuestionDraft): Promise<boolean> {
        if (!editable) return false;
        const created = await send<Question>(
            `/sections/${sectionId}/questions`,
            'POST',
            draft,
            t('templateBuilder.addQuestionError'),
        );
        if (!created) return false;
        setSections((prev) =>
            renumber(
                prev.map((s) => (s.id === sectionId ? { ...s, questions: [...s.questions, readQuestion(created)] } : s)),
            ),
        );
        return true;
    }

    async function editQuestion(question: Question, draft: QuestionDraft): Promise<boolean> {
        if (!editable) return false;
        const updated = await send<Question>(
            `/questions/${question.id}`,
            'PATCH',
            draft,
            t('templateBuilder.editQuestionError'),
        );
        if (!updated) return false;
        // Keep the question where the local order has it.
        const next = readQuestion({ ...updated, sectionId: question.sectionId, sortOrder: question.sortOrder });
        setSections((prev) =>
            prev.map((s) => ({ ...s, questions: s.questions.map((q) => (q.id === question.id ? next : q)) })),
        );
        return true;
    }

    function commitDelete(path: string) {
        return async () => {
            const res = await fetch(apiUrl(`/vendor-assessment-templates/${templateId}${path}`), {
                method: 'DELETE',
            });
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                throw new Error(apiErrorMessage(b, t('templateBuilder.removeError')));
            }
        };
    }

    function removeQuestion(question: Question) {
        if (!editable) return;
        const section = sections.find((s) => s.id === question.sectionId);
        const index = section ? section.questions.findIndex((q) => q.id === question.id) : -1;
        // Undo puts the question back where it was, without undoing anything
        // done to the rest of the template in the meantime.
        const putBack = () =>
            setSections((prev) =>
                renumber(
                    prev.map((s) =>
                        s.id === question.sectionId && !s.questions.some((q) => q.id === question.id)
                            ? { ...s, questions: insertAt(s.questions, index, question) }
                            : s,
                    ),
                ),
            );
        setSections((prev) =>
            renumber(prev.map((s) => ({ ...s, questions: s.questions.filter((q) => q.id !== question.id) }))),
        );
        triggerUndoToast({
            message: t('templateBuilder.questionRemoved'),
            undoMessage: t('templateBuilder.undo'),
            action: commitDelete(`/questions/${question.id}`),
            undoAction: putBack,
            onError: (e) => {
                putBack();
                setError(e instanceof Error ? e.message : t('templateBuilder.removeError'));
            },
        });
    }

    function removeSection(section: Section) {
        if (!editable) return;
        const index = sections.findIndex((s) => s.id === section.id);
        const putBack = () =>
            setSections((prev) =>
                prev.some((s) => s.id === section.id) ? prev : renumber(insertAt(prev, index, section)),
            );
        setSections((prev) => renumber(prev.filter((s) => s.id !== section.id)));
        triggerUndoToast({
            message:
                section.questions.length === 0
                    ? t('templateBuilder.sectionRemoved')
                    : t('templateBuilder.sectionRemovedWithQuestions', { count: section.questions.length }),
            undoMessage: t('templateBuilder.undo'),
            action: commitDelete(`/sections/${section.id}`),
            undoAction: putBack,
            onError: (e) => {
                putBack();
                setError(e instanceof Error ? e.message : t('templateBuilder.removeError'));
            },
        });
    }

    async function clonePublished() {
        if (!tree) return;
        const cloned = await send<{ id: string }>(
            '/clone',
            'POST',
            { mode: 'SAME_KEY_NEW_VERSION' },
            t('templateBuilder.cloneError'),
        );
        if (cloned) router.push(tenantHref(`/admin/vendor-templates/${cloned.id}`));
    }

    if (loading && !tree) return <SkeletonDetailPage />;
    if (!tree)
        return (
            <div className="p-12 text-center text-content-error" role="alert">
                {error ?? t('templateBuilder.notFound')}
            </div>
        );

    return (
        <div
            className="space-y-section animate-fadeIn"
            data-testid="vendor-template-builder"
        >
            <BackAffordance />
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <PageBreadcrumbs
                        items={[
                            { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                            { label: t('crumb.admin'), href: tenantHref('/admin') },
                            { label: t('crumb.vendorTemplates'), href: tenantHref('/admin/vendor-templates') },
                            { label: tree.name },
                        ]}
                        className="mb-1"
                    />
                    <Heading level={1}>{tree.name}</Heading>
                    <div className="flex items-center gap-tight mt-1 text-xs text-content-subtle">
                        <span>{tree.key}</span>
                        <span>·</span>
                        <span>{t('templateBuilder.version', { version: tree.version })}</span>
                        <span>·</span>
                        <StatusBadge variant={tree.isPublished ? 'success' : 'warning'} size="sm">
                            {tree.isPublished ? t('templateBuilder.published') : t('templateBuilder.draft')}
                        </StatusBadge>
                    </div>
                </div>
                <div className="flex items-center gap-tight">
                    {dirty && editable && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void saveOrder()}
                            disabled={saving}
                            loading={saving}
                            id="save-order-btn"
                        >
                            {saving ? t('templateBuilder.saving') : t('templateBuilder.saveOrder')}
                        </Button>
                    )}
                    {permissions.canWrite &&
                        !tree.isPublished &&
                        questionCount > 0 && (
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => setConfirmingPublish(true)}
                                disabled={publishing}
                                loading={publishing}
                                id="publish-template-btn"
                            >
                                {publishing
                                    ? t('templateBuilder.publishing')
                                    : t('templateBuilder.publish')}
                            </Button>
                        )}
                </div>
            </div>

            {tree.isPublished && (
                <div
                    className={cn(cardVariants({ density: 'compact' }), 'border border-border-warning')}
                    role="alert"
                    data-testid="published-banner"
                >
                    <p className="text-sm text-content-emphasis">
                        {t('templateBuilder.publishedTitle')}
                    </p>
                    <p className="text-xs text-content-muted mt-1">
                        {t('templateBuilder.publishedDesc')}
                    </p>
                    {permissions.canWrite && (
                        <Button
                            variant="primary"
                            size="sm"
                            className="mt-3"
                            onClick={clonePublished}
                            id="clone-template-btn"
                        >
                            {t('templateBuilder.cloneToDraft')}
                        </Button>
                    )}
                </div>
            )}

            {error && (
                <p
                    className="text-xs text-content-error"
                    role="alert"
                    data-testid="builder-error"
                >
                    {error}
                </p>
            )}

            {/* Sections */}
            <div className="space-y-default">
                {sections.map((s, index) => (
                    <SectionCard
                        key={s.id}
                        section={s}
                        editable={!!editable}
                        isFirst={index === 0}
                        isLast={index === sections.length - 1}
                        onDragStart={() =>
                            setDragging({
                                kind: 'section',
                                sectionId: s.id,
                            })
                        }
                        onDrop={() => handleSectionDrop(s.id)}
                        onQuestionDragStart={(qid) =>
                            setDragging({
                                kind: 'question',
                                sectionId: s.id,
                                questionId: qid,
                            })
                        }
                        onQuestionDrop={(targetQid) =>
                            handleQuestionDrop(s.id, targetQid)
                        }
                        onMove={(dir) => moveSection(s.id, dir)}
                        onMoveQuestion={(qid, dir) => moveQuestion(s.id, qid, dir)}
                        onEdit={(patch) => editSection(s.id, patch)}
                        onRemove={() => removeSection(s)}
                        onAddQuestion={(draft) => addQuestionToSection(s.id, draft)}
                        onEditQuestion={editQuestion}
                        onRemoveQuestion={removeQuestion}
                    />
                ))}
            </div>

            {editable && <AddSectionForm onSubmit={addSection} />}

            <ConfirmDialog
                showModal={confirmingPublish}
                setShowModal={setConfirmingPublish}
                tone="warning"
                title={t('templateBuilder.publishConfirmTitle')}
                description={t('templateBuilder.publishConfirmBody')}
                confirmLabel={t('templateBuilder.publish')}
                onConfirm={async () => {
                    setConfirmingPublish(false);
                    await publish();
                }}
            />
        </div>
    );
}

// ─── Small pieces ──────────────────────────────────────────────────

const ICON_BUTTON =
    'text-content-muted hover:text-content-default disabled:opacity-50 p-1 rounded';

function RowActions({
    isFirst,
    isLast,
    onMove,
    onEdit,
    onRemove,
    moveUpLabel,
    moveDownLabel,
    editLabel,
    removeLabel,
}: {
    isFirst: boolean;
    isLast: boolean;
    onMove: (dir: -1 | 1) => void;
    onEdit: () => void;
    onRemove: () => void;
    moveUpLabel: string;
    moveDownLabel: string;
    editLabel: string;
    removeLabel: string;
}) {
    return (
        <div className="flex items-center gap-0.5 flex-shrink-0">
            <button type="button" className={ICON_BUTTON} onClick={() => onMove(-1)} disabled={isFirst} aria-label={moveUpLabel}>
                <ChevronUp className="w-4 h-4" aria-hidden="true" />
            </button>
            <button type="button" className={ICON_BUTTON} onClick={() => onMove(1)} disabled={isLast} aria-label={moveDownLabel}>
                <ChevronUp className="w-4 h-4 rotate-180" aria-hidden="true" />
            </button>
            <button type="button" className={ICON_BUTTON} onClick={onEdit} aria-label={editLabel}>
                <Pen2 className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
                type="button"
                className={cn(ICON_BUTTON, 'hover:text-content-error')}
                onClick={onRemove}
                aria-label={removeLabel}
            >
                <Trash className="w-4 h-4" aria-hidden="true" />
            </button>
        </div>
    );
}

/** What a question asks the vendor to choose from, in a few words. */
function QuestionDetail({ question }: { question: Question }) {
    const t = useTranslations('admin');
    if (isChoice(question.answerType)) {
        const options = question.optionsJson ?? [];
        if (options.length === 0) {
            return <span className="text-xs text-content-error">{t('templateBuilder.noOptions')}</span>;
        }
        return (
            <span className="text-xs text-content-subtle truncate">
                {options.map((o) => o.label).join(' · ')}
            </span>
        );
    }
    if (question.answerType === 'SCALE' && question.scaleConfigJson) {
        return (
            <span className="text-xs text-content-subtle">
                {t('templateBuilder.scaleSummary', {
                    min: question.scaleConfigJson.min,
                    max: question.scaleConfigJson.max,
                })}
            </span>
        );
    }
    return null;
}

// ─── Section card ──────────────────────────────────────────────────

function SectionCard({
    section,
    editable,
    isFirst,
    isLast,
    onDragStart,
    onDrop,
    onQuestionDragStart,
    onQuestionDrop,
    onMove,
    onMoveQuestion,
    onEdit,
    onRemove,
    onAddQuestion,
    onEditQuestion,
    onRemoveQuestion,
}: {
    section: Section;
    editable: boolean;
    isFirst: boolean;
    isLast: boolean;
    onDragStart: () => void;
    onDrop: () => void;
    onQuestionDragStart: (questionId: string) => void;
    onQuestionDrop: (targetQuestionId: string | null) => void;
    onMove: (dir: -1 | 1) => void;
    onMoveQuestion: (questionId: string, dir: -1 | 1) => void;
    onEdit: (patch: { title: string; description: string | null }) => Promise<boolean>;
    onRemove: () => void;
    onAddQuestion: (draft: QuestionDraft) => Promise<boolean>;
    onEditQuestion: (question: Question, draft: QuestionDraft) => Promise<boolean>;
    onRemoveQuestion: (question: Question) => void;
}) {
    const t = useTranslations('admin');
    const [editing, setEditing] = useState(false);
    const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null);

    return (
        <div
            className={cardVariants({ density: 'compact' })}
            draggable={editable && !editing && editingQuestionId === null}
            onDragStart={onDragStart}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            data-testid={`section-${section.id}`}
        >
            {editing ? (
                <SectionForm
                    initial={{ title: section.title, description: section.description }}
                    onCancel={() => setEditing(false)}
                    onSubmit={async (patch) => {
                        if (await onEdit(patch)) setEditing(false);
                    }}
                />
            ) : (
                <div className="flex items-start justify-between gap-compact mb-3">
                    <div className="flex items-start gap-tight min-w-0">
                        {editable && (
                            <GripDotsVertical
                                className="w-4 h-4 mt-1 text-content-subtle cursor-grab flex-shrink-0"
                                aria-hidden="true"
                            />
                        )}
                        <div className="min-w-0">
                            <Heading level={2}>{section.title}</Heading>
                            {section.description && (
                                <p className="text-xs text-content-subtle mt-0.5">
                                    {section.description}
                                </p>
                            )}
                        </div>
                    </div>
                    {editable && (
                        <RowActions
                            isFirst={isFirst}
                            isLast={isLast}
                            onMove={onMove}
                            onEdit={() => setEditing(true)}
                            onRemove={onRemove}
                            moveUpLabel={t('templateBuilder.moveSectionUp', { title: section.title })}
                            moveDownLabel={t('templateBuilder.moveSectionDown', { title: section.title })}
                            editLabel={t('templateBuilder.editSection', { title: section.title })}
                            removeLabel={t('templateBuilder.removeSection', { title: section.title })}
                        />
                    )}
                </div>
            )}

            <div className="space-y-tight mb-3">
                {section.questions.map((q, qi) =>
                    editingQuestionId === q.id ? (
                        <div
                            key={q.id}
                            className="rounded border border-border-subtle p-compact"
                            data-testid={`question-${q.id}`}
                        >
                            <QuestionForm
                                initial={q}
                                onCancel={() => setEditingQuestionId(null)}
                                onSubmit={async (draft) => {
                                    const ok = await onEditQuestion(q, draft);
                                    if (ok) setEditingQuestionId(null);
                                    return ok;
                                }}
                            />
                        </div>
                    ) : (
                        <div
                            key={q.id}
                            className="flex items-center gap-compact px-2 py-1.5 rounded hover:bg-bg-muted/50"
                            draggable={editable}
                            onDragStart={(e) => {
                                e.stopPropagation();
                                onQuestionDragStart(q.id);
                            }}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                                e.stopPropagation();
                                onQuestionDrop(q.id);
                            }}
                            data-testid={`question-${q.id}`}
                        >
                            {editable && (
                                <GripDotsVertical
                                    className="w-3.5 h-3.5 text-content-subtle cursor-grab flex-shrink-0"
                                    aria-hidden="true"
                                />
                            )}
                            <div className="flex-1 min-w-0 flex flex-col">
                                <span className="text-sm">{q.prompt}</span>
                                <QuestionDetail question={q} />
                            </div>
                            <StatusBadge variant="info" size="sm">
                                {t(`vendorAnswerType.${q.answerType}`)}
                            </StatusBadge>
                            {q.required && (
                                <StatusBadge variant="warning" size="sm">
                                    {t('templateBuilder.required')}
                                </StatusBadge>
                            )}
                            <span className="text-xs text-content-subtle whitespace-nowrap">
                                {t('templateBuilder.weightValue', { weight: q.weight })}
                            </span>
                            {editable && (
                                <RowActions
                                    isFirst={qi === 0}
                                    isLast={qi === section.questions.length - 1}
                                    onMove={(dir) => onMoveQuestion(q.id, dir)}
                                    onEdit={() => setEditingQuestionId(q.id)}
                                    onRemove={() => onRemoveQuestion(q)}
                                    moveUpLabel={t('templateBuilder.moveQuestionUp', { prompt: q.prompt })}
                                    moveDownLabel={t('templateBuilder.moveQuestionDown', { prompt: q.prompt })}
                                    editLabel={t('templateBuilder.editQuestion', { prompt: q.prompt })}
                                    removeLabel={t('templateBuilder.removeQuestion', { prompt: q.prompt })}
                                />
                            )}
                        </div>
                    ),
                )}
                {section.questions.length === 0 && (
                    <div
                        className="text-xs text-content-subtle italic px-2 py-3 border border-dashed border-border-default/40 rounded"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => onQuestionDrop(null)}
                    >
                        {editable ? t('templateBuilder.questionsEmptyHelp') : t('templateBuilder.questionsEmpty')}
                    </div>
                )}
            </div>

            {editable && (
                <div className="border-t border-border-subtle pt-3">
                    <QuestionForm onSubmit={onAddQuestion} sectionId={section.id} />
                </div>
            )}
        </div>
    );
}

// ─── Forms ─────────────────────────────────────────────────────────

function AddSectionForm({ onSubmit }: { onSubmit: (title: string) => Promise<boolean> }) {
    const [title, setTitle] = useState('');
    const [busy, setBusy] = useState(false);
    const t = useTranslations('admin');
    return (
        <form
            className={cn(cardVariants({ density: 'compact' }), 'flex items-end gap-tight')}
            onSubmit={async (e) => {
                e.preventDefault();
                if (!title.trim()) return;
                setBusy(true);
                try {
                    if (await onSubmit(title.trim())) setTitle('');
                } finally {
                    setBusy(false);
                }
            }}
            data-testid="add-section-form"
        >
            <FormField label={t('templateBuilder.newSectionTitle')} className="flex-1">
                <Input
                    id="new-section-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={500}
                />
            </FormField>
            <Button
                variant="primary"
                icon={<Plus className="-ml-0.5 -mr-2.5" />}
                type="submit"
                disabled={busy || !title.trim()}
                loading={busy}
            >
                {t('templateBuilder.addSectionBtn')}
            </Button>
        </form>
    );
}

function SectionForm({
    initial,
    onSubmit,
    onCancel,
}: {
    initial: { title: string; description: string | null };
    onSubmit: (patch: { title: string; description: string | null }) => Promise<void>;
    onCancel: () => void;
}) {
    const t = useTranslations('admin');
    const [title, setTitle] = useState(initial.title);
    const [description, setDescription] = useState(initial.description ?? '');
    const [busy, setBusy] = useState(false);
    return (
        <form
            className="space-y-compact mb-3"
            onSubmit={async (e) => {
                e.preventDefault();
                if (!title.trim()) return;
                setBusy(true);
                try {
                    await onSubmit({ title: title.trim(), description: description.trim() || null });
                } finally {
                    setBusy(false);
                }
            }}
            data-testid="edit-section-form"
        >
            <FormField label={t('templateBuilder.sectionTitleLabel')} required>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} />
            </FormField>
            <FormField label={t('templateBuilder.sectionDescriptionLabel')}>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10000} />
            </FormField>
            <div className="flex items-center gap-tight">
                <Button variant="secondary" size="sm" type="submit" disabled={busy || !title.trim()} loading={busy}>
                    {t('templateBuilder.save')}
                </Button>
                <Button variant="ghost" size="sm" type="button" onClick={onCancel} disabled={busy}>
                    {t('templateBuilder.cancel')}
                </Button>
            </div>
        </form>
    );
}

interface OptionRow {
    label: string;
    points: string;
    /** The stored value, kept for an existing option so its answers still match. */
    value?: string;
}

const BLANK_OPTIONS: OptionRow[] = [
    { label: '', points: '' },
    { label: '', points: '' },
];

/**
 * The add and edit form for a question. A choice question is given its
 * options and a scale question its range here; both are checked before the
 * request is sent, so the server's refusal is the exception rather than the
 * way a mistake is found.
 */
function QuestionForm({
    initial,
    sectionId,
    onSubmit,
    onCancel,
}: {
    initial?: Question;
    sectionId?: string;
    onSubmit: (draft: QuestionDraft) => Promise<boolean>;
    onCancel?: () => void;
}) {
    const t = useTranslations('admin');
    const isEdit = !!initial;
    const [prompt, setPrompt] = useState(initial?.prompt ?? '');
    const [type, setType] = useState<AnswerType>(initial?.answerType ?? 'YES_NO');
    const [required, setRequired] = useState(initial?.required ?? true);
    const [weight, setWeight] = useState(String(initial?.weight ?? 1));
    const [options, setOptions] = useState<OptionRow[]>(() =>
        initial?.optionsJson?.length
            ? initial.optionsJson.map((o) => ({
                  label: o.label,
                  value: o.value,
                  points: typeof o.points === 'number' ? String(o.points) : '',
              }))
            : BLANK_OPTIONS,
    );
    const scale = initial?.scaleConfigJson;
    const [scaleMin, setScaleMin] = useState(String(scale?.min ?? 1));
    const [scaleMax, setScaleMax] = useState(String(scale?.max ?? 5));
    const [scaleLow, setScaleLow] = useState(scale?.labels?.[0] ?? '');
    const [scaleHigh, setScaleHigh] = useState(
        scale?.labels && scale.labels.length > 1 ? scale.labels[scale.labels.length - 1] : '',
    );
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);

    const typeOptions: ComboboxOption[] = useMemo(
        () => ANSWER_TYPES.map((value) => ({ value, label: t(`vendorAnswerType.${value}`) })),
        [t],
    );
    const idPrefix = initial ? `question-${initial.id}` : `new-question-${sectionId ?? 'x'}`;

    function reset() {
        setPrompt('');
        setType('YES_NO');
        setRequired(true);
        setWeight('1');
        setOptions(BLANK_OPTIONS);
        setScaleMin('1');
        setScaleMax('5');
        setScaleLow('');
        setScaleHigh('');
    }

    /** The draft to send, or the sentence that says why it cannot be sent. */
    function build(): QuestionDraft | string {
        const weightValue = Number(weight);
        if (weight.trim() === '' || !Number.isFinite(weightValue) || weightValue < 0) {
            return t('templateBuilder.weightInvalid');
        }
        let optionsJson: ChoiceOption[] | null = null;
        if (isChoice(type)) {
            const filled = options.filter((o) => o.label.trim());
            if (filled.length === 0) return t('templateBuilder.optionsNeeded');
            const labels = filled.map((o) => o.label.trim().toLowerCase());
            if (new Set(labels).size !== labels.length) return t('templateBuilder.optionsDuplicate');
            if (filled.some((o) => o.points.trim() !== '' && !Number.isFinite(Number(o.points)))) {
                return t('templateBuilder.pointsInvalid');
            }
            const values = optionValues(filled.map((o) => ({ label: o.label, value: o.value })));
            optionsJson = filled.map((o, i) => ({
                label: o.label.trim(),
                value: values[i],
                ...(o.points.trim() !== '' ? { points: Number(o.points) } : {}),
            }));
        }
        let scaleConfigJson: ScaleConfig | null = null;
        if (type === 'SCALE') {
            const min = Number(scaleMin);
            const max = Number(scaleMax);
            if (scaleMin.trim() === '' || scaleMax.trim() === '' || !Number.isInteger(min) || !Number.isInteger(max)) {
                return t('templateBuilder.scaleWhole');
            }
            if (min >= max) return t('templateBuilder.scaleOrder');
            const low = scaleLow.trim();
            const high = scaleHigh.trim();
            scaleConfigJson = { min, max, ...(low || high ? { labels: [low, high] } : {}) };
        }
        return {
            prompt: prompt.trim(),
            answerType: type,
            required,
            weight: weightValue,
            optionsJson,
            scaleConfigJson,
        };
    }

    return (
        <form
            className="space-y-compact"
            onSubmit={async (e) => {
                e.preventDefault();
                if (!prompt.trim()) return;
                const draft = build();
                if (typeof draft === 'string') {
                    setProblem(draft);
                    return;
                }
                setProblem(null);
                setBusy(true);
                try {
                    const ok = await onSubmit(draft);
                    if (ok && !isEdit) reset();
                } finally {
                    setBusy(false);
                }
            }}
            data-testid={isEdit ? 'edit-question-form' : 'add-question-form'}
        >
            <div className="grid grid-cols-1 md:grid-cols-12 gap-tight items-end">
                <FormField label={t('templateBuilder.promptLabel')} className="md:col-span-6">
                    <Input
                        id={`${idPrefix}-prompt`}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder={t('templateBuilder.promptPlaceholder')}
                        maxLength={5000}
                    />
                </FormField>
                <FormField label={t('templateBuilder.typeLabel')} className="md:col-span-3">
                    <Combobox
                        id={`${idPrefix}-type`}
                        hideSearch
                        selected={typeOptions.find((o) => o.value === type) ?? null}
                        setSelected={(opt) => {
                            if (opt) setType(opt.value as AnswerType);
                        }}
                        options={typeOptions}
                        matchTriggerWidth
                    />
                </FormField>
                <FormField
                    label={t('templateBuilder.weightLabel')}
                    hint={t('templateBuilder.weightHint')}
                    className="md:col-span-2"
                >
                    <Input
                        id={`${idPrefix}-weight`}
                        inputMode="decimal"
                        value={weight}
                        onChange={(e) => setWeight(e.target.value)}
                    />
                </FormField>
                <div className="md:col-span-1 flex items-center gap-1.5 pb-2">
                    <Checkbox
                        id={`${idPrefix}-required`}
                        checked={required}
                        onCheckedChange={(v) => setRequired(v === true)}
                    />
                    <label htmlFor={`${idPrefix}-required`} className="text-xs text-content-default">
                        {t('templateBuilder.requiredCheckbox')}
                    </label>
                </div>
            </div>

            {isChoice(type) && (
                <div
                    role="group"
                    aria-labelledby={`${idPrefix}-options-label`}
                    className="space-y-tight"
                    data-testid={`${idPrefix}-options`}
                >
                    <p id={`${idPrefix}-options-label`} className="text-xs text-content-muted mb-1">
                        {t('templateBuilder.optionsLabel')}
                    </p>
                    {options.map((o, i) => (
                        <div key={i} className="flex items-center gap-tight">
                            <Input
                                aria-label={t('templateBuilder.optionLabel', { n: i + 1 })}
                                value={o.label}
                                onChange={(e) =>
                                    setOptions((prev) => prev.map((p, pi) => (pi === i ? { ...p, label: e.target.value } : p)))
                                }
                                placeholder={t('templateBuilder.optionPlaceholder', { n: i + 1 })}
                                maxLength={500}
                                className="flex-1"
                            />
                            <Input
                                aria-label={t('templateBuilder.optionPoints', { n: i + 1 })}
                                inputMode="decimal"
                                value={o.points}
                                onChange={(e) =>
                                    setOptions((prev) => prev.map((p, pi) => (pi === i ? { ...p, points: e.target.value } : p)))
                                }
                                placeholder={t('templateBuilder.pointsPlaceholder')}
                                className="w-24"
                            />
                            <button
                                type="button"
                                onClick={() => setOptions((prev) => prev.filter((_, pi) => pi !== i))}
                                disabled={options.length <= 1}
                                aria-label={t('templateBuilder.removeOption', { n: i + 1 })}
                                className={cn(ICON_BUTTON, 'hover:text-content-error')}
                            >
                                <Xmark className="w-4 h-4" aria-hidden="true" />
                            </button>
                        </div>
                    ))}
                    <p className="text-xs text-content-subtle">{t('templateBuilder.pointsHelp')}</p>
                    <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        icon={<Plus />}
                        onClick={() => setOptions((prev) => [...prev, { label: '', points: '' }])}
                        disabled={options.length >= 50}
                    >
                        {t('templateBuilder.addOption')}
                    </Button>
                </div>
            )}

            {type === 'SCALE' && (
                <div
                    role="group"
                    aria-labelledby={`${idPrefix}-scale-label`}
                    className="grid grid-cols-2 md:grid-cols-4 gap-tight"
                    data-testid={`${idPrefix}-scale`}
                >
                    <p id={`${idPrefix}-scale-label`} className="text-xs text-content-muted mb-1 col-span-full">
                        {t('templateBuilder.scaleLabel')}
                    </p>
                    <FormField label={t('templateBuilder.scaleMin')}>
                        <Input
                            id={`${idPrefix}-scale-min`}
                            inputMode="numeric"
                            value={scaleMin}
                            onChange={(e) => setScaleMin(e.target.value)}
                        />
                    </FormField>
                    <FormField label={t('templateBuilder.scaleMax')}>
                        <Input
                            id={`${idPrefix}-scale-max`}
                            inputMode="numeric"
                            value={scaleMax}
                            onChange={(e) => setScaleMax(e.target.value)}
                        />
                    </FormField>
                    <FormField label={t('templateBuilder.scaleLowLabel')}>
                        <Input
                            id={`${idPrefix}-scale-low`}
                            value={scaleLow}
                            onChange={(e) => setScaleLow(e.target.value)}
                            placeholder={t('templateBuilder.scaleLowPlaceholder')}
                            maxLength={120}
                        />
                    </FormField>
                    <FormField label={t('templateBuilder.scaleHighLabel')}>
                        <Input
                            id={`${idPrefix}-scale-high`}
                            value={scaleHigh}
                            onChange={(e) => setScaleHigh(e.target.value)}
                            placeholder={t('templateBuilder.scaleHighPlaceholder')}
                            maxLength={120}
                        />
                    </FormField>
                </div>
            )}

            {problem && (
                <p className="text-xs text-content-error" role="alert">
                    {problem}
                </p>
            )}

            <div className="flex items-center gap-tight">
                <Button
                    variant="primary"
                    size="sm"
                    icon={busy || isEdit ? undefined : <Plus className="-ml-0.5 -mr-2.5" />}
                    type="submit"
                    disabled={busy || !prompt.trim()}
                    loading={busy}
                >
                    {isEdit
                        ? t('templateBuilder.save')
                        : busy
                          ? t('templateBuilder.adding')
                          : t('templateBuilder.addQuestionBtn')}
                </Button>
                {onCancel && (
                    <Button variant="ghost" size="sm" type="button" onClick={onCancel} disabled={busy}>
                        {t('templateBuilder.cancel')}
                    </Button>
                )}
            </div>
        </form>
    );
}
