'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { useToast } from '@/components/ui/hooks';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
import type { SampleAuditAnswerRefusal } from '@/lib/agentic/sample-audit-answerability';

/**
 * ANSWERING THE RETROSPECTIVE SAMPLE AUDIT (OWASP ASI09).
 *
 * The sampler drew these approvals; this is where a second human says whether
 * the approval was right. Until this panel existed the queue had a reader and an
 * API route and no way through the product to answer one, so the disagreement
 * rate on `/agents/review-quality` could only ever report "nothing answered".
 *
 * ── What this component does NOT decide ──────────────────────────────────
 *
 * Whether the viewer may answer a row. Every row arrives carrying `refusal`,
 * computed by the server from the same predicate `recordSampleAuditOutcome`
 * refuses with (`@/lib/agentic/sample-audit-answerability`). A row with a
 * refusal renders its reason and NO control — not a disabled one that posts and
 * fails, and never a rule this file works out for itself. The approver ids that
 * decide the hardest of those refusals never reach the browser.
 *
 * ── The two refusals this component DOES hold ────────────────────────────
 *
 * The outcome/codes pairing, because it is a property of the form rather than of
 * the row: DISSENTED needs at least one code, and every other outcome must carry
 * none. Both are enforced by the server too (400 either way); here they are the
 * difference between a submit button that works and one that does not, and the
 * codes are cleared whenever the outcome moves off DISSENTED so the second can
 * never be sent at all.
 *
 * A race — somebody else answering the row between this render and this click —
 * is NOT held here and must not be: the server's conditional claim on
 * `outcome: 'PENDING'` is the only thing that can settle it. It arrives as an
 * error, and the row is taken off the list because it is somebody's answer now.
 */

export type SampleAuditQueueRow = {
    id: string;
    /** Resolved server-side: the agent's name, or the "former agent" label. */
    agentLabel: string;
    /** Resolved server-side too — `agents.proposals.kind.*`, one catalogue. */
    kindLabel: string;
    /** ISO strings: a Date would cross the boundary, but nothing here needs one. */
    sampledAt: string;
    approvedAt: string | null;
    refusal: SampleAuditAnswerRefusal | null;
};

