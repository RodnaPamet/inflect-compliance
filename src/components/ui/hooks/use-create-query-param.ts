'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * `?create=1` opens a list page's create modal, then the param is stripped.
 *
 * The param is how a deep link reaches the modal: `/t/{slug}/assets/new` is
 * a redirect shim to `/t/{slug}/assets?create=1`, so a bookmark or an
 * emailed link lands on the list with the form already open.
 *
 * Stripping it afterwards is the part that is easy to omit and matters:
 * leave it in the URL and the modal reopens on every back-navigation to the
 * page, because the param is still there. `router.replace` (not `push`)
 * keeps that correction out of the history stack, and `scroll: false` stops
 * the list jumping to the top behind the modal.
 *
 * This ran as seven byte-identical copies across the list pages — assets,
 * risks, audits, controls, evidence, policies, vendors — each with the same
 * two eslint-disable comments. Seven chances to fix a bug in one of them.
 *
 * @param onOpen  Called once, on first mount, when the param is present.
 * @param basePath  Where to rewrite to, without the query string
 *                  (e.g. `/t/acme/assets`). Other params are preserved.
 */
export function useCreateQueryParam(onOpen: () => void, basePath: string): void {
    const router = useRouter();
    const searchParams = useSearchParams();

    useEffect(() => {
        if (searchParams?.get('create') !== '1') return;

        // Turning a URL into an open modal is the whole point of the
        // effect. (No set-state-in-effect disable needed here: at the call
        // sites the setState was inline, so the rule fired; behind this
        // boundary it is an opaque callback.)
        onOpen();

        const next = new URLSearchParams(searchParams.toString());
        next.delete('create');
        const qs = next.toString();
        router.replace(`${basePath}${qs ? `?${qs}` : ''}`, { scroll: false });
        // First mount only: re-running on a later searchParams change would
        // reopen the modal after the user closed it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}
