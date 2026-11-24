'use client';

/**
 * The sections of one tab on the agent page (#5898).
 *
 * The page's nine sections are grouped into four tabs; a tab that holds more
 * than one section (Assessment, Authority, Activity) shows them here as a
 * second, quieter strip of tabs, with the open section in its own panel. A tab
 * that holds one (Overview) renders its content and nothing else.
 *
 * The strip is a `ScrollCueStrip`, the mechanism every tab bar uses (owner
 * decision, 2026-11-23: the cued strip stays): on a phone it fades and shows a
 * chevron while a section is off screen, and keeps the open one in view.
 *
 * Each section's tab keeps the id it had as a page tab (`tab-runs`) and labels
 * its panel (`tabpanel-runs`), so the section is addressed as it was.
 */

import type * as React from 'react';
import { cn } from '@inflect/ui/lib/cn';
import { ScrollCueStrip } from '@/components/ui/scroll-cue-strip';

export interface AgentSection<K extends string> {
    key: K;
    label: string;
    disabled?: boolean;
}

export function AgentSectionStrip<K extends string>({
    label,
    sections,
    active,
    onSelect,
    children,
}: {
    /** The group's name, which names the strip. */
    label: string;
    sections: readonly AgentSection<K>[];
    active: K;
    onSelect: (key: K) => void;
    children: React.ReactNode;
}) {
    if (sections.length <= 1) return <>{children}</>;
    return (
        <>
            <ScrollCueStrip
                role="tablist"
                aria-label={label}
                listClassName="gap-tight"
                activeKey={active}
                data-testid="agent-section-tabs"
            >
                {sections.map((s) => {
                    const isActive = s.key === active;
                    return (
                        <button
                            key={s.key}
                            type="button"
                            role="tab"
                            id={`tab-${s.key}`}
                            data-testid={`tab-${s.key}`}
                            aria-selected={isActive}
                            aria-controls={`tabpanel-${s.key}`}
                            disabled={s.disabled}
                            onClick={() => {
                                if (!s.disabled) onSelect(s.key);
                            }}
                            className={cn(
                                'min-h-9 whitespace-nowrap rounded-md border px-3 text-sm font-medium transition',
                                isActive
                                    ? 'border-border-emphasis bg-bg-muted text-content-emphasis'
                                    : 'border-border-subtle text-content-muted hover:text-content-emphasis',
                                s.disabled && 'cursor-not-allowed opacity-50',
                            )}
                        >
                            {s.label}
                        </button>
                    );
                })}
            </ScrollCueStrip>
            <div
                role="tabpanel"
                id={`tabpanel-${active}`}
                aria-labelledby={`tab-${active}`}
                data-testid="agent-section-panel"
                className="space-y-section"
            >
                {children}
            </div>
        </>
    );
}
