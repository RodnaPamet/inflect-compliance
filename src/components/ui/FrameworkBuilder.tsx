'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 46.4 — Framework Builder MVP.
 *
 * Drag-and-drop reorder of framework sections + requirements,
 * scoped tightly to MVP:
 *
 *   ✓ Reorder requirements within a section
 *   ✓ Reorder requirements across sections
 *   ✓ Reorder sections themselves
 *   ✓ Save / discard with optimistic local state
 *   ✗ No add / edit / delete  (deferred to a phase-3 builder)
 *   ✗ No section rename       (deferred — section labels are
 *                              derived from theme/section/code)
 *
 * Persistence: per-tenant overlay table
 * (`FrameworkRequirementOrder`). The global `FrameworkRequirement`
 * rows are NEVER mutated — that would change the framework for
 * every other tenant, which is exactly what the overlay design
 * guards against.
 *
 * Drag-and-drop: native HTML5 (`draggable` + dragstart/dragover/
 * drop). No new dependency. The state mutations live in
 * `builder-state.ts` as pure helpers, so the wiring here is
 * minimal — every drop just calls a helper and replaces state.
 */

import { cn } from '@/lib/cn';
import { GripVertical, Loader2, Save, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
    type BuilderSection,
    deriveBuilderModel,
    isModelDirty,
    moveRequirement,
    moveSection,
    serializeForApi,
} from '@/lib/framework-tree/builder-state';
import type { FrameworkTreePayload } from '@/lib/framework-tree/types';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';

// ─── Drag payload encoding ─────────────────────────────────────────────

const DRAG_TYPE_REQUIREMENT = 'application/x-framework-requirement';
const DRAG_TYPE_SECTION = 'application/x-framework-section';

// ─── Public props ──────────────────────────────────────────────────────

export interface FrameworkBuilderProps {
    /** Current tree payload — used to derive the initial builder model. */
    tree: FrameworkTreePayload;
    /**
     * Persistence callback. Receives the serialized reorder body and
     * returns a Promise. Parent owns the network call so the builder
     * stays focused on editing.
     */
    onSave: (body: ReturnType<typeof serializeForApi>) => Promise<void>;
    /** Called after a successful save (page can refetch). */
    onSaved?: () => void;
    /** Optional id on the wrapper for tests / analytics. */
    id?: string;
}

// ─── Component ─────────────────────────────────────────────────────────

