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
 * says nothing was sent and why. Each points at the page where the request
 * now waits (#4895), rather than quoting its id.
 *
 * ── IT SPEAKS IN WORDS ─────────────────────────────────────────────────────
 *
 * A field is labelled by its name in words and hinted by its bound in words
 * (#4895): a choice for an `enum`, a range for an `integer`, a length for a
 * `length`. Two open targets are told apart by their field names. The tool is
 * named by its own name and its connection's, never the qualified key.
 */
import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/inline-notice';
import { apiErrorMessage } from '@/lib/api-error';

import { AgentsViewsMenu, type AgentsViewsMenuProps } from '../AgentsViewsMenu';

interface Template {
    id: string;
    label: string;
    /** The tool's own name on its server. */
    toolName: string;
    connectionName: string | null;
}

/** Mirrors `ComposeFieldOffer` on the wire. */
interface WireField {
    name: string;
    kind: string;
    candidates?: Array<{ value: string; label: string }>;
    unavailable?: string;
    allowed?: string[];
    min?: number;
    max?: number;
}

/**
 * A field name in words: `targetUserId` and `target_user_id` both read
 * "Target user id". The name is the tool's own, so it cannot be translated;
 * this only stops it reading as code.
 */
export function fieldNameInWords(name: string): string {
    const words = name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_\-.]+/g, ' ')
        .trim()
        .toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : name;
}

type Notice =
    | { kind: 'queued' }
    | { kind: 'quarantined' }
    | { kind: 'failed'; reason: string }
    | { kind: 'loadFailed'; reason: string };