export function SampleAuditQueue({
    rows,
    outcomes,
    dissentCodes,
}: {
    rows: SampleAuditQueueRow[];
    /** `ANSWERABLE_OUTCOMES` — derived by the server, never spelled here. */
    outcomes: string[];
    /** `SAMPLE_AUDIT_DISSENT_CODES`, in their declared order. */
    dissentCodes: string[];
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();

    const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
    const [openId, setOpenId] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<string>('');
    const [codes, setCodes] = useState<ReadonlySet<string>>(new Set());
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const visible = rows.filter((r) => !answered.has(r.id));

    function open(id: string) {
        setOpenId(id);
        setOutcome('');
        setCodes(new Set());
        setError(null);
    }

    /** Moving off DISSENTED drops the codes, so they cannot be sent with it. */
    function chooseOutcome(next: string) {
        setOutcome(next);
        if (next !== 'DISSENTED') setCodes(new Set());
    }

    function toggleCode(code: string) {
        setCodes((prev) => {
            const nextSet = new Set(prev);
            if (!nextSet.delete(code)) nextSet.add(code);
            return nextSet;
        });
    }

    const formValid = outcome !== '' && (outcome !== 'DISSENTED' || codes.size > 0);

    async function submit(id: string) {
        if (!formValid || saving) return;
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(apiUrl(`/agent-proposals/sample-audits/${id}`), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(
                    outcome === 'DISSENTED'
                        ? { outcome, dissentCodes: [...codes] }
                        : { outcome },
                ),
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as unknown;
                throw new Error(apiErrorMessage(body, t('sampleAudit.answerFailed')));
            }
            // Off the list either way: this row now carries somebody's answer.
            setAnswered((prev) => new Set(prev).add(id));
            setOpenId(null);
            toast.success(t('sampleAudit.answered'));
            // The rate and the queue are both server-read, so the page has to
            // re-read to show this answer in THE NUMBER.
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : t('sampleAudit.answerFailed'));
        } finally {
            setSaving(false);
        }
    }

    if (visible.length === 0) {
        return (
            <p className="text-sm text-content-muted" data-testid="sample-audit-queue-empty">
                {t('sampleAudit.empty')}
            </p>
        );
    }

    return (
        <ul className="space-y-default" data-testid="sample-audit-queue">
            {visible.map((row) => (
                <li
                    key={row.id}
                    className={cn(cardVariants({ density: 'compact' }), 'space-y-default')}
                    data-testid={`sample-audit-${row.id}`}
                >
                    <div className="flex flex-wrap items-center gap-compact">
                        <Badge variant="neutral">{row.kindLabel}</Badge>
                        <span className="text-sm font-medium">{row.agentLabel}</span>
                        <span className="text-xs text-content-muted">
                            {row.approvedAt
                                ? t('sampleAudit.approvedAt', {
                                      when: formatDateTime(row.approvedAt),
                                  })
                                : t('sampleAudit.approvedAtUnknown')}
                        </span>
                        <span className="text-xs text-content-subtle">
                            {t('sampleAudit.sampledAt', { when: formatDateTime(row.sampledAt) })}
                        </span>
                    </div>

                    {row.refusal !== null ? (
                        // The server would refuse this answer, so no control is
                        // offered — the reason is printed instead, because a row
                        // the reader cannot act on and cannot see a reason for
                        // reads as a broken page.
                        <p
                            className="text-sm text-content-muted"
                            data-testid={`sample-audit-refusal-${row.id}`}
                        >
                            {t(`sampleAudit.refusal.${row.refusal}`)}
                        </p>
                    ) : openId === row.id ? (
                        <div className="space-y-default">
                            <RadioGroup
                                value={outcome}
                                onValueChange={chooseOutcome}
                                className="flex flex-wrap gap-compact"
                                aria-label={t('sampleAudit.outcomeLabel')}
                            >
                                {outcomes.map((o) => (
                                    <label
                                        key={o}
                                        className="flex items-center gap-tight text-sm cursor-pointer"
                                    >
                                        <RadioGroupItem value={o} />
                                        {t(`sampleAudit.outcome.${o}`)}
                                    </label>
                                ))}
                            </RadioGroup>

                            {outcome === 'DISSENTED' && (
                                <fieldset
                                    className="space-y-tight"
                                    data-testid={`sample-audit-codes-${row.id}`}
                                >
                                    <legend className="text-sm font-medium">
                                        {t('sampleAudit.codesLabel')}
                                    </legend>
                                    {dissentCodes.map((code) => (
                                        <label
                                            key={code}
                                            className="flex items-start gap-tight text-sm cursor-pointer"
                                        >
                                            <Checkbox
                                                checked={codes.has(code)}
                                                onCheckedChange={() => toggleCode(code)}
                                            />
                                            {t(`sampleAudit.code.${code}`)}
                                        </label>
                                    ))}
                                </fieldset>
                            )}

                            {error && <InlineNotice variant="error">{error}</InlineNotice>}

                            <div className="flex gap-compact">
                                {/*
                                    SECONDARY, not primary. This is one row's
                                    inline confirm on a report page, not the
                                    page's own action — and the ghost Cancel
                                    beside it carries the hierarchy. The primary
                                    budget is a repo-wide ceiling; spending one
                                    here would be spending it on the Nth row.
                                */}
                                <Button
                                    variant="secondary"
                                    disabled={!formValid || saving}
                                    onClick={() => submit(row.id)}
                                    data-testid={`sample-audit-submit-${row.id}`}
                                >
                                    {t('sampleAudit.submit')}
                                </Button>
                                <Button variant="ghost" onClick={() => setOpenId(null)}>
                                    {t('sampleAudit.cancel')}
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <Button
                            variant="secondary"
                            onClick={() => open(row.id)}
                            data-testid={`sample-audit-answer-${row.id}`}
                        >
                            {t('sampleAudit.answer')}
                        </Button>
                    )}
                </li>
            ))}
        </ul>
    );
}
