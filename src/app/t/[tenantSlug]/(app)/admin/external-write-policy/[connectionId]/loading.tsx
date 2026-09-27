import { SkeletonDetailPage } from '@/components/ui/skeleton';

/**
 * External-write policy loading skeleton — instant route-change feedback, so the
 * navigation from the external-tools page does not land on a blank screen while
 * the policy resolves.
 */
export default function ExternalWritePolicyLoading() {
    return <SkeletonDetailPage />;
}