export function ComposeClient({
    templates,
    notComposable = 0,
    canWrite,
    canManageTemplates = false,
    needsSecondApprover = true,
    menu,
}: {
    templates: Template[];
    /** Saved parameter sets left out because they open no field (#4895). */
    notComposable?: number;
    canWrite: boolean;
    /** `admin.agent_registry`, the Saved parameters page's gate. */
    canManageTemplates?: boolean;
    /** The Owner's switch (#4905): whether the composer may approve their own request. */
    needsSecondApprover?: boolean;
    /** The views menu, rendered in the page header (#4895). */
    menu?: Omit<AgentsViewsMenuProps, 'current'>;
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();

    const [templateId, setTemplateId] = useState<string | null>(null);
    const [fields, setFields] = useState<WireField[] | null>(null);
    const [values, setValues] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [notice, setNotice] = useState<Notice | null>(null);
    /** #3351 — the typed entrance, which composes WITHOUT touching the form. */
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
                const body: unknown = await res.json().catch(() => null);
                const fields = (body as { fields?: WireField[] } | null)?.fields;
                // A LATER selection has already won; this answer is about a
                // template the operator has moved on from.
                if (seq !== selectionRef.current) return;
                if (!res.ok) {
                    // The server's sentence when it gave one; never a bare
                    // status code (#4895).
                    setNotice({ kind: 'loadFailed', reason: apiErrorMessage(body, t('compose.tryAgain')) });
                    return;
                }
                setFields(fields ?? []);
            } catch {
                if (seq === selectionRef.current) {
                    setNotice({ kind: 'loadFailed', reason: t('compose.networkFailed') });
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
            const body: unknown = await res.json().catch(() => null);
            const outcome = body as { proposalId?: string; status?: string } | null;
            if (!res.ok) {
                setNotice({ kind: 'failed', reason: apiErrorMessage(body, t('compose.tryAgain')) });
                return;
            }
            // QUARANTINED is not PENDING. Saying "awaiting approval" for a
            // proposal that never enters the queue would describe a wait that
            // nobody is going to end.
            setNotice({ kind: outcome?.status === 'QUARANTINED' ? 'quarantined' : 'queued' });
        } catch {
            setNotice({ kind: 'failed', reason: t('compose.networkFailed') });
        } finally {
            setSubmitting(false);
        }
    }, [apiUrl, templateId, values, t]);


    const chosen = templates.find((x) => x.id === templateId) ?? null;
    // Every open field needs a value, and a field whose candidates could not be
    // resolved blocks submission — offering a disabled picker beside an enabled
    // button would invite a request the server is certain to refuse.
    const ready =
        fields !== null
        && fields.length > 0
        && fields.every((f) => !f.unavailable && (values[f.name] ?? '') !== '');

    // The quarantine page's own gate, so the outcome links there only for a
    // viewer it would admit.
    const canOpenQuarantine = menu ? (menu.oversightReads?.quarantine ?? menu.canInvestigate) : false;

    // Two open targets would otherwise be two fields labelled "Subject".
    const targetCount = fields?.filter((f) => f.kind === 'target').length ?? 0;

    const hintFor = (f: WireField): string => {
        if (f.kind === 'integer' && f.min !== undefined && f.max !== undefined) {
            return t('compose.hint.integer', { min: f.min, max: f.max });
        }
        if (f.kind === 'length' && f.min !== undefined && f.max !== undefined) {
            return t('compose.hint.length', { min: f.min, max: f.max });
        }
        if (f.kind === 'regex') return t('compose.hint.regex');
        if (f.kind === 'enum') return t('compose.hint.enum');
        return t('compose.hint.other');
    };

    return (
        <div className="space-y-section">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('compose.crumbAgents'), href: tenantHref('/agents') },
                    { label: t('compose.title') },
                ]}
                title={t('compose.title')}
                description={needsSecondApprover ? t('compose.intro') : t('compose.introSelfApproval')}
                actions={menu ? <AgentsViewsMenu {...menu} current="compose" /> : undefined}
            />

            {!canWrite ? (
                <InlineNotice variant="info">{t('compose.readOnly')}</InlineNotice>
            ) : null}

            {notComposable > 0 && templates.length > 0 ? (
                <p className="text-sm text-content-muted" data-testid="compose-not-composable">
                    {t('compose.notComposable', { count: notComposable })}
                </p>
            ) : null}

            {templates.length === 0 ? (
                <EmptyState
                    title={t('compose.noTemplatesTitle')}
                    description={
                        notComposable > 0
                            ? t('compose.noTemplatesNoOpenFieldsDesc', { count: notComposable })
                            : canManageTemplates
                              ? t('compose.noTemplatesManagerDesc')
                              : t('compose.noTemplatesDesc')
                    }
                    primaryAction={
                        canManageTemplates
                            ? {
                                  label: t('compose.openParameterSets'),
                                  href: tenantHref('/agents/parameter-sets'),
                                  'data-testid': 'compose-open-parameter-sets',
                              }
                            : undefined
                    }
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
                        <p className="text-content-muted" data-testid="compose-tool-line">
                            {chosen.connectionName
                                ? t('compose.toolLineVia', { tool: chosen.toolName, connection: chosen.connectionName })
                                : t('compose.toolLine', { tool: chosen.toolName })}
                        </p>
                    ) : null}

                    {fields?.map((f) =>
                        f.unavailable ? (
                            <InlineNotice key={f.name} variant="warning">
                                {f.unavailable}
                            </InlineNotice>
                        ) : f.candidates ? (
                            <FormField
                                key={f.name}
                                label={
                                    targetCount > 1
                                        ? t('compose.subjectLabelNamed', { field: fieldNameInWords(f.name) })
                                        : t('compose.subjectLabel')
                                }
                            >
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
                        ) : f.kind === 'enum' && f.allowed && f.allowed.length > 0 ? (
                            <FormField key={f.name} label={fieldNameInWords(f.name)} description={hintFor(f)}>
                                <Combobox
                                    options={f.allowed.map((v) => ({ value: v, label: v }))}
                                    selected={values[f.name] ? { value: values[f.name], label: values[f.name] } : null}
                                    onSelect={(o) => setValues((p) => ({ ...p, [f.name]: o.value }))}
                                    placeholder={t('compose.choosePlaceholder')}
                                />
                            </FormField>
                        ) : (
                            <FormField key={f.name} label={fieldNameInWords(f.name)} description={hintFor(f)}>
                                <Input
                                    value={values[f.name] ?? ''}
                                    inputMode={f.kind === 'integer' ? 'numeric' : undefined}
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
                        <InlineNotice
                            variant={notice.kind === 'queued' ? 'success' : 'warning'}
                            data-testid="compose-notice"
                        >
                            {notice.kind === 'queued' ? (
                                <>
                                    {t('compose.queued')}{' '}
                                    <Link
                                        href={tenantHref('/agents/proposals')}
                                        className="text-content-info hover:underline"
                                        data-testid="compose-open-proposals"
                                    >
                                        {t('compose.openProposals')}
                                    </Link>
                                </>
                            ) : notice.kind === 'quarantined' ? (
                                <>
                                    {t('compose.quarantined')}{' '}
                                    {canOpenQuarantine ? (
                                        <Link
                                            href={tenantHref('/agents/quarantine')}
                                            className="text-content-info hover:underline"
                                            data-testid="compose-open-quarantine"
                                        >
                                            {t('compose.openQuarantine')}
                                        </Link>
                                    ) : null}
                                </>
                            ) : notice.kind === 'failed' ? (
                                t('compose.failed', { reason: notice.reason })
                            ) : (
                                t('compose.loadFailed', { reason: notice.reason })
                            )}
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
