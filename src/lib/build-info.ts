/**
 * Which build is serving: the commit the running image was built from.
 *
 * The publish workflow passes `BUILD_SHA=${{ github.sha }}` as a build
 * argument and the Dockerfile's runner stage bakes it into the environment,
 * so `/api/health` and `/api/readyz` can say which build is live without
 * anybody reaching the VM (#4477). Anything that is not a published image
 * (a local server, CI's unpublished Docker Build) reports `dev`.
 */
import { env } from '@/env';

export function buildVersion(): string {
    return env.BUILD_SHA || 'dev';
}
