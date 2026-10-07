'use client';

/**
 * Epic 58 — Presets panel.
 *
 * A vertical cmdk list of preset buttons rendered inside the
 * DateRangePicker / DatePicker popover. Selecting a preset commits
 * its range/date and closes the popover. Single-key shortcuts
 * declared by a preset (`preset.shortcut = 'l'`) are surfaced as a
 * small `<kbd>` chip on the right of the row — consistent with the
 * chip the Epic 57 filter trigger uses for its `F` hint.
 *
 * The panel is intentionally presentation-only. It does NOT fetch
 * "now" to compare a current value against a preset — the caller
 * passes `activePresetId` when it knows which preset drove the
 * current value. This keeps the panel deterministic under SSR and
 * avoids re-renders every millisecond.
 */

import { cn } from '@inflect/ui/lib/cn';
import { Command } from 'cmdk';

import { Tooltip } from '../tooltip';
import type { Preset } from './types';

export interface PresetsProps<TPreset extends Preset> {
    /** Preset rows to render, in display order. */
    presets: TPreset[];
    /** Called when a row is picked (mouse click or keyboard). */
    onSelect: (preset: TPreset) => void;
    /** Highlight the row matching this id. */
    activePresetId?: string;
    className?: string;
}

export function Presets<TPreset extends Preset>({
    presets,
    onSelect,
    activePresetId,
    className,
}: PresetsProps<TPreset>) {
    return (
        <Command
            className={cn(
                'w-full rounded-md focus:outline-none',
                className,
            )}
            tabIndex={0}
            // cmdk handles the roving tabindex. We render the list as
            // our own entries so `shouldFilter` default (fuzzy-match on
            // input typing) stays inert — the preset list has no input.
            shouldFilter={false}
            loop
            data-testid="date-picker-presets"
        >
            <Command.List className="flex w-full flex-col gap-0.5 p-1">
                {presets.map((preset) => {
                    const isActive = preset.id === activePresetId;
                    const row = (
                        <Command.Item
                            key={preset.id}
                            value={preset.id}
                            onSelect={() => onSelect(preset)}
                            className={cn(
                                'group flex cursor-pointer items-center justify-between gap-compact',
                                'rounded-md px-2.5 py-1.5 text-sm',
                                'text-content-default',
                                'data-[selected=true]:bg-bg-muted data-[selected=true]:text-content-emphasis',
                                isActive &&
                                    'bg-bg-subtle font-medium text-content-emphasis',
                            )}
                            data-testid={`date-picker-preset-${preset.id}`}
                            data-active={isActive || undefined}
                        >
                            <span className="truncate">{preset.label}</span>
                            {preset.shortcut && (
                                <kbd
                                    aria-hidden="true"
                                    className={cn(
                                        'hidden shrink-0 items-center rounded border',
                                        'border-border-subtle bg-bg-muted px-1.5 py-0.5',
                                        'text-[10px] font-medium text-content-muted',
                                        'md:inline-flex',
                                    )}
                                >
                                    {preset.shortcut.toUpperCase()}
                                </kbd>
                            )}
                        </Command.Item>
                    );
                    // A preset with `tooltipContent` gets a Tooltip
                    // wrap. Radix Tooltip's `asChild` composes cleanly
                    // with cmdk's Command.Item (both pass refs through
                    // their children).
                    if (preset.tooltipContent) {
                        return (
                            <Tooltip
                                key={preset.id}
                                content={preset.tooltipContent}
                                side="right"
                            >
                                {row}
                            </Tooltip>
                        );
                    }
                    return row;
                })}
            </Command.List>
        </Command>
    );
}

Presets.displayName = 'DatePicker.Presets';
