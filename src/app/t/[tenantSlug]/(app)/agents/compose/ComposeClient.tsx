'use client';

/**
 * The compose form (#3301).
 *
 * ── IT CAN FILL, AND IT CANNOT WIDEN ───────────────────────────────────────
 *
 * The only thing this component sends is `{ parameterSetId, openFieldValues }`.
 * There is no input bound to an approved parameter, and the offer it renders
 * carries none — so there is no interaction that edits the template. The server
 * refuses a key the template does not open regardless, which is the control;
 * this is the surface agreeing with it rather than relying on it.
 *
 * ── THE SUBJECT IS A CHOICE, NOT A TEXT BOX ────────────────────────────────
 *
 * A target field renders as a picker over candidates the server resolved from
 * the approved population, labelled where the population knows how. The VALUE
 * submitted is the identifier the bound checks, never the label — so a label
 * that is missing or wrong costs legibility and never correctness.
 *
 * ── AND IT NEVER CLAIMS A CHANGE WAS MADE ──────────────────────────────────
 *
 * Three outcomes, three sentences. A queued proposal says nothing was sent; a
 * quarantined one says it will NOT be reviewed, because reporting that as
 * "awaiting approval" would describe a wait nobody is going to end; a refusal
 * says nothing was sent and why.
 */
import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Textarea } from '@/components/ui/textarea';
import { Heading } from '@/components/ui/typography';

interface Template {
    id: string;
    label: string;
    toolName: string;
}

/** Mirrors `ComposeFieldOffer` on the wire. */
interface WireField {
    name: string;
    kind: string;
    candidates?: Array<{ value: string; label: string }>;
    unavailable?: string;
}

