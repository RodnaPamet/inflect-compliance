/**
 * The sandbox runtime's declared configuration (#3995).
 *
 * A SERVER component, following `admin/audit-log` rather than
 * `admin/ai-features`: everything on this page is read-only, so there is no
 * route to fetch from and no client-side loading state to get wrong.
 * `admin.view` is the right permission for a page that cannot change anything
 * — unlike `ai-features`, which adds an owner-only client gate because the
 * endpoint behind it is `admin.tenant_lifecycle`. It is applied HERE, before
 * the declaration is read, not left to the admin layout: that layout is a
 * client component and cannot keep this server component's props out of the
 * payload. See `../_lib/admin-page-requirements.ts`.
 *
 * `force-dynamic` because the declaration is read from the process environment:
 * a statically rendered copy would pin whatever the BUILD container had, which
 * for a page whose subject is "what did this deploy declare" is the one answer
 * guaranteed to be stale.
 */
import { getTranslations } from 'next-intl/server';

import {
    readSandboxExecutionPlatformEnabled,
    readSandboxRuntimeDeclarationWithProbe,
} from '@/app-layer/usecases/sandbox-runtime-config';

import { gateAdminPage } from '../_lib/admin-page-gate';
import { SandboxRuntimeClient, type SandboxRuntimeView } from './SandboxRuntimeClient';

export const dynamic = 'force-dynamic';

export default async function SandboxRuntimePage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const gate = await gateAdminPage('/admin/sandbox-runtime', params);
    if (!gate.allowed) return gate.forbidden;

    // Awaited for the metadata title only; the rows translate client-side.
    await getTranslations('admin');

    // PROBED here, in the server component, because the health port is
    // internal: the browser cannot reach it and must not be asked to try. The
    // probe is bounded at two seconds and an unreachable gateway is the normal
    // case — the VM is deliberately stopped most of the time (#4448) — so this
    // adds a verdict to the page rather than a failure mode.
    const declaration = await readSandboxRuntimeDeclarationWithProbe();

    // ISO text, not a Date. `toISOString` is the string the deploy recorded,
    // not one re-rendered in the viewer's timezone — an "applied at" that shifts
    // by the reader would be a worse answer than none.
    const view: SandboxRuntimeView = {
        configured: declaration.configured,
        configDigest: declaration.configDigest,
        reachableVersion: declaration.reachableVersion,
        probeOutcome: declaration.probeOutcome,
        channels: declaration.channels,
        appliedAtIso: declaration.appliedAt === null ? null : declaration.appliedAt.toISOString(),
    };

    return (
        <SandboxRuntimeClient
            view={view}
            platformEnabled={readSandboxExecutionPlatformEnabled()}
        />
    );
}
