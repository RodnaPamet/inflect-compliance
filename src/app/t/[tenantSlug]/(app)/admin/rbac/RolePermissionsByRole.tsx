'use client';

/**
 * The permission matrix on a phone: one role at a time.
 *
 * The matrix is a resource × action × six-roles table. At a phone's width it
 * showed one role column of six, with nothing saying there were more (owner
 * decision, 2026-11-23: one role at a time below `md`). Here a role is picked
 * from a strip of tabs — the shared `ScrollCueStrip`, which says when it
 * scrolls — and that role's permissions are listed in one column, grouped by
 * resource as the table groups its rows, each line saying in words whether the
 * role has it.
 *
 * The page renders this below `md` and the table from `md` up, both from the
 * same rows, so the two cannot disagree.
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, Minus } from 'lucide-react';
import { cn } from '@inflect/ui/lib/cn';
import { cardVariants } from '@/components/ui/card-variants';
import { ScrollCueStrip } from '@/components/ui/scroll-cue-strip';
import { Heading } from '@/components/ui/typography';

export interface RolePermissionGroup {
    resource: string;
    /** The resource in words. */
    label: string;
    actions: {
        action: string;
        /** The action in words. */
        label: string;
        /** The roles that hold it. */
        grantedTo: string[];
    }[];
}

export interface RolePermissionsByRoleProps {
    roles: { value: string; label: string }[];
    groups: RolePermissionGroup[];
    /** The role shown first: the viewer's own, when it is a built-in role. */
    initialRole: string;
}

export function RolePermissionsByRole({ roles, groups, initialRole }: RolePermissionsByRoleProps) {
    const t = useTranslations('admin.rbac.byRole');
    const [role, setRole] = React.useState(
        roles.some((r) => r.value === initialRole) ? initialRole : roles[0]?.value,
    );
    const roleLabel = roles.find((r) => r.value === role)?.label ?? role;
    const total = groups.reduce((n, g) => n + g.actions.length, 0);
    const granted = groups.reduce(
        (n, g) => n + g.actions.filter((a) => a.grantedTo.includes(role)).length,
        0,
    );
    const panelId = 'rbac-role-panel';

    // Arrow keys move between tabs, as a tablist's keyboard contract asks.
    const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        let next: number | null = null;
        if (e.key === 'ArrowRight') next = (index + 1) % roles.length;
        else if (e.key === 'ArrowLeft') next = (index - 1 + roles.length) % roles.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = roles.length - 1;
        if (next === null) return;
        e.preventDefault();
        setRole(roles[next].value);
        document.getElementById(`rbac-role-tab-${roles[next].value}`)?.focus();
    };

    return (
        <div className="space-y-default" data-testid="rbac-by-role">
            <ScrollCueStrip
                role="tablist"
                aria-label={t('pickerAria')}
                activeKey={role}
                listClassName="gap-tight"
                data-testid="rbac-role-tabs"
            >
                {roles.map((r, i) => {
                    const selected = r.value === role;
                    return (
                        <button
                            key={r.value}
                            type="button"
                            role="tab"
                            id={`rbac-role-tab-${r.value}`}
                            aria-selected={selected}
                            aria-controls={panelId}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => setRole(r.value)}
                            onKeyDown={(e) => onTabKeyDown(e, i)}
                            className={cn(
                                'min-h-11 shrink-0 whitespace-nowrap rounded-lg border px-3 text-sm font-medium transition-colors',
                                selected
                                    ? 'border-border-emphasis bg-bg-muted text-content-emphasis'
                                    : 'border-border-subtle text-content-muted hover:text-content-emphasis',
                            )}
                        >
                            {r.label}
                        </button>
                    );
                })}
            </ScrollCueStrip>

            <div
                role="tabpanel"
                id={panelId}
                aria-labelledby={`rbac-role-tab-${role}`}
                className="space-y-default"
            >
                <p className="text-sm text-content-muted" data-testid="rbac-role-summary">
                    {t('summary', { role: roleLabel, granted, total })}
                </p>
                {groups.map((g) => (
                    <section
                        key={g.resource}
                        className={cardVariants({ density: 'compact' })}
                        aria-labelledby={`rbac-group-${g.resource}`}
                    >
                        <Heading level={3} id={`rbac-group-${g.resource}`} className="mb-2">
                            {g.label}
                        </Heading>
                        <ul className="space-y-tight">
                            {g.actions.map((a) => {
                                const has = a.grantedTo.includes(role);
                                return (
                                    <li
                                        key={a.action}
                                        className="flex items-center justify-between gap-compact text-sm"
                                        data-testid={`rbac-permission-${g.resource}.${a.action}`}
                                        data-granted={has ? 'true' : 'false'}
                                    >
                                        <span className={cn('min-w-0 break-words', has ? 'text-content-default' : 'text-content-subtle')}>
                                            {a.label}
                                        </span>
                                        {has ? (
                                            <span className="inline-flex shrink-0 items-center gap-tight text-xs text-content-success">
                                                <Check className="size-4" aria-hidden="true" />
                                                {t('granted')}
                                            </span>
                                        ) : (
                                            <span className="inline-flex shrink-0 items-center gap-tight text-xs text-content-subtle">
                                                <Minus className="size-4" aria-hidden="true" />
                                                {t('notGranted')}
                                            </span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                ))}
            </div>
        </div>
    );
}
