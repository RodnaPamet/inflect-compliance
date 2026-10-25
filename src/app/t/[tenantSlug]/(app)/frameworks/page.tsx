import { getTenantCtx } from '@/app-layer/context';
import { listFrameworks, computeCoverage } from '@/app-layer/usecases/framework';

import { FrameworksClient } from './FrameworksClient';

export const dynamic = 'force-dynamic';

export default async function FrameworksPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const frameworks = await listFrameworks(ctx);

    // Fetch coverage for each framework in parallel.
    const coverages: Record<string, Awaited<ReturnType<typeof computeCoverage>>> = {};
    // R2-P3 — track which frameworks FAILED to compute so the UI can show an
    // honest "couldn't load" instead of a fabricated 0% that reads identical
    // to a genuinely-uncovered framework.
    const coverageErrors: string[] = [];
    await Promise.all(
        frameworks.map(async (fw) => {
            try {
                coverages[fw.key] = await computeCoverage(ctx, fw.key);
            } catch {
                coverageErrors.push(fw.key);
            }
        }),
    );

    return (
        <FrameworksClient
            frameworks={frameworks}
            coverages={coverages}
            coverageErrors={coverageErrors}
            tenantSlug={tenantSlug}
            // The key the install API checks — see FrameworksClient.
            canInstall={ctx.appPermissions.frameworks.install}
        />
    );
}
