'use client';

/**
 * Attach this BIA to a control as evidence (kind BIA) — the continuity
 * link that establishes real framework coverage. Reuses the existing
 * `/business-continuity/:id/link-control` endpoint.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { unwrapCappedList, type CappedList } from '@/lib/list-backfill-cap';

interface ControlOption {
    id: string;
    code?: string | null;
    name: string;
}

export function BiaLinkControlModal({
    tenantSlug,
    biaId,
    linkedControlIds,
    onClose,
    onLinked,
}: {
    tenantSlug: string;
    biaId: string;
    linkedControlIds: string[];
    onClose: () => void;
    onLinked: () => void | Promise<void>;
}) {
    const tx = useTranslations('audits');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    // ─── Read ───
    //
    // The picker's option source is the shared `/controls` list cache, keyed
    // through CACHE_KEYS so this modal sits on the SAME entry every other
    // consumer reads rather than a near-miss string that never dedupes.
    //
    // The route returns the backfill-capped `{ rows, truncated }` envelope
    // (`applyBackfillCap`), so the response goes through `unwrapCappedList`.
    // The hand-rolled reader this replaces accepted only a bare array or a
    // `{ controls }` wrapper — neither shape this endpoint returns — so the
    // picker silently rendered zero options on a perfectly successful load.
    // That is the exact failure `unwrapCappedList` was written for (see its
    // docstring: the "Link a CVE" modal broke the same way when `/assets`
    // was converted).
    const controlsQuery = useTenantSWR<CappedList<ControlOption> | ControlOption[]>(
        CACHE_KEYS.controls.list(),
    );
    // Memoise on the CACHE value, not on the unwrapped array: `unwrapCappedList`
    // returns a fresh array every render, so depending on its result would make
    // the memo below re-run unconditionally.
    const controlsData = controlsQuery.data;

    // One banner, two causes — kept distinguishable in state rather than
    // collapsed into a single `error` string as before. `controlsQuery.error`
    // is a transport/HTTP failure loading the options; `submitError` is the
    // POST's. A successful load that returns NO controls is neither: it shows
    // no banner and an empty picker, which is the honest empty state.
    const error =
        submitError ?? (controlsQuery.error ? tx('biaDetail.linkControlFailed') : null);

    const options = useMemo(
        () =>
            unwrapCappedList(controlsData)
                .filter((c) => !linkedControlIds.includes(c.id))
                .map((c) => ({ value: c.id, label: c.code ? `${c.code} · ${c.name}` : c.name })),
        [controlsData, linkedControlIds],
    );

    /**
     * ─── Write ───
     *
     * Deliberately NOT a `useTenantMutation`. The surface this POST changes —
     * the BIA detail's `linkedControls` — is a SERVER-component prop: the page
     * is rendered by `[id]/page.tsx` and `onLinked()` ends in
     * `router.refresh()`. There is no client cache entry holding it, so a
     * mutation hook would compute an optimistic update against an empty entry,
     * do nothing, and still depend on `router.refresh()` for the actual
     * refresh — the same reasoning that excluded `BiaDetailClient` in
     * docs/implementation-notes/2026-08-10-audits-data-access.md.
     *
     * Even with a cache, the prediction is not derivable here: a `LinkedControl`
     * row carries each control's resolved framework `requirements`
     * (code/title/frameworkKey/frameworkName), which the picker's
     * `{ id, code, name }` option does not carry and the server resolves.
     *
     * This is the file's only remaining raw `fetch`, so it stays inline rather
     * than behind a `send` helper — one call site cannot drift from itself.
     */
    const onSubmit = async () => {
        if (!selectedId) return;
        setSubmitting(true);
        setSubmitError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/business-continuity/${biaId}/link-control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ controlId: selectedId }),
            });
            if (!res.ok) throw new Error(tx('biaDetail.linkControlFailed'));
            await onLinked();
        } catch (e) {
            setSubmitError(e instanceof Error ? e.message : tx('biaDetail.linkControlFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            showModal
            setShowModal={(v) => {
                if (!v && !submitting) onClose();
            }}
            size="md"
            title={tx('biaDetail.linkControlTitle')}
            description={tx('biaDetail.linkControlDesc')}
            preventDefaultClose={submitting}
        >
            <Modal.Header title={tx('biaDetail.linkControlTitle')} description={tx('biaDetail.linkControlDesc')} />
            <Modal.Body>
                {error && (
                    <div className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error" role="alert">
                        {error}
                    </div>
                )}
                <FormField label={tx('biaDetail.linkControlSelect')}>
                    <Combobox
                        id="bia-link-control"
                        name="bia-link-control"
                        options={options}
                        selected={options.find((o) => o.value === selectedId) ?? null}
                        setSelected={(o) => setSelectedId(o?.value ?? null)}
                        placeholder={tx('biaDetail.linkControlPlaceholder')}
                        matchTriggerWidth
                        forceDropdown
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
            </Modal.Body>
            <Modal.Footer>
                <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
                    {tx('biaDetail.linkControlCancel')}
                </Button>
                <Button type="button" variant="primary" onClick={onSubmit} disabled={submitting || !selectedId}>
                    {tx('biaDetail.linkControlConfirm')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}
