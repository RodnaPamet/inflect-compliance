/**
 * The sandbox runtime's declared configuration (#3995).
 *
 * A SERVER component, following `admin/audit-log` rather than
 * `admin/ai-features`: everything on this page is read-only, so there is no
 * route to fetch from and no client-side loading state to get wrong. The
 * admin layout already gates this subtree on `admin.view`, which is the right
 * permission for a page that cannot change anything — unlike `ai-features`,
 * which adds an owner-only client gate because the endpoint behind it is
 * `admin.tenant_lifecycle`. Adding an owner gate here would hide a read-only
 * audit surface from the auditors who need it.
 *
 * `force-dynamic` because the declaration is read from the process environment:
 * a statically rendered copy would pin whatever the BUILD container had, which
 * for a page whose subject is "what did this deploy declare" is the one answer
 * guaranteed to be stale.
 */
import { getTranslations } from 'next-intl/server';

import {
    readSandboxExecutionPlatformEnabled,
    readSandboxRuntimeDeclaration,
} from '@/app-layer/usecases/sandbox-runtime-config';

import { SandboxRuntimeClient, type SandboxRuntimeView } from './SandboxRuntimeClient';

export const dynamic = 'force-dynamic';

export default async function SandboxRuntimePage() {
    // Awaited for the metadata title only; the rows translate client-side.
    await getTranslations('admin');

    const declaration = readSandboxRuntimeDeclaration();

    // ISO text, not a Date. `toISOString` is the string the deploy recorded,
    // not one re-rendered in the viewer's timezone — an "applied at" that shifts
    // by the reader would be a worse answer than none.
    const view: SandboxRuntimeView = {
        configured: declaration.configured,
        configDigest: declaration.configDigest,
        reachableVersion: declaration.reachableVersion,
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
