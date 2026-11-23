'use client';

/**
 * BulkActionBar — the canonical table selection action row.
 *
 * Rendered inside a `<DataTable selectionControls={…}>` slot (the slot pops
 * over the column-header row when rows are selected). The DataTable's
 * SelectionToolbar owns the selected-count + Clear; THIS component owns the
 * form: a "Choose action…" picker → the active action's value input → Apply.
 *
 * Extracted from the Tasks table (the first consumer) so every entity table
 * gets the SAME bulk-edit UX. A consumer supplies its `actions` (each with an
 * optional value-input renderer + a `canApply` gate) and an `onApply` handler
 * that fires its bulk mutation. The bar manages action/value/label state and
 * clears the form once the apply settles.
 *
 * Usage:
 *   <DataTable
 *     selectionEnabled
 *     selectionControls={() => (
 *       <BulkActionBar actions={ASSET_BULK_ACTIONS} onApply={apply} applying={m.isMutating} />
 *     )}
 *   />
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { AppIcon } from '@/components/icons/AppIcon';
import { Modal, type ConfirmTone } from '@/components/ui/modal';
import { cn } from '@inflect/ui/lib/cn';

export interface BulkActionDef {
    /** Stable action id (e.g. 'assign', 'status'). */
    value: string;
    /** Dropdown label (e.g. 'Assign', 'Change Status'). */
    label: string;
    /**
     * Render the value input for this action (people-picker, status select,
     * date picker, …). Omit for an action that needs no value. Receives the
     * current value + setters; `setLabel` carries an optimistic display label
     * (e.g. the chosen assignee's name) the consumer can use in its optimistic
     * update.
     */
    renderInput?: (ctx: {
        value: string;
        setValue: (v: string) => void;
        setLabel: (l: string) => void;
    }) => ReactNode;
    /** Whether Apply is enabled for the current value. Default: always. */
    canApply?: (value: string) => boolean;
    /**
     * Require a confirmation dialog before `onApply` fires.
     *
     * `true` — the canonical DELETE confirm: danger tone, "Delete N <noun>?",
     * "Delete" verb (locked by the destructive-vocabulary ratchet).
     *
     * An object — customise for a non-destructive bulk action (e.g. Approve).
     * The title defaults to `"<confirmLabel> N <noun>?"`; provide `tone`
     * (default `"danger"`) + `confirmLabel` (default `"Delete"`) to match the
     * action's verb, and an optional `description`.
     */
    confirm?:
        | boolean
        | { tone?: ConfirmTone; confirmLabel?: string; title?: string; description?: string };
}

export interface BulkActionBarProps {
    actions: BulkActionDef[];
    /** Apply handler — `(actionId, value, optimisticLabel)`. */
    onApply: (action: string, value: string, label: string) => void | Promise<void>;
    /** True while the consumer's bulk mutation is in flight. */
    applying?: boolean;
    /** Number of selected rows — surfaced in the confirm dialog. */
    selectedCount?: number;
    /** Plural entity noun for the confirm dialog (e.g. "assets"). */
    entityLabel?: string;
    className?: string;
}