export function FrameworkBuilder({
    tree,
    onSave,
    onSaved,
    id = 'framework-builder',
}: FrameworkBuilderProps) {
    // The original model is the snapshot we compare against to
    // know if there are unsaved changes. Frozen via useMemo on
    // the tree's framework id — refreshes when the parent
    // refetches.
    const originalModel = useMemo(() => deriveBuilderModel(tree), [tree]);
    const [model, setModel] = useState<BuilderSection[]>(originalModel);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reset local state when the tree changes underneath us
    // (e.g. parent refetched after a save). Was `useMemo` (a real
    // bug — `useMemo` is for pure derived values, not state-setter
    // side effects); `useEffect` is the correct primitive and what
    // the React Compiler rules surfaced.
    const treeFrameworkId = tree.framework.id;
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setModel(originalModel);
        setError(null);
    }, [treeFrameworkId, originalModel]);

    const dirty = useMemo(
        () => isModelDirty(model, originalModel),
        [model, originalModel],
    );

    const handleSave = useCallback(async () => {
        if (!dirty) return;
        setSaving(true);
        setError(null);
        try {
            await onSave(serializeForApi(model));
            onSaved?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save reorder');
        } finally {
            setSaving(false);
        }
    }, [dirty, model, onSave, onSaved]);

    const handleDiscard = useCallback(() => {
        setModel(originalModel);
        setError(null);
    }, [originalModel]);

    // ── Drag handlers ─────────────────────────────────────────────────
    // Encode the drag payload as JSON in a custom mime type so a
    // dragover-then-drop on text inputs etc. doesn't accidentally
    // trigger a reorder.
    const onRequirementDragStart = (
        e: React.DragEvent<HTMLDivElement>,
        sectionId: string,
        requirementId: string,
    ) => {
        e.dataTransfer.setData(
            DRAG_TYPE_REQUIREMENT,
            JSON.stringify({ sectionId, requirementId }),
        );
        e.dataTransfer.effectAllowed = 'move';
    };

    const onSectionDragStart = (
        e: React.DragEvent<HTMLDivElement>,
        sectionId: string,
    ) => {
        e.dataTransfer.setData(DRAG_TYPE_SECTION, sectionId);
        e.dataTransfer.effectAllowed = 'move';
    };

    // Allow a drop only when the drag type matches our payload —
    // prevents accidental drops from text drags into the builder.
    const allowDropIf = (e: React.DragEvent, type: string) => {
        if (e.dataTransfer.types.includes(type)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        }
    };

    const onRequirementDrop = (
        e: React.DragEvent<HTMLDivElement>,
        targetSectionId: string,
        targetIndex: number,
    ) => {
        const raw = e.dataTransfer.getData(DRAG_TYPE_REQUIREMENT);
        if (!raw) return;
        e.preventDefault();
        try {
            const source = JSON.parse(raw) as {
                sectionId: string;
                requirementId: string;
            };
            setModel((prev) =>
                moveRequirement(prev, source, {
                    sectionId: targetSectionId,
                    index: targetIndex,
                }),
            );
        } catch {
            /* ignore malformed payload */
        }
    };

    const onSectionDrop = (
        e: React.DragEvent<HTMLDivElement>,
        targetIndex: number,
    ) => {
        const sourceId = e.dataTransfer.getData(DRAG_TYPE_SECTION);
        if (!sourceId) return;
        e.preventDefault();
        setModel((prev) => moveSection(prev, sourceId, targetIndex));
    };

    return (
        <div id={id} className="space-y-default">
            {/* Header / actions */}
            <div className="flex items-center justify-between flex-wrap gap-tight">
                <div>
                    <Heading level={3}>
                        Builder — reorder mode
                    </Heading>
                    <p className="text-xs text-content-muted">
                        Drag the handle on any row to reorder. Changes are saved per-tenant — the
                        framework stays unchanged for everyone else.
                    </p>
                </div>
                <div className="flex items-center gap-tight">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleDiscard}
                        disabled={!dirty || saving}
                        id="framework-builder-discard"
                    >
                        <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
                        Discard
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        onClick={handleSave}
                        disabled={!dirty || saving}
                        id="framework-builder-save"
                    >
                        {saving ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                            <Save className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                        Save reorder
                    </Button>
                </div>
            </div>

            {error && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border-border-error bg-bg-error text-xs text-content-error')}>
                    {error}
                </div>
            )}

            {/* Sections */}
            <div className="space-y-compact">
                {model.map((section, sectionIndex) => (
                    <div key={section.id} className="space-y-1">
                        {/* Section drop target ABOVE this section */}
                        <SectionDropZone
                            onDrop={(e) => onSectionDrop(e, sectionIndex)}
                            onDragOver={(e) => allowDropIf(e, DRAG_TYPE_SECTION)}
                        />
                        <div
                            draggable
                            onDragStart={(e) => onSectionDragStart(e, section.id)}
                            data-builder-section-id={section.id}
                            className={cn(cardVariants({ density: 'compact' }), 'space-y-tight cursor-grab active:cursor-grabbing')}
                        >
                            <div className="flex items-center gap-tight">
                                <GripVertical
                                    className="w-4 h-4 text-content-subtle flex-shrink-0"
                                    aria-hidden="true"
                                />
                                <Heading level={3} className="flex-1">
                                    {section.label}
                                </Heading>
                                <span className="text-xs text-content-subtle">
                                    {section.requirements.length}
                                </span>
                            </div>

                            <div className="space-y-0.5">
                                {section.requirements.map((req, reqIndex) => (
                                    <div key={req.id}>
                                        <RequirementDropZone
                                            onDrop={(e) =>
                                                onRequirementDrop(e, section.id, reqIndex)
                                            }
                                            onDragOver={(e) =>
                                                allowDropIf(e, DRAG_TYPE_REQUIREMENT)
                                            }
                                        />
                                        <div
                                            draggable
                                            onDragStart={(e) =>
                                                onRequirementDragStart(e, section.id, req.id)
                                            }
                                            data-builder-requirement-id={req.id}
                                            className={cn(
                                                'flex items-center gap-tight px-2 py-1.5 rounded',
                                                'cursor-grab active:cursor-grabbing',
                                                'text-xs hover:bg-bg-muted',
                                            )}
                                        >
                                            <GripVertical
                                                className="w-3.5 h-3.5 text-content-subtle flex-shrink-0"
                                                aria-hidden="true"
                                            />
                                            <code className="font-mono text-content-brand flex-shrink-0 min-w-[3.5rem]">
                                                {req.code}
                                            </code>
                                            <span className="truncate flex-1 min-w-0 text-content-default">
                                                {req.title}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                                {/* Drop target at the END of the section (after the last requirement). */}
                                <RequirementDropZone
                                    onDrop={(e) =>
                                        onRequirementDrop(
                                            e,
                                            section.id,
                                            section.requirements.length,
                                        )
                                    }
                                    onDragOver={(e) =>
                                        allowDropIf(e, DRAG_TYPE_REQUIREMENT)
                                    }
                                />
                            </div>
                        </div>
                    </div>
                ))}
                {/* Section drop target at the END of the section list */}
                <SectionDropZone
                    onDrop={(e) => onSectionDrop(e, model.length)}
                    onDragOver={(e) => allowDropIf(e, DRAG_TYPE_SECTION)}
                />
            </div>
        </div>
    );
}

// ─── Drop-zone primitives ──────────────────────────────────────────────

function RequirementDropZone({
    onDrop,
    onDragOver,
}: {
    onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
    const [active, setActive] = useState(false);
    return (
        <div
            data-builder-drop="requirement"
            onDragEnter={(e) => {
                if (e.dataTransfer.types.includes(DRAG_TYPE_REQUIREMENT)) {
                    setActive(true);
                }
            }}
            onDragLeave={() => setActive(false)}
            onDragOver={onDragOver}
            onDrop={(e) => {
                setActive(false);
                onDrop(e);
            }}
            className={cn(
                'h-1.5 rounded transition-colors',
                active && 'bg-[var(--brand-default)]',
            )}
        />
    );
}

function SectionDropZone({
    onDrop,
    onDragOver,
}: {
    onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
    const [active, setActive] = useState(false);
    return (
        <div
            data-builder-drop="section"
            onDragEnter={(e) => {
                if (e.dataTransfer.types.includes(DRAG_TYPE_SECTION)) {
                    setActive(true);
                }
            }}
            onDragLeave={() => setActive(false)}
            onDragOver={onDragOver}
            onDrop={(e) => {
                setActive(false);
                onDrop(e);
            }}
            className={cn(
                'h-2 rounded transition-colors',
                active && 'bg-[var(--brand-default)]',
            )}
        />
    );
}