export function ComposeClient({
    templates,
    canWrite,
}: {
    templates: Template[];
    canWrite: boolean;
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();

    const [templateId, setTemplateId] = useState<string | null>(null);
    const [fields, setFields] = useState<WireField[] | null>(null);
    const [values, setValues] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
    /** #3351 — the typed entrance, which composes WITHOUT touching the form. */
    const [phrase, setPhrase] = useState('');
    const [resolving, setResolving] = useState(false);
    /** What the parser made of the phrase, shown verbatim as it was recorded. */
    const [readings, setReadings] = useState<readonly string[] | null>(null);
    /** Which selection is current, so a slow earlier response cannot win. */
    const selectionRef = useRef(0);

    // Fetched PER SELECTION, never cached across one. A target field's
    // candidates come from live data, and a list kept from an earlier selection
    // would be a stale bound the operator trusts.
    /**
     * Choosing a template FETCHES its fields, in the handler rather than an
     * effect.
     *
     * The fetch is caused by a user action, not by state needing to be kept in
     * sync with something — which is React's own test for whether an effect is
     * the right tool, and why `react-hooks/set-state-in-effect` flagged the
     * earlier shape. No effect means no cascading render and no stale-cleanup
     * dance.
     *
     * A per-call sequence number stands in for the `alive` flag an effect's
     * cleanup gave us: a slow response for an earlier template must not
     * overwrite a later one's fields.
     */
    const chooseTemplate = useCallback(
        async (id: string | null) => {
            const seq = ++selectionRef.current;
            setTemplateId(id);
            setFields(null);
            setValues({});
            setNotice(null);
            if (!id) return;
            setLoading(true);
            try {
                const res = await fetch(
                    apiUrl(`/agent-proposals/compose?parameterSetId=${encodeURIComponent(id)}`),
                );
                const body = (await res.json().catch(() => null)) as
                    | { fields?: WireField[]; error?: string }
                    | null;
                // A LATER selection has already won; this answer is about a
                // template the operator has moved on from.
                if (seq !== selectionRef.current) return;
                if (!res.ok) {
                    setNotice({
                        ok: false,
                        text: t('compose.loadFailed', { reason: body?.error ?? String(res.status) }),
                    });
                    return;
                }
                setFields(body?.fields ?? []);
            } catch {
                if (seq === selectionRef.current) {
                    setNotice({ ok: false, text: t('compose.loadFailed', { reason: '—' }) });
                }
            } finally {
                if (seq === selectionRef.current) setLoading(false);
            }
        },
        [apiUrl, t],
    );

    const submit = useCallback(async () => {
        if (!templateId) return;
        setSubmitting(true);
        setNotice(null);
        try {
            const res = await fetch(apiUrl('/agent-proposals/compose'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ parameterSetId: templateId, openFieldValues: values }),
            });
            const body = (await res.json().catch(() => null)) as
                | { proposalId?: string; status?: string; guardVerdict?: string | null; error?: string }
                | null;
            if (!res.ok) {
                setNotice({
                    ok: false,
                    text: t('compose.failed', { reason: body?.error ?? String(res.status) }),
                });
                return;
            }
            // QUARANTINED is not PENDING. Saying "awaiting approval" for a
            // proposal that never enters the queue would describe a wait that
            // nobody is going to end.
            setNotice(
                body?.status === 'QUARANTINED'
                    ? {
                          ok: false,
                          text: t('compose.quarantined', {
                              verdict: body?.guardVerdict ?? '—',
                              id: body?.proposalId ?? '—',
                          }),
                      }
                    : { ok: true, text: t('compose.queued', { id: body?.proposalId ?? '—' }) },
            );
        } catch {
            setNotice({ ok: false, text: t('compose.failed', { reason: '—' }) });
        } finally {
            setSubmitting(false);
        }
    }, [apiUrl, templateId, values, t]);

    // The typed path. It does NOT fill the form in: it composes directly and
    // reports what was understood, so the operator sees the parse and the
    // reviewer sees the same lines on the proposal. A phrase that cannot be
    // resolved is refused with a sentence, never approximated.
    const composeFromText = useCallback(async () => {
        const typed = phrase.trim();
        if (typed === '') return;
        setResolving(true);
        setNotice(null);
        setReadings(null);
        try {
            const res = await fetch(apiUrl('/agent-proposals/compose/intent'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ phrase: typed }),
            });
            const body = (await res.json().catch(() => null)) as
                | {
                      proposalId?: string;
                      status?: string;
                      guardVerdict?: string | null;
                      readings?: string[];
                      error?: string;
                  }
                | null;
            if (!res.ok) {
                // The server's sentence, not a generic failure: each refusal
                // names the one action that fixes it.
                setNotice({
                    ok: false,
                    text: t('compose.phraseUnavailable', {
                        reason: body?.error ?? String(res.status),
                    }),
                });
                return;
            }
            setReadings(body?.readings ?? null);
            setNotice(
                body?.status === 'QUARANTINED'
                    ? {
                          ok: false,
                          text: t('compose.quarantined', {
                              verdict: body?.guardVerdict ?? '—',
                              id: body?.proposalId ?? '—',
                          }),
                      }
                    : { ok: true, text: t('compose.queued', { id: body?.proposalId ?? '—' }) },
            );
        } catch {
            setNotice({ ok: false, text: t('compose.phraseUnavailable', { reason: '—' }) });
        } finally {
            setResolving(false);
        }
    }, [apiUrl, phrase, t]);

    const chosen = templates.find((x) => x.id === templateId) ?? null;
    // Every open field needs a value, and a field whose candidates could not be
    // resolved blocks submission — offering a disabled picker beside an enabled
    // button would invite a request the server is certain to refuse.
    const ready =
        fields !== null
        && fields.length > 0
        && fields.every((f) => !f.unavailable && (values[f.name] ?? '') !== '');

    return (
        <div className="space-y-section">
            <PageHeader
                back={{ smart: true }}
                title={t('compose.title')}
                description={t('compose.intro')}
            />

            {!canWrite ? (
                <InlineNotice variant="info">{t('compose.readOnly')}</InlineNotice>
            ) : null}

            {canWrite && templates.length > 0 ? (
                <Card className="space-y-default">
                    <div className="space-y-1">
                        <Heading level={2}>{t('compose.phraseTitle')}</Heading>
                        <p className="text-sm text-content-muted">{t('compose.phraseIntro')}</p>
                    </div>

                    <FormField label={t('compose.phraseLabel')} hint={t('compose.phraseHint')}>
                        <Textarea
                            value={phrase}
                            onChange={(e) => setPhrase(e.target.value)}
                            placeholder={t('compose.phrasePlaceholder')}
                            rows={3}
                            maxLength={500}
                            disabled={resolving}
                        />
                    </FormField>

                    {readings !== null && readings.length > 0 ? (
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-content-default">
                                {t('compose.readingsTitle')}
                            </p>
                            <ul className="list-disc space-y-0.5 pl-5 text-sm text-content-muted">
                                {readings.map((line) => (
                                    <li key={line}>{line}</li>
                                ))}
                            </ul>
                        </div>
                    ) : null}

                    <Button
                        variant="secondary"
                        onClick={composeFromText}
                        disabled={resolving || phrase.trim() === ''}
                    >
                        {resolving ? t('compose.phraseSubmitting') : t('compose.phraseSubmit')}
                    </Button>
                </Card>
            ) : null}

            {canWrite && templates.length > 0 ? (
                <p className="text-sm text-content-muted">{t('compose.phraseOrForm')}</p>
            ) : null}

            {templates.length === 0 ? (
                <EmptyState
                    title={t('compose.noTemplatesTitle')}
                    description={t('compose.noTemplatesDesc')}
                />
            ) : (
                <Card className="space-y-default">
                    <FormField label={t('compose.templateLabel')}>
                        <Combobox
                            options={templates.map((x) => ({ value: x.id, label: x.label }))}
                            selected={chosen ? { value: chosen.id, label: chosen.label } : null}
                            onSelect={(o) => void chooseTemplate(o.value || null)}
                            placeholder={t('compose.templatePlaceholder')}
                        />
                    </FormField>

                    {chosen ? (
                        <p className="text-content-muted">
                            {t('compose.toolLine', { tool: chosen.toolName })}
                        </p>
                    ) : null}

                    {fields?.map((f) =>
                        f.unavailable ? (
                            <InlineNotice key={f.name} variant="warning">
                                {f.unavailable}
                            </InlineNotice>
                        ) : f.candidates ? (
                            <FormField key={f.name} label={t('compose.subjectLabel')}>
                                <Combobox
                                    options={f.candidates}
                                    selected={
                                        values[f.name]
                                            ? {
                                                  value: values[f.name],
                                                  label:
                                                      f.candidates.find(
                                                          (c) => c.value === values[f.name],
                                                      )?.label ?? values[f.name],
                                              }
                                            : null
                                    }
                                    onSelect={(o) =>
                                        setValues((p) => ({ ...p, [f.name]: o.value }))
                                    }
                                    placeholder={t('compose.subjectPlaceholder')}
                                />
                            </FormField>
                        ) : (
                            <FormField
                                key={f.name}
                                label={t('compose.fieldLabel', { field: f.name })}
                                hint={t('compose.fieldHint', { kind: f.kind })}
                            >
                                <Input
                                    value={values[f.name] ?? ''}
                                    onChange={(e) =>
                                        setValues((p) => ({ ...p, [f.name]: e.target.value }))
                                    }
                                />
                            </FormField>
                        ),
                    )}

                    {fields !== null && fields.length > 0 ? (
                        <p className="text-content-muted">{t('compose.approvedNote')}</p>
                    ) : null}

                    {notice ? (
                        <InlineNotice variant={notice.ok ? 'success' : 'warning'}>
                            {notice.text}
                        </InlineNotice>
                    ) : null}

                    <Button
                        variant="primary"
                        onClick={submit}
                        disabled={!canWrite || !ready || submitting || loading}
                    >
                        {submitting ? t('compose.submitting') : t('compose.submit')}
                    </Button>
                </Card>
            )}
        </div>
    );
}
