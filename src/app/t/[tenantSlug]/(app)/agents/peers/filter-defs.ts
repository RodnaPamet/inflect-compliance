/**
 * Filter configuration for the A2A peers page (#3679). One static status enum,
 * applied client-side to the SSR rows: a tenant registers a handful of peers,
 * and `listPeerAgents` returns them all (bounded at 200).
 *
 * Takes its LABELS, not a translator. The client resolves them with its own
 * `useTranslations('agents')` binding, so every key is a literal call the
 * i18n guard can bind and check (`tests/guards/i18n-keys-resolve.test.ts`).
 */
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
// FilterDefInput.icon is typed `LucideIcon`; a new filter-defs file has no
// Nucleo option until the filter platform migrates. Allowlisted in
// tests/guards/no-lucide.test.ts (same precedent as every other *filter-defs.ts).
import { Activity } from 'lucide-react';

export const PEER_STATUS_KEYS = ['ACTIVE', 'SUSPENDED', 'RETIRED'] as const;

export interface PeerFilterLabels {
    readonly status: string;
    readonly statusDesc: string;
    readonly group: string;
    readonly statusValues: Readonly<Record<(typeof PEER_STATUS_KEYS)[number], string>>;
}

function peerFilterDefsInput(labels: PeerFilterLabels) {
    return {
        status: {
            label: labels.status,
            description: labels.statusDesc,
            group: labels.group,
            icon: Activity,
            options: optionsFromEnum({ ...labels.statusValues }),
            multiple: true,
            resetBehavior: 'clearable',
        },
    } as const;
}

export const PEER_FILTER_KEYS = ['status'] as const;

export function buildPeerFilters(labels: PeerFilterLabels) {
    return createTypedFilterDefs()(peerFilterDefsInput(labels)).filters;
}
