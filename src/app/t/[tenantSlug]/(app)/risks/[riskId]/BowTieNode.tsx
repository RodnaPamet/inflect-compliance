'use client';

/* RQ-7 (canvas) — custom xyflow node for the bow-tie diagram. One component
   styled by node type: threat / preventive barrier / event / mitigating
   barrier / consequence. */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { ShieldCheck } from '@/components/ui/icons/nucleo/shield-check';
import { Bolt } from '@/components/ui/icons/nucleo/bolt';
import { TriangleWarning } from '@/components/ui/icons/nucleo/triangle-warning';
import { CurrencyDollar } from '@/components/ui/icons/nucleo/currency-dollar';
import { cn } from '@inflect/ui/lib/cn';
import { useMoneyFormatter } from '@/lib/tenant-context-provider';

export const BOWTIE_NODE_TYPES = {
    bowTieThreat: 'bowTieThreat',
    bowTieEvent: 'bowTieEvent',
    bowTieConsequence: 'bowTieConsequence',
    bowTiePreventiveBarrier: 'bowTiePreventiveBarrier',
    bowTieMitigatingBarrier: 'bowTieMitigatingBarrier',
} as const;

// RQ3-OB-A — money speaks the tenant's currency. Nodes render
// inside the tenant provider tree, so the bound hook applies.

const effTone = (e: number | null | undefined) =>
    e == null ? 'border-border-subtle' : e >= 70 ? 'border-border-success' : e >= 40 ? 'border-border-warning' : 'border-border-error';

function BowTieNodeImpl({ type, data }: NodeProps) {
    const money = useMoneyFormatter();
    const d = data as Record<string, unknown>;
    const label = String(d.title ?? d.label ?? '');

    if (type === BOWTIE_NODE_TYPES.bowTieEvent) {
        return (
            <div className="w-44 rounded-lg border border-border-emphasis bg-bg-muted/40 p-default text-center">
                <Handle type="target" position={Position.Left} className="!bg-content-muted" />
                <TriangleWarning className="mx-auto size-6 text-content-muted" />
                <div className="truncate font-medium text-content-emphasis">{label}</div>
                <div className="mt-tight text-xs tabular-nums text-content-muted">
                    Score {String(d.score ?? '—')}{d.ale != null ? ` · ${money(d.ale as number)}/yr` : ''}
                </div>
                <Handle type="source" position={Position.Right} className="!bg-content-muted" />
            </div>
        );
    }

    const isThreat = type === BOWTIE_NODE_TYPES.bowTieThreat;
    const isConsequence = type === BOWTIE_NODE_TYPES.bowTieConsequence;
    const isBarrier = type === BOWTIE_NODE_TYPES.bowTiePreventiveBarrier || type === BOWTIE_NODE_TYPES.bowTieMitigatingBarrier;

    const Icon = isThreat ? Bolt : isConsequence ? CurrencyDollar : ShieldCheck;
    const tone = isBarrier ? effTone(d.effectiveness as number | null) : 'border-border-subtle';
    const secondary = isThreat
        ? (d.tef != null ? `TEF ${String(d.tef)}` : '')
        : isConsequence
            ? money(d.magnitude as number | null)
            : (d.effectiveness != null ? `${String(d.effectiveness)}%` : '');

    return (
        <div className={cn('w-40 rounded-md border bg-bg-default px-default py-tight text-sm', tone)}>
            <Handle type="target" position={Position.Left} className="!bg-content-subtle" />
            <div className="flex items-center gap-tight">
                <Icon className="size-3.5 shrink-0 text-content-muted" />
                <span className="truncate text-content-emphasis">{label}</span>
            </div>
            {secondary && <div className="mt-tight text-xs tabular-nums text-content-subtle">{secondary}</div>}
            <Handle type="source" position={Position.Right} className="!bg-content-subtle" />
        </div>
    );
}

export const BowTieNode = memo(BowTieNodeImpl);
