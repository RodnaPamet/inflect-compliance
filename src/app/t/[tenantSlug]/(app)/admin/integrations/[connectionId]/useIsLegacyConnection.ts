'use client';

/**
 * Whether a connection is a legacy application connection, for the cards on the
 * connection page that apply only to one.
 *
 * Decided from the connection's PROVIDER rather than from whether it happens to
 * carry an endpoint, so an `entra-id` connection shows nothing instead of an
 * error about a missing credential.
 *
 * Three answers besides yes and no:
 *
 *   undefined  not known yet: the list has not answered, or the caller passed
 *              `enabled: false` and no request was made;
 *   null       UNKNOWN: the list call failed. A card renders in that case,
 *              because rendering nothing when an unrelated call failed would
 *              hide the whole feature behind that error.
 *
 * The list is `admin.manage`. A caller that knows its viewer lacks that key
 * passes `enabled: false`, so a visit does not write an AUTHZ_DENIED row.
 */

import { useEffect, useState } from 'react';

import { useTenantApiUrl } from '@/lib/tenant-context-provider';

export const LEGACY_PROVIDER = 'legacy-mcp';

export function useIsLegacyConnection(
    connectionId: string,
    enabled: boolean = true,
): boolean | null | undefined {
    const apiUrl = useTenantApiUrl();
    const [applies, setApplies] = useState<boolean | null | undefined>(undefined);

    useEffect(() => {
        if (!enabled) return;
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
    }, [apiUrl, connectionId, enabled]);

    return applies;
}
