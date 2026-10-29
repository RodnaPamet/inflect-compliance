'use client';

/**
 * Whether a connection is a legacy application connection, for the cards on the
 * connection page that apply only to one.
 *
 * Decided from the connection's PROVIDER rather than from whether it happens to
 * carry an endpoint, so an `entra-id` connection shows nothing instead of an
 * error about a missing credential.
 *
 * `null` means UNKNOWN, not false: the list call failed. A card renders in that
 * case, because rendering nothing when an unrelated call failed would hide the
 * whole feature behind that error.
 */

import { useEffect, useState } from 'react';

import { useTenantApiUrl } from '@/lib/tenant-context-provider';

export const LEGACY_PROVIDER = 'legacy-mcp';

export function useIsLegacyConnection(connectionId: string): boolean | null {
    const apiUrl = useTenantApiUrl();
    const [applies, setApplies] = useState<boolean | null>(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await fetch(apiUrl('/admin/integrations'));
                if (!res.ok) throw new Error('load');
                const body: unknown = await res.json();
                const list = Array.isArray(body)
                    ? body
                    : ((body as { connections?: unknown[] }).connections ?? []);
                const mine = (list as { id?: string; provider?: string }[])
                    .find((c) => c.id === connectionId);
                if (alive) setApplies(mine?.provider === LEGACY_PROVIDER);
            } catch {
                if (alive) setApplies(null);
            }
        })();
        return () => { alive = false; };
    }, [apiUrl, connectionId]);

    return applies;
}
