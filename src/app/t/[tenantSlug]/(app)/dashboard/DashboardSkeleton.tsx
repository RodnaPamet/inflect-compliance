import { Card } from '@/components/ui/card';
import { Skeleton, SkeletonKpiGrid } from '@/components/ui/skeleton';

/**
 * The compliance dashboard's loading shell.
 *
 * Mirrors the SHIPPED executive-dashboard layout so the route-level
 * `loading.tsx` streams a shape that matches what renders: posture hero
 * → 6-card KPI grid → coverage + risk-distribution → evidence + alerts
 * → task + policy donuts → exception + treatment-plan health → risk
 * heatmap + expiry calendar → trend section → next-best-action + recent
 * activity.
 *
 * ── WHY IT LIVES HERE AND NOT IN `components/ui/skeleton.tsx` ──
 *
 * It used to sit in that file, beside `Skeleton`, `SkeletonTable`,
 * `SkeletonKpiGrid` and the rest. Those are PRIMITIVES — shapes with no
 * opinion about what they are standing in for. This is not one: it is a
 * tracing of one specific page's sections, in that page's order, and the
 * only thing that can tell you it has gone stale is the page it sits
 * next to. Keeping it in the primitives module meant the file that
 * defines "what a loading bar looks like" also hard-coded this
 * product's dashboard IA, so every consumer of a plain `<Skeleton>`
 * imported a module that knew about posture heroes and evidence expiry.
 *
 * The rule the split draws: a skeleton whose correctness depends on ONE
 * route lives beside that route. A skeleton whose correctness depends
 * only on geometry lives in the primitives module.
 *
 * `SkeletonDashboard` (still in the primitives module) is a different
 * thing and stays: it is the generic list-dashboard shell the
 * risks/controls/vendors dashboard pages share.
 */

function DashboardDonutCardSkeleton() {
    return (
        <Card className="h-full">
            <Skeleton className="h-4 w-32 mb-4" />
            <div className="grid grid-cols-2 gap-default items-center">
                <Skeleton className="size-[130px] rounded-full mx-auto" />
                <div className="space-y-tight w-full">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-3 w-full" />
                    ))}
                </div>
            </div>
        </Card>
    );
}

function DashboardListCardSkeleton({ rows = 4 }: { rows?: number }) {
    return (
        <Card className="h-full">
            <Skeleton className="h-4 w-40 mb-4" />
            <div className="space-y-tight">
                {Array.from({ length: rows }).map((_, i) => (
                    <Skeleton key={i} className="h-3 w-full" />
                ))}
            </div>
        </Card>
    );
}

export function DashboardSkeleton() {
    return (
        <div className="space-y-section" aria-hidden="true">
            {/* Page header */}
            <div className="space-y-tight">
                <Skeleton className="h-7 w-64" />
                <Skeleton className="h-4 w-96 max-w-full" />
            </div>

            {/* Posture hero */}
            <Card className="min-h-[140px]">
                <Skeleton className="h-3 w-32 mb-3" />
                <Skeleton className="h-10 w-2/3 mb-3" />
                <Skeleton className="h-4 w-full max-w-xl" />
            </Card>

            {/* KPI grid (6 cards) */}
            <SkeletonKpiGrid count={6} />

            {/* Control coverage + risk distribution */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <DashboardListCardSkeleton rows={3} />
                <DashboardDonutCardSkeleton />
            </div>

            {/* Evidence status + compliance alerts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <DashboardListCardSkeleton />
                <DashboardListCardSkeleton />
            </div>

            {/* Task status + policy status donuts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <DashboardDonutCardSkeleton />
                <DashboardDonutCardSkeleton />
            </div>

            {/* Exception inventory + treatment-plan status */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <DashboardListCardSkeleton />
                <DashboardListCardSkeleton />
            </div>

            {/* Risk heatmap + evidence expiry calendar */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <Skeleton className="h-[280px] w-full rounded-lg" />
                <Skeleton className="h-[240px] w-full rounded-lg" />
            </div>

            {/* Trend section */}
            <Card>
                <Skeleton className="h-4 w-40 mb-4" />
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-default">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-24 w-full rounded-lg" />
                    ))}
                </div>
            </Card>

            {/* Next best action + recent activity */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <DashboardListCardSkeleton rows={3} />
                <DashboardListCardSkeleton />
            </div>
        </div>
    );
}
