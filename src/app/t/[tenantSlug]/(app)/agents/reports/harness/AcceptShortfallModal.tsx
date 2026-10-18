'use client';

/**
 * Record, or renew, the owner's time-limited acceptance of one agent's
 * harness shortfall (#3687) — `POST /admin/agents/harness-acceptances`.
 *
 * The tab opens this only where the server computed `ACCEPT` or `RENEW`, which
 * is the acceptance usecase's own rule (`shortfallAcceptanceRefusal`). The API
 * still decides: a refusal arrives as the server's sentence, is shown INLINE
 * and as a toast, and the dialog stays open over it — a dialog that closed on
 * failure would put the refusal behind an overlay the owner never sees again.
 *
 * THE EXPIRY IS A WHOLE DAY. The picker yields a calendar day; the request
 * carries the END of that day in UTC as a full ISO instant, which is what the
 * strict `z.string().datetime()` schema accepts and what "accepted through
 * <day>" means. The selectable range is tomorrow to `MAX_ACCEPTANCE_DAYS - 2`
 * days ahead, so every timezone stays inside the server's "in the future and
 * at most a year" checks rather than being refused by them.
 *
 * A renewal is the same POST: the usecase supersedes the acceptance in force,
 * so exactly one speaks for the agent at a time.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDate } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import {
    JUSTIFICATION_MAX_CHARS,
    JUSTIFICATION_MIN_CHARS,
    MAX_ACCEPTANCE_DAYS,
} from '@/lib/agentic/harness-acceptance-rules';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the dialog is opened for. Built from a matrix row or an acceptances-card row. */
export interface AcceptTarget {
    readonly discoveredAgentId: string;
    readonly agentLabel: string;
    readonly renewing: boolean;
    /** The expiry of the acceptance a renewal supersedes. */
    readonly inForceUntil: string | null;
}

/**
 * The picker reads its bounds in LOCAL time (react-day-picker), while its value
 * is a UTC-midnight day. Re-anchor a UTC day to the local midnight with the
 * same Y/M/D — the bridge the picker applies to its own value.
 */
function localMidnightOfUtcDay(utcMs: number): Date {
    const d = new Date(utcMs);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The last millisecond of the chosen UTC day, as the full instant the API requires. */
export function endOfUtcDayIso(day: Date): string {
    return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1) - 1).toISOString();
}

export function AcceptShortfallModal({ target, onClose }: { target: AcceptTarget; onClose: () => void }) {
    const t = useTranslations('agents');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();

    const [justification, setJustification] = useState('');
    const [expires, setExpires] = useState<Date | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const { fromDate, toDate } = useMemo(() => {
        const now = new Date();
        const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        return {
            fromDate: localMidnightOfUtcDay(todayUtc + DAY_MS),
            toDate: localMidnightOfUtcDay(todayUtc + (MAX_ACCEPTANCE_DAYS - 2) * DAY_MS),
        };
    }, []);

    const trimmed = justification.trim();
    const justificationOk = trimmed.length >= JUSTIFICATION_MIN_CHARS && trimmed.length <= JUSTIFICATION_MAX_CHARS;
    const canSubmit = justificationOk && expires !== null && !busy;

    const submit = async () => {
        if (!canSubmit || expires === null) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/agents/harness-acceptances'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    discoveredAgentId: target.discoveredAgentId,
                    justification: trimmed,
                    expiresAt: endOfUtcDayIso(expires),
                }),
            });
            if (!res.ok) {
                // Never `body.error ?? …`: the envelope's `error` is an OBJECT,
                // and rendering one throws inside the page's error boundary.
                const body = await res.json().catch(() => null);
                const message = apiErrorMessage(body, t('harness.acceptModal.failed'));
                setError(message);
                toast.error(message);
                return;
            }
            toast.success(t('harness.acceptModal.saved'));
            onClose();
            router.refresh();
        } catch {
            const message = t('harness.acceptModal.failed');
            setError(message);
            toast.error(message);
        } finally {
            setBusy(false);
        }
    };

    const title = target.renewing ? t('harness.acceptModal.renewTitle') : t('harness.acceptModal.title');

    return (
        <Modal
            showModal
            setShowModal={(v) => {
                if (!v && !busy) onClose();
            }}
            size="md"
            title={title}
            preventDefaultClose={busy}
        >
            <Modal.Header title={title} description={t('harness.acceptModal.description', { agent: target.agentLabel })} />
            <Modal.Form
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <Modal.Body>
                    <div className="space-y-default" data-testid="harness-accept-modal">
                        {target.renewing && target.inForceUntil && (
                            <InlineNotice variant="info" icon={null} data-testid="harness-accept-renew-notice">
                                {t('harness.acceptModal.renewNotice', { date: formatDate(target.inForceUntil) })}
                            </InlineNotice>
                        )}
                        {error && (
                            <InlineNotice variant="error" data-testid="harness-accept-error">
                                {error}
                            </InlineNotice>
                        )}
                        <FormField
                            label={t('harness.acceptModal.justificationLabel')}
                            description={t('harness.acceptModal.justificationHint', {
                                min: JUSTIFICATION_MIN_CHARS,
                                max: JUSTIFICATION_MAX_CHARS,
                            })}
                            required
                        >
                            <Textarea
                                id="harness-accept-justification"
                                rows={4}
                                maxLength={JUSTIFICATION_MAX_CHARS}
                                value={justification}
                                onChange={(e) => setJustification(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>
                        <FormField
                            label={t('harness.acceptModal.expiresLabel')}
                            description={t('harness.acceptModal.expiresHint')}
                            required
                        >
                            <DatePicker
                                id="harness-accept-expires"
                                value={expires}
                                onChange={setExpires}
                                fromDate={fromDate}
                                toDate={toDate}
                                disabled={busy}
                            />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
                        {tCommon('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        disabled={!canSubmit}
                        data-testid="harness-accept-submit"
                    >
                        {busy
                            ? t('harness.acceptModal.saving')
                            : target.renewing
                                ? t('harness.acceptModal.submitRenew')
                                : t('harness.acceptModal.submit')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
