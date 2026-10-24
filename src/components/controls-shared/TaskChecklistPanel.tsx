'use client';

/**
 * The template guidance and authored steps of a task installed from a control
 * template.
 *
 * Install has written all of this onto every template task since 2026-09-04 —
 * the steps into `checklistJson`, the phase, evidence hint and suggested role
 * into `metadataJson` — and until this component nothing rendered any of it.
 * A task page showed the title and the description and nothing else, so a
 * control installed from a framework with fully authored steps looked exactly
 * as generic as one installed from a framework with none.
 *
 * Presentational: the page owns the mutation (its `okOrThrow` + optimistic
 * cache contract), this owns the reading of two untyped JSON columns.
 */
import { useTranslations } from 'next-intl';
import { Checkbox } from '@/components/ui/checkbox';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Heading } from '@/components/ui/typography';
import { cn } from '@inflect/ui/lib/cn';

export interface TaskChecklistItemView {
    readonly id: string;
    readonly text: string;
    readonly hint?: string;
    readonly done: boolean;
}

export interface TaskTemplateGuidance {
    readonly phase?: string;
    readonly evidenceHint?: string;
    readonly suggestedRole?: string;
}

const PHASES = new Set(['SCOPE', 'IMPLEMENT', 'OPERATE', 'REVIEW']);

/**
 * Read `Task.checklistJson` defensively. The server validates on write, but
 * this is a JSON column and the page must not crash on a row written by an
 * older build — an unreadable item is skipped rather than rendered half-built.
 */
export function parseTaskChecklist(json: unknown): TaskChecklistItemView[] {
    if (!Array.isArray(json)) return [];
    return json.flatMap((raw): TaskChecklistItemView[] => {
        if (!raw || typeof raw !== 'object') return [];
        const item = raw as Record<string, unknown>;
        if (typeof item.id !== 'string' || typeof item.text !== 'string') return [];
        return [{
            id: item.id,
            text: item.text,
            ...(typeof item.hint === 'string' && item.hint ? { hint: item.hint } : {}),
            done: item.done === true,
        }];
    });
}

/** Read the three template-intent keys install puts in `Task.metadataJson`. */
export function parseTaskTemplateGuidance(json: unknown): TaskTemplateGuidance {
    if (!json || typeof json !== 'object') return {};
    const meta = json as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
    const phase = typeof meta.phase === 'string' && PHASES.has(meta.phase) ? meta.phase : undefined;
    return {
        ...(phase ? { phase } : {}),
        ...(text(meta.evidenceHint) ? { evidenceHint: text(meta.evidenceHint) } : {}),
        ...(text(meta.suggestedRole) ? { suggestedRole: text(meta.suggestedRole) } : {}),
    };
}

interface TaskChecklistPanelProps {
    readonly items: readonly TaskChecklistItemView[];
    readonly guidance: TaskTemplateGuidance;
    readonly canEdit: boolean;
    readonly onToggle: (itemId: string, done: boolean) => void;
    /** The item whose write is in flight, so it cannot be double-toggled. */
    readonly pendingItemId?: string | null;
}

export function TaskChecklistPanel({
    items,
    guidance,
    canEdit,
    onToggle,
    pendingItemId = null,
}: TaskChecklistPanelProps) {
    const t = useTranslations('tasks.checklist');
    const hasGuidance = Boolean(guidance.phase || guidance.evidenceHint || guidance.suggestedRole);
    if (items.length === 0 && !hasGuidance) return null;

    const doneCount = items.filter((item) => item.done).length;

    return (
        <div className="border-t border-border-subtle pt-default space-y-default" id="task-template-panel">
            {hasGuidance && (
                <div className="space-y-compact">
                    <Heading level={3}>{t('guidanceHeading')}</Heading>
                    <div className="grid grid-cols-2 gap-default">
                        {guidance.phase && (
                            <div>
                                <span className="text-xs text-content-subtle uppercase">{t('phase')}</span>
                                <p className="text-sm text-content-default mt-1" id="task-template-phase">
                                    {t(`phaseLabels.${guidance.phase}`)}
                                </p>
                            </div>
                        )}
                        {guidance.suggestedRole && (
                            <div>
                                <span className="text-xs text-content-subtle uppercase">{t('suggestedRole')}</span>
                                <p className="text-sm text-content-default mt-1" id="task-template-role">
                                    {guidance.suggestedRole}
                                </p>
                            </div>
                        )}
                        {guidance.evidenceHint && (
                            <div className="col-span-2">
                                <span className="text-xs text-content-subtle uppercase">{t('evidenceHint')}</span>
                                <p className="text-sm text-content-default mt-1 whitespace-pre-wrap" id="task-template-evidence-hint">
                                    {guidance.evidenceHint}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {items.length > 0 && (
                <div className="space-y-compact" id="task-checklist">
                    <div className="flex items-center justify-between gap-default">
                        <Heading level={3}>{t('heading')}</Heading>
                        <span className="text-xs text-content-muted" id="task-checklist-progress">
                            {t('progress', { done: doneCount, total: items.length })}
                        </span>
                    </div>
                    <ProgressBar
                        value={doneCount}
                        max={items.length}
                        size="sm"
                        variant={doneCount === items.length ? 'success' : 'brand'}
                        aria-label={t('progress', { done: doneCount, total: items.length })}
                    />
                    <ol className="space-y-compact">
                        {items.map((item, index) => {
                            const checkboxId = `task-checklist-item-${item.id}`;
                            return (
                                <li key={item.id} className="flex items-start gap-compact">
                                    <Checkbox
                                        id={checkboxId}
                                        checked={item.done}
                                        disabled={!canEdit || pendingItemId === item.id}
                                        onCheckedChange={(next) => onToggle(item.id, next === true)}
                                        aria-label={t('stepAria', { position: index + 1, text: item.text })}
                                        className="mt-0.5"
                                    />
                                    <label htmlFor={checkboxId} className="text-sm cursor-pointer">
                                        <span
                                            className={cn(
                                                'text-content-default',
                                                item.done && 'line-through text-content-muted',
                                            )}
                                        >
                                            {item.text}
                                        </span>
                                        {item.hint && (
                                            <span className="block text-xs text-content-muted mt-0.5">{item.hint}</span>
                                        )}
                                    </label>
                                </li>
                            );
                        })}
                    </ol>
                </div>
            )}
        </div>
    );
}
