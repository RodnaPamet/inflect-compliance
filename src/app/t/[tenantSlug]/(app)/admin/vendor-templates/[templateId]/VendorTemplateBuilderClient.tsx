'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic G-3 — Vendor questionnaire builder UI.
 *
 * Single client component. Sections and questions render as cards
 * with a drag-grip; native HTML5 drag-and-drop (matching
 * FrameworkBuilder, no new lib dep) reorders within or across
 * sections. State changes are local-optimistic; the explicit
 * "Save order" button calls `POST /reorder`.
 *
 * Add-section / add-question forms call the per-resource POST
 * routes which are gated by the publish-guard at the usecase
 * layer; if the template is published the builder shows a
 * "clone first" banner and disables the forms.
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
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { SkeletonDetailPage } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';

interface Question {
    id: string;
    sectionId: string;
    sortOrder: number;
    prompt: string;
    answerType:
        | 'YES_NO'
        | 'SINGLE_SELECT'
        | 'MULTI_SELECT'
        | 'TEXT'
        | 'NUMBER'
        | 'SCALE'
        | 'FILE_UPLOAD';
    required: boolean;
    weight: number;
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
    questions: Array<Omit<Question, 'sectionId'> & { sectionId: string }>;
}

const ANSWER_TYPES: Question['answerType'][] = [
    'YES_NO',
    'SINGLE_SELECT',
    'MULTI_SELECT',
    'TEXT',
    'NUMBER',
    'SCALE',
    'FILE_UPLOAD',
];
const ANSWER_TYPE_OPTIONS: ComboboxOption[] = ANSWER_TYPES.map((t) => ({
    value: t,
    label: t,
}));

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

    const [tree, setTree] = useState<TemplateTree | null>(null);
    const [sections, setSections] = useState<Section[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [publishing, setPublishing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(
                apiUrl(`/vendor-assessment-templates/${templateId}`),
            );
            if (!res.ok) {
                setError(t('templateBuilder.loadError', { status: res.status }));
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
                    .map((q) => ({
                        id: q.id,
                        sectionId: q.sectionId,
                        sortOrder: q.sortOrder,
                        prompt: q.prompt,
                        answerType: q.answerType,
                        required: q.required,
                        weight: q.weight,
                    })),
            }));
            setSections(grouped);
            setDirty(false);
        } finally {
            setLoading(false);
        }
    }, [apiUrl, templateId, t]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        refresh();
    }, [refresh]);

    const editable = useMemo(
        () => permissions.canWrite && tree && !tree.isPublished,
        [permissions.canWrite, tree],
    );

    // ─── Reorder via native HTML5 DnD ───
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
                return next.map((s, i) => ({ ...s, sortOrder: i }));
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
            moved.sectionId = targetSectionId;
            const toIdx =
                targetQuestionId === null
                    ? toSec.questions.length
                    : toSec.questions.findIndex(
                          (q) => q.id === targetQuestionId,
                      );
            toSec.questions.splice(toIdx >= 0 ? toIdx : 0, 0, moved);
            // Rewrite sortOrder.
            for (const s of next) {
                s.questions.forEach((q, i) => (q.sortOrder = i));
            }
            return next;
        });
        setDirty(true);
        setDragging(null);
    }

    async function saveOrder() {
        if (!editable || !dirty) return;
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
                setError(apiErrorMessage(b, t('templateBuilder.saveError', { status: res.status })));
                return;
            }
            setDirty(false);
            await refresh();
        } finally {
            setSaving(false);
        }
    }

    async function publish() {
        if (!tree || tree.isPublished || !permissions.canWrite) return;
        setPublishing(true);
        setError(null);
        try {
            const res = await fetch(
                apiUrl(`/vendor-assessment-templates/${templateId}/publish`),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                },
            );
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                setError(
                    apiErrorMessage(
                        b,
                        t('templateBuilder.publishError', { status: res.status }),
                    ),
                );
                return;
            }
            // On success re-fetch — the tree flips to isPublished=true,
            // which swaps the editor for the read-only published banner.
            await refresh();
        } finally {
            setPublishing(false);
        }
    }

    async function addSection(title: string) {
        if (!editable) return;
        const res = await fetch(
            apiUrl(`/vendor-assessment-templates/${templateId}/sections`),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title }),
            },
        );
        if (res.ok) await refresh();
        else setError(t('templateBuilder.addSectionError', { status: res.status }));
    }

    async function addQuestionToSection(
        sectionId: string,
        prompt: string,
        answerType: Question['answerType'],
        required: boolean,
        weight: number,
    ) {
        if (!editable) return;
        const res = await fetch(
            apiUrl(
                `/vendor-assessment-templates/${templateId}/sections/${sectionId}/questions`,
            ),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt,
                    answerType,
                    required,
                    weight,
                }),
            },
        );
        if (res.ok) await refresh();
        else {
            const b = await res.json().catch(() => ({}));
            setError(apiErrorMessage(b, t('templateBuilder.addQuestionError', { status: res.status })));
        }
    }

    async function clonePublished() {
        if (!tree) return;
        const res = await fetch(
            apiUrl(`/vendor-assessment-templates/${templateId}/clone`),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'SAME_KEY_NEW_VERSION' }),
            },
        );
        if (res.ok) {
            const cloned = (await res.json()) as { id: string };
            router.push(tenantHref(`/admin/vendor-templates/${cloned.id}`));
        } else {
            setError(t('templateBuilder.cloneError', { status: res.status }));
        }
    }

    if (loading) return <SkeletonDetailPage />;
    if (!tree)
        return (
            <div className="p-12 text-center text-content-error">
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
                        <span>v{tree.version}</span>
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
                            onClick={saveOrder}
                            disabled={saving}
                            loading={saving}
                            id="save-order-btn"
                        >
                            {saving ? t('templateBuilder.saving') : t('templateBuilder.saveOrder')}
                        </Button>
                    )}
                    {permissions.canWrite &&
                        !tree.isPublished &&
                        tree.questions.length > 0 && (
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={publish}
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
                {sections.map((s) => (
                    <SectionCard
                        key={s.id}
                        section={s}
                        editable={!!editable}
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
                        onAddQuestion={(prompt, type, required, weight) =>
                            addQuestionToSection(
                                s.id,
                                prompt,
                                type,
                                required,
                                weight,
                            )
                        }
                    />
                ))}
            </div>

            {editable && <AddSectionForm onSubmit={(t) => addSection(t)} />}
        </div>
    );
}

