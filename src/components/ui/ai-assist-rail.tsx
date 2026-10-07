'use client';

/**
 * `<AiAssistRail>` — AI co-pilot rail content for the risk register.
 *
 * Right-rail roadmap, Phase 3 (see `docs/right-rail-aside-roadmap.md`,
 * use case 3). A persistent, co-resident entry point to the AI
 * risk-assessment flow — it follows the user across the risk register
 * rather than being a header button that navigates away and is then
 * out of sight.
 *
 * Content, not chrome: `<AsidePanel>` owns the collapse state + the
 * `<Sheet>` fallback below `xl`; this component is purely the
 * explainer + the launch CTA. The page resolves the destination href
 * and passes it in — this primitive never builds tenant URLs itself.
 */
import Link from 'next/link';
import { cn } from '@inflect/ui/lib/cn';

import { Sparkle3 } from '@inflect/ui/components/ui/icons/nucleo/sparkle3';
import { buttonVariants } from '@/components/ui/button-variants';

export interface AiAssistRailProps {
    /** Resolved href to the AI risk-assessment flow (`/risks/ai`). */
    aiHref: string;
}

const STEPS: ReadonlyArray<{ n: number; label: string }> = [
    { n: 1, label: 'Pick the assets in scope' },
    { n: 2, label: 'AI drafts candidate risks' },
    { n: 3, label: 'Review, edit, and apply' },
];

export function AiAssistRail({ aiHref }: AiAssistRailProps) {
    return (
        <div className="space-y-default" data-testid="ai-assist-rail">
            <p className="text-sm text-content-muted">
                Let AI surface candidate risks from your asset inventory
                — each one scored, with a rationale and suggested
                controls.
            </p>

            <ol className="space-y-tight">
                {STEPS.map((step) => (
                    <li
                        key={step.n}
                        className="flex items-center gap-tight text-sm text-content-default"
                    >
                        <span
                            className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-bg-muted text-xs font-semibold tabular-nums text-content-muted"
                            aria-hidden="true"
                        >
                            {step.n}
                        </span>
                        {step.label}
                    </li>
                ))}
            </ol>

            <Link
                href={aiHref}
                className={cn(
                    buttonVariants({ variant: 'primary', size: 'sm' }),
                    'w-full justify-center',
                )}
                data-testid="ai-assist-rail-cta"
            >
                <Sparkle3 className="h-4 w-4" aria-hidden="true" />
                Generate risk suggestions
            </Link>
        </div>
    );
}
