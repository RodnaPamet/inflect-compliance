import { DashboardSkeleton } from './DashboardSkeleton';

/**
 * Route-level loading.tsx for /t/[tenantSlug]/dashboard.
 *
 * The shell it streams lives in `./DashboardSkeleton` — beside the page
 * whose sections it traces, not in the shared primitives module. See
 * that file's header for why the split is where it is.
 */
export default function DashboardLoading() {
    return <DashboardSkeleton />;
}