// ─── Section card ──────────────────────────────────────────────────

function SectionCard({
    section,
    editable,
    onDragStart,
    onDrop,
    onQuestionDragStart,
    onQuestionDrop,
    onAddQuestion,
}: {
    section: Section;
    editable: boolean;
    onDragStart: () => void;
    onDrop: () => void;
    onQuestionDragStart: (questionId: string) => void;
    onQuestionDrop: (targetQuestionId: string | null) => void;
    onAddQuestion: (
        prompt: string,
        answerType: Question['answerType'],
        required: boolean,
        weight: number,
    ) => Promise<void>;
}) {
    const t = useTranslations('admin');
    return (
        <div
            className={cardVariants({ density: 'compact' })}
            draggable={editable}
            onDragStart={onDragStart}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            data-testid={`section-${section.id}`}
        >
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-tight">
                    {editable && (
                        <span
                            className="text-content-subtle cursor-grab"
                            aria-label={t('templateBuilder.dragSection')}
                        >
                            ⋮⋮
                        </span>
                    )}
                    <Heading level={2}>
                        {section.title}
                    </Heading>
                </div>
                {section.description && (
                    <p className="text-xs text-content-subtle ml-2">
                        {section.description}
                    </p>
                )}
            </div>

            <div className="space-y-tight mb-3">
                {section.questions.map((q) => (
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
                            <span className="text-content-subtle text-xs cursor-grab">
                                ⋮⋮
                            </span>
                        )}
                        <span className="flex-1 text-sm">{q.prompt}</span>
                        <StatusBadge variant="info" size="sm">
                            {q.answerType}
                        </StatusBadge>
                        {q.required && (
                            <StatusBadge variant="warning" size="sm">
                                {t('templateBuilder.required')}
                            </StatusBadge>
                        )}
                        <span className="text-xs text-content-subtle">
                            w={q.weight}
                        </span>
                    </div>
                ))}
                {section.questions.length === 0 && (
                    <div
                        className="text-xs text-content-subtle italic px-2 py-3 border border-dashed border-border-default/40 rounded"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => onQuestionDrop(null)}
                    >
                        {t('templateBuilder.questionsEmpty')}
                    </div>
                )}
            </div>

            {editable && <AddQuestionForm onSubmit={onAddQuestion} />}
        </div>
    );
}