export function BulkActionBar({
    actions,
    onApply,
    applying,
    selectedCount,
    entityLabel,
    className,
}: BulkActionBarProps) {
    const t = useTranslations('common');
    const [action, setAction] = useState('');
    const [value, setValue] = useState('');
    const [label, setLabel] = useState('');
    const [confirmOpen, setConfirmOpen] = useState(false);
    const wasApplying = useRef(false);

    // Clear the form once an apply settles (success OR failure) — mirrors the
    // toolbar resetting after the bulk mutation completes.
    useEffect(() => {
        if (wasApplying.current && !applying) {
            setAction('');
            setValue('');
            setLabel('');
        }
        wasApplying.current = !!applying;
    }, [applying]);

    const options: ComboboxOption[] = actions.map((a) => ({
        value: a.value,
        label: a.label,
    }));
    const active = actions.find((a) => a.value === action) ?? null;
    const ready = !!action && (active?.canApply ? active.canApply(value) : true);

    // Apply — destructive actions route through a confirm dialog first.
    //
    // `onApply` is AWAITED. It was called bare, so a caller whose handler
    // rejected produced an unhandled promise rejection: no toast, no error
    // state, and the selection left intact as though nothing had been
    // attempted. Awaiting it lets a rejection surface as a normal error at
    // this boundary instead of escaping the React tree.
    const handleApply = async () => {
        if (active?.confirm) {
            setConfirmOpen(true);
            return;
        }
        await onApply(action, value, label);
    };

    const noun = entityLabel ?? t('table.items');

    const valueInput = active?.renderInput?.({ value, setValue, setLabel });
    const applyLabel = t('table.apply');

    // PHONE LAYOUT (below md). The desktop row — picker, value input, icon-only
    // Apply, all inline — is restored at `md:` exactly; every class without a
    // prefix below is the phone's.
    //
    // On a phone the bar is the selection toolbar's whole second row, and its
    // controls fill it: the picker stretches, Apply is a labelled 44px button
    // beside it, and an action's value input (when it has one) gets a row of
    // its own between them — the picker takes the full row, the input and
    // Apply share the next. DOM order stays picker → value → Apply, which is
    // the order the user works in, so focus order and reading order agree.
    return (
        <div
            data-bulk-action-bar
            className={cn(
                'flex w-full flex-wrap items-center gap-compact',
                'md:w-auto md:flex-nowrap',
                className,
            )}
        >
            <div
                data-bulk-action-picker
                // `md:contents` (here and on the value wrapper below): on
                // desktop the wrapper is not a box, so the controls sit in the
                // row exactly as they did before the wrappers existed.
                className={cn(
                    'flex min-w-0 md:contents',
                    valueInput ? 'basis-full' : 'flex-1',
                )}
            >
                <Combobox
                    hideSearch
                    id="bulk-action-select"
                    selected={options.find((o) => o.value === action) ?? null}
                    setSelected={(opt) => {
                        setAction(opt?.value ?? '');
                        setValue('');
                        setLabel('');
                    }}
                    options={options}
                    placeholder={t('table.chooseAction')}
                    matchTriggerWidth
                    buttonProps={{ size: 'sm', className: 'w-full md:w-auto' }}
                />
            </div>
            {valueInput ? (
                <div
                    data-bulk-action-value
                    // On a phone the input fills what Apply leaves of the row.
                    className="flex min-w-0 flex-1 max-md:*:min-w-0 max-md:*:flex-1 md:contents"
                >
                    {valueInput}
                </div>
            ) : null}
            <Tooltip content={applyLabel}>
                <Button
                    variant="primary"
                    size="icon"
                    disabled={!ready}
                    loading={applying}
                    onClick={handleApply}
                    id="bulk-apply-btn"
                    aria-label={applyLabel}
                    icon={<AppIcon name="checkCircle" size={14} />}
                    // Desktop: one size smaller than the canonical icon button
                    // (h-9 → h-8, sm-equivalent square + sm icon rhythm) so it
                    // sits a notch below the row's text controls, label in the
                    // tooltip. Phone: a 44px button that SAYS Apply — an
                    // unlabelled icon is the one control on the bar a finger
                    // cannot hover to learn.
                    className="h-11 w-auto shrink-0 gap-tight px-default md:h-8 md:w-8 md:px-0 [&_svg]:size-3.5"
                    textWrapperClassName="md:sr-only"
                    text={applyLabel}
                />
            </Tooltip>
            {active?.confirm && (() => {
                const cfg = typeof active.confirm === 'object' ? active.confirm : {};
                const verb = cfg.confirmLabel ?? t('table.confirmVerbDelete');
                const tone = cfg.tone ?? 'danger';
                return (
                    <Modal.Confirm
                        showModal={confirmOpen}
                        setShowModal={setConfirmOpen}
                        tone={tone}
                        title={cfg.title ?? t('table.confirmTitle', { verb, count: selectedCount ?? 0, noun })}
                        description={
                            cfg.description ??
                            t('table.confirmDescription', { noun })
                        }
                        confirmLabel={verb}
                        onConfirm={() => {
                            setConfirmOpen(false);
                            void Promise.resolve(onApply(action, value, label));
                        }}
                    />
                );
            })()}
        </div>
    );
}