// ─── Forms ─────────────────────────────────────────────────────────

function AddSectionForm({ onSubmit }: { onSubmit: (title: string) => void }) {
    const [title, setTitle] = useState('');
    const t = useTranslations('admin');
    return (
        <form
            className={cn(cardVariants({ density: 'compact' }), 'flex items-center gap-tight')}
            onSubmit={(e) => {
                e.preventDefault();
                if (title.trim()) {
                    onSubmit(title.trim());
                    setTitle('');
                }
            }}
            data-testid="add-section-form"
        >
            <input
                className="input flex-1"
                placeholder={t('templateBuilder.newSectionTitle')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label={t('templateBuilder.newSectionTitle')}
            />
            <Button
                variant="primary"
                icon={<Plus className="-ml-0.5 -mr-2.5" />}
                type="submit"
                disabled={!title.trim()}
            >
                {t('templateBuilder.addSectionBtn')}
            </Button>
        </form>
    );
}

function AddQuestionForm({
    onSubmit,
}: {
    onSubmit: (
        prompt: string,
        answerType: Question['answerType'],
        required: boolean,
        weight: number,
    ) => Promise<void>;
}) {
    const [prompt, setPrompt] = useState('');
    const [type, setType] = useState<Question['answerType']>('YES_NO');
    const [required, setRequired] = useState(true);
    const [weight, setWeight] = useState(1);
    const [busy, setBusy] = useState(false);
    const t = useTranslations('admin');

    return (
        <form
            className="border-t border-border-default/30 pt-3 grid grid-cols-1 md:grid-cols-12 gap-tight items-end"
            onSubmit={async (e) => {
                e.preventDefault();
                if (!prompt.trim()) return;
                setBusy(true);
                try {
                    await onSubmit(prompt.trim(), type, required, weight);
                    setPrompt('');
                    setType('YES_NO');
                    setRequired(true);
                    setWeight(1);
                } finally {
                    setBusy(false);
                }
            }}
            data-testid="add-question-form"
        >
            <div className="md:col-span-5">
                <label className="text-xs text-content-muted block mb-1">
                    {t('templateBuilder.promptLabel')}
                </label>
                <input
                    className="input w-full"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={t('templateBuilder.promptPlaceholder')}
                />
            </div>
            <div className="md:col-span-3">
                <label className="text-xs text-content-muted block mb-1">
                    {t('templateBuilder.typeLabel')}
                </label>
                <Combobox
                    hideSearch
                    selected={
                        ANSWER_TYPE_OPTIONS.find((o) => o.value === type) ??
                        null
                    }
                    setSelected={(opt) => {
                        if (opt) setType(opt.value as Question['answerType']);
                    }}
                    options={ANSWER_TYPE_OPTIONS}
                    matchTriggerWidth
                />
            </div>
            <div className="md:col-span-1">
                <label className="text-xs text-content-muted block mb-1">
                    {t('templateBuilder.weightLabel')}
                </label>
                <input
                    className="input w-full"
                    type="text"
                    inputMode="decimal"
                    pattern="[0-9]*\.?[0-9]*"
                    value={weight}
                    onChange={(e) => {
                        const n = Number(e.target.value);
                        setWeight(Number.isFinite(n) ? n : 1);
                    }}
                />
            </div>
            <div className="md:col-span-1 flex items-center pb-2">
                <label className="inline-flex items-center text-xs">
                    <input
                        type="checkbox"
                        checked={required}
                        onChange={(e) => setRequired(e.target.checked)}
                        className="mr-1"
                    />
                    {t('templateBuilder.requiredCheckbox')}
                </label>
            </div>
            <div className="md:col-span-2">
                <Button
                    variant="primary"
                    icon={busy ? undefined : <Plus className="-ml-0.5 -mr-2.5" />}
                    className="w-full"
                    type="submit"
                    disabled={busy || !prompt.trim()}
                    loading={busy}
                >
                    {busy ? t('templateBuilder.adding') : t('templateBuilder.addQuestionBtn')}
                </Button>
            </div>
        </form>
    );
}
