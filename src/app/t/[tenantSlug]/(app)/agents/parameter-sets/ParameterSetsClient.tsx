'use client';

/**
 * SAVED PARAMETERS for an external tool — the whole operation set (#3124).
 *
 * ## Why this page exists
 *
 * `ExternalToolParameterSet` shipped with four HTTP verbs, five usecases and a
 * database trigger enforcing four eyes, and nothing in the product called any of
 * it. The route landed in #2906 and had no caller since, so creating a baseline,
 * proposing an edit, signing one and approving one were all reachable only by a
 * hand-written request from somebody holding a session and the permission key.
 *
 * That is the third time the same shape shipped in this subsystem — the external
 * tool APPROVAL api (#2921), the external-write LADDER route (#2861) and now
 * this — which is why the surface lands as the whole operation set rather than
 * "a sign button". Signing is the last step of a flow whose earlier steps were
 * equally absent, and an approve control on a list nobody can populate is a
 * screen that lies about what it can do.
 *
 * ## What these rows decide, and what the surface therefore owes
 *
 * A set is the SUBSTANCE of what an agent does at the far end: with one in force
 * the tool advertises a single argument — the label — and the values come from
 * the row. So two facts have to be on screen rather than inferable:
 *
 * 1. **A BASELINE IS TRUST-ON-FIRST-USE.** `saveParameterSet` creates the first
 *    version with no approver and nothing to compare against, deliberately. It
 *    is the one operation with no reviewed moment, and it REFUSES open fields
 *    and a target population for exactly that reason. The refusal is the
 *    interesting part of that endpoint's contract, so the form says so before it
 *    is hit and renders the server's sentence when it is.
 *
 * 2. **A SIGNATURE IS AGAINST A DIGEST, NOT AGAINST A ROW.** The signature row
 *    stores the hash it was taken on, and the promotion counts only signatures
 *    naming what is pending NOW. A count shown without the digest it is against
 *    would read as "one of one, go ahead" on content the signer never saw —
 *    which is the exact failure `expectedPendingHash` exists to prevent, one
 *    layer up. So every signature carries its hash, and the approve control
 *    names the digest it is approving.
 *
 * ## Every refusal on this page is the SERVER's sentence
 *
 * The four-eyes refusals are raised by a DATABASE trigger and mapped to operator
 * prose by `fourEyesRefusal` inside the usecase, which rethrows anything it does
 * not recognise. So there is nothing to re-map here and nothing to re-word: the
 * client reads `error.message` and renders it. A second copy of those nine
 * sentences in the browser would be a second place for them to drift, and the
 * one that mattered would be the stale one.
 *
 * The ONE thing judged locally is whether the JSON in a textarea parses, because
 * a body has to be an object before it can be sent at all.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

// Both leaf modules with no server imports, so a client may hold them —
// `ExternalWriteLadderClient` records the same reasoning for the ladder's
// constants. The TYPE import is erased entirely.
import { parseExternalToolName } from '@/lib/mcp/external-tool-name';
import type { ValueConstraintKind } from '@/lib/integrations/parameter-constraints';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { CopyText } from '@/components/ui/copy-text';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@inflect/ui/lib/cn';
import { formatDate } from '@/lib/format-date';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

/** One signature as `listParameterSets` reports it, over the wire. */
interface SignatureWire {
    approverUserId: string;
    revision: number;
    pendingHash: string;
    requiredApprovals: number;
    createdAt: string;
}

/** One set as `listParameterSets` reports it — the server's shape, not a re-model. */
interface ParameterSetWire {
    id: string;
    toolName: string;
    label: string;
    parameters: unknown;
    parametersHash: string;
    openFields: unknown;
    targetPopulation: string | null;
    revision: number;
    approvalSource: string;
    approvedByUserId: string | null;
    approvedAt: string;
    pending: {
        parameters: unknown;
        openFields: unknown;
        targetPopulation: string | null;
        hash: string;
        byUserId: string;
        at: string;
        requiredApprovals: number;
    } | null;
    signatures: SignatureWire[];
}

export interface ConnectionRow {
    id: string;
    name: string;
}

/** One target population, as the SERVER's registry defines it. */
export interface TargetPopulationOption {
    key: string;
    description: string;
    bound: string;
}

/**
 * `approvalSource` → badge tone.
 *
 * `BASELINE` is `warning` rather than `neutral`, and that is the point of the
 * badge: a baseline carries no approver and nothing it displaced, so it is the
 * one row on the page whose content nobody reviewed. Rendering it in the same
 * grey as everything else would hide the single fact an operator most needs
 * about it. An unrecognised source falls to neutral — a value this build does
 * not know is not a pass.
 */
const SOURCE_VARIANT: Record<string, StatusBadgeVariant> = {
    BASELINE: 'warning',
    APPROVED: 'success',
};

/**
 * The constraint kinds this page can render, as a TOTAL map over the vocabulary.
 *
 * `Record<ValueConstraintKind | 'target', …>` rather than a hand-written array:
 * a fifth `ValueConstraint` kind added to `parameter-constraints.ts` makes this
 * object fail `tsc` until somebody writes the sentence for it. An array of
 * strings would have gone stale silently and rendered the new kind as
 * "unreadable" — a surface that mirrors a runtime BY NAME stops tracking it the
 * moment the runtime moves.
 */
const KNOWN_KINDS: Record<ValueConstraintKind | 'target', true> = {
    regex: true,
    enum: true,
    integer: true,
    length: true,
    target: true,
};

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, unknown> {
    return isRecord(v) ? v : {};
}

/** Stable text for one JSON value, used for display AND for comparison. */
function show(v: unknown): string {
    return JSON.stringify(v ?? null);
}

type FieldState = 'added' | 'removed' | 'changed' | 'same';

interface DiffRow {
    key: string;
    before: string | null;
    after: string | null;
    state: FieldState;
}

/**
 * The key-level diff between what is in force and what is proposed.
 *
 * Over the UNION of keys, sorted, so a removed argument is as visible as an
 * added one — a diff that iterated only the proposal would render a deletion as
 * nothing at all, which is the change an approver is least likely to notice and
 * the one most likely to re-point a live agent.
 */
function diffRows(before: unknown, after: unknown): DiffRow[] {
    const b = asRecord(before);
    const a = asRecord(after);
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
    return keys.map((key) => {
        const inB = Object.hasOwn(b, key);
        const inA = Object.hasOwn(a, key);
        const bt = inB ? show(b[key]) : null;
        const at = inA ? show(a[key]) : null;
        const state: FieldState = !inB ? 'added' : !inA ? 'removed' : bt === at ? 'same' : 'changed';
        return { key, before: bt, after: at, state };
    });
}

/** The entries of an `openFields` blob that are legible as a constraint. */
function openFieldEntries(openFields: unknown): Array<[string, Record<string, unknown>]> {
    if (!isRecord(openFields)) return [];
    return Object.entries(openFields).flatMap(([name, entry]) =>
        isRecord(entry) && typeof entry.kind === 'string' ? [[name, entry] as [string, Record<string, unknown>]] : [],
    );
}

/** A digest, short enough to compare by eye. The full value sits in `title`. */
function shortHash(hash: string): string {
    return hash.slice(0, 12);
}

export function ParameterSetsClient({
    connections,
    targetPopulations,
    initialConnectionId,
}: {
    connections: readonly ConnectionRow[];
    targetPopulations: readonly TargetPopulationOption[];
    /** The connection the operator arrived with, from `?connectionId=`. */
    initialConnectionId: string | null;
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();

    const [connectionId, setConnectionId] = useState<string>(
        (initialConnectionId && connections.some((c) => c.id === initialConnectionId)
            ? initialConnectionId
            : connections[0]?.id) ?? '',
    );

    const [sets, setSets] = useState<ParameterSetWire[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    /**
     * The tools this connection advertises, for the baseline form's picker.
     *
     * Read from the CATALOGUE rather than typed by hand: `saveParameterSet` keys
     * on the qualified `mcp__<connectionId>__<tool>` name, and a name with a
     * typo in it creates a set that matches nothing and refuses nothing — it
     * simply never applies, which reads to an operator as the feature not
     * working.
     */
    const [tools, setTools] = useState<Array<{ toolName: string; advertisedName: string }> | null>(
        null,
    );
    const [catalogueError, setCatalogueError] = useState<string | null>(null);

    const [newToolName, setNewToolName] = useState('');
    const [newLabel, setNewLabel] = useState('');
    const [newParameters, setNewParameters] = useState('{}');
    const [createError, setCreateError] = useState<string | null>(null);

    const [proposingId, setProposingId] = useState<string | null>(null);
    const [proposeParameters, setProposeParameters] = useState('{}');
    const [proposeOpenFields, setProposeOpenFields] = useState('');
    const [proposeTarget, setProposeTarget] = useState('');

    const [busy, setBusy] = useState<string | null>(null);
    /** The server's sentence for the last act on one set, keyed by set id. */
    const [actionError, setActionError] = useState<Record<string, string>>({});

    const listPath = '/admin/agents/parameter-sets';

    /** The server's own sentence when it gave one; the fallback otherwise. */
    const serverMessage = useCallback(async (res: Response, fallback: string): Promise<string> => {
        const body = (await res.json().catch(() => null)) as
            | { error?: { message?: string } | string }
            | null;
        if (typeof body?.error === 'string') return body.error;
        return body?.error?.message ?? fallback;
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        setSets(null);
        try {
            const res = await fetch(apiUrl(listPath));
            if (!res.ok) {
                setLoadError(await serverMessage(res, t('parameterSets.loadError')));
                return;
            }
            setSets((await res.json()) as ParameterSetWire[]);
        } catch {
            setLoadError(t('parameterSets.loadError'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, listPath, serverMessage, t]);

    /**
     * The catalogue, in its OWN request and with its own error.
     *
     * A failure here deliberately does not blank the list: the saved sets are
     * this page's subject and they come from our own database, while the
     * catalogue reaches a third party that can be slow, unreachable or
     * mid-rotation. Collapsing the two would make somebody else's outage look
     * like "this tenant has no saved parameters".
     */
    const loadCatalogue = useCallback(async () => {
        if (!connectionId) return;
        setCatalogueError(null);
        setTools(null);
        try {
            const res = await fetch(
                apiUrl(`/admin/agents/external-tools?connectionId=${encodeURIComponent(connectionId)}`),
            );
            if (!res.ok) {
                setCatalogueError(await serverMessage(res, t('parameterSets.catalogueError')));
                return;
            }
            const body = (await res.json()) as {
                tools?: Array<{ toolName: string; advertisedName: string }>;
            };
            setTools(body.tools ?? []);
        } catch {
            setCatalogueError(t('parameterSets.catalogueError'));
        }
    }, [apiUrl, connectionId, serverMessage, t]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        void loadCatalogue();
    }, [loadCatalogue]);

    /**
     * The sets belonging to the selected connection.
     *
     * Filtered HERE rather than through the route's `toolName` parameter, which
     * takes one exact qualified name: the connection is a PREFIX of that name,
     * so one read serves every tool on the server and the page does not fire a
     * request per tool.
     */
    const visible = useMemo(() => {
        if (sets === null) return null;
        if (!connectionId) return sets;
        return sets.filter((s) => parseExternalToolName(s.toolName)?.connectionId === connectionId);
    }, [sets, connectionId]);

    const noteError = (id: string, message: string) =>
        setActionError((prev) => ({ ...prev, [id]: message }));

    const clearError = (id: string) =>
        setActionError((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
        });

    const createBaseline = async () => {
        setCreateError(null);
        let parameters: unknown;
        try {
            parameters = JSON.parse(newParameters);
        } catch {
            setCreateError(t('parameterSets.invalidJson'));
            return;
        }
        if (!isRecord(parameters)) {
            setCreateError(t('parameterSets.notAnObject'));
            return;
        }
        setBusy('create');
        try {
            const res = await fetch(apiUrl(listPath), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ toolName: newToolName, label: newLabel, parameters }),
            });
            if (!res.ok) {
                setCreateError(await serverMessage(res, t('parameterSets.createError')));
                return;
            }
            setNewLabel('');
            setNewParameters('{}');
            await load();
        } catch {
            setCreateError(t('parameterSets.createError'));
        } finally {
            setBusy(null);
        }
    };

    const openPropose = (set: ParameterSetWire) => {
        clearError(set.id);
        setProposingId(set.id);
        // Prefilled with what is IN FORCE, so an edit starts from the reviewed
        // state. The three fields are the WHOLE intended state after the edit —
        // never a delta — which is what `proposeParameterChange` documents its
        // `openFields` and `targetPopulation` keys to mean.
        setProposeParameters(JSON.stringify(asRecord(set.parameters), null, 2));
        setProposeOpenFields(
            set.openFields === null || set.openFields === undefined
                ? ''
                : JSON.stringify(set.openFields, null, 2),
        );
        setProposeTarget(set.targetPopulation ?? '');
    };

    const submitPropose = async (set: ParameterSetWire) => {
        clearError(set.id);
        let parameters: unknown;
        try {
            parameters = JSON.parse(proposeParameters);
        } catch {
            noteError(set.id, t('parameterSets.invalidJson'));
            return;
        }
        if (!isRecord(parameters)) {
            noteError(set.id, t('parameterSets.notAnObject'));
            return;
        }
        // An EMPTY textarea is an explicit `null` — "and zero open fields
        // afterwards" — not an omitted key. The two differ in the usecase
        // (omitted carries the row's bounds forward), and this form always
        // submits the whole intended state, so it must say which it means.
        let openFields: unknown = null;
        if (proposeOpenFields.trim() !== '') {
            try {
                openFields = JSON.parse(proposeOpenFields);
            } catch {
                noteError(set.id, t('parameterSets.invalidOpenFieldsJson'));
                return;
            }
        }
        setBusy(set.id);
        try {
            const res = await fetch(apiUrl(listPath), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: set.id,
                    parameters,
                    openFields,
                    targetPopulation: proposeTarget === '' ? null : proposeTarget,
                }),
            });
            if (!res.ok) {
                noteError(set.id, await serverMessage(res, t('parameterSets.proposeError')));
                return;
            }
            setProposingId(null);
            await load();
        } catch {
            noteError(set.id, t('parameterSets.proposeError'));
        } finally {
            setBusy(null);
        }
    };

    /**
     * Sign, or approve, carrying the digest the operator is looking at.
     *
     * `expectedPendingHash` comes from the read that produced the text on
     * screen, for the reason the usecase states: an endpoint taking only an id
     * would act on WHATEVER the row says when the request lands, including an
     * edit that changed between the reading and the click.
     */
    const act = async (set: ParameterSetWire, kind: 'sign' | 'approve') => {
        if (!set.pending) return;
        clearError(set.id);
        setBusy(set.id);
        try {
            const res = await fetch(
                apiUrl(kind === 'sign' ? `${listPath}/signatures` : listPath),
                {
                    method: kind === 'sign' ? 'POST' : 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: set.id, expectedPendingHash: set.pending.hash }),
                },
            );
            if (!res.ok) {
                noteError(
                    set.id,
                    await serverMessage(
                        res,
                        kind === 'sign'
                            ? t('parameterSets.signError')
                            : t('parameterSets.approveError'),
                    ),
                );
                return;
            }
            await load();
        } catch {
            noteError(
                set.id,
                kind === 'sign' ? t('parameterSets.signError') : t('parameterSets.approveError'),
            );
        } finally {
            setBusy(null);
        }
    };

    /** One open field, as the constraint KIND plus the bound it carries. */
    const constraintSentence = (entry: Record<string, unknown>): string => {
        const kind = String(entry.kind);
        if (!Object.hasOwn(KNOWN_KINDS, kind)) return t('parameterSets.constraint.unknown');
        if (kind === 'target') return t('parameterSets.constraint.target');
        if (kind === 'regex') {
            return t('parameterSets.constraint.regex', { pattern: String(entry.pattern ?? '') });
        }
        if (kind === 'enum') {
            const values = Array.isArray(entry.values) ? entry.values : [];
            return t('parameterSets.constraint.enum', { values: values.map(String).join(', ') });
        }
        const min = String(entry.min ?? '');
        const max = String(entry.max ?? '');
        return kind === 'integer'
            ? t('parameterSets.constraint.integer', { min, max })
            : t('parameterSets.constraint.length', { min, max });
    };

    const populationDescription = (key: string | null): string | null => {
        if (!key) return null;
        return targetPopulations.find((p) => p.key === key)?.description ?? null;
    };

    const openFieldsBlock = (openFields: unknown, testId: string) => {
        const entries = openFieldEntries(openFields);
        if (entries.length === 0) {
            // TITLE and CONSEQUENCE as two lines, not one sentence. The locked
            // empty-state voice (`empty-state-tone`) is a declarative phrase
            // with no tail, and the tail here is the half that matters — that
            // exact values mean the agent chooses nothing — so it moves into
            // its own `…Desc` key rather than being dropped to satisfy the
            // ratchet.
            return (
                <div className="space-y-tight" data-testid={`${testId}-none`}>
                    <p className="text-xs text-content-subtle">
                        {t('parameterSets.noOpenFields')}
                    </p>
                    <p className="text-xs text-content-subtle">
                        {t('parameterSets.noOpenFieldsDesc')}
                    </p>
                </div>
            );
        }
        return (
            <ul className="space-y-tight" data-testid={testId}>
                {entries.map(([name, entry]) => (
                    <li key={name} className="flex flex-wrap items-baseline gap-tight text-xs">
                        <code className="text-content-emphasis">{name}</code>
                        <span className="rounded bg-bg-subtle px-1 text-content-muted">
                            {String(entry.kind)}
                        </span>
                        <span className="break-words text-content-muted">
                            {constraintSentence(entry)}
                        </span>
                    </li>
                ))}
            </ul>
        );
    };

    const targetBlock = (key: string | null) => (
        <p className="text-xs text-content-muted">
            {key === null ? (
                t('parameterSets.noTarget')
            ) : (
                <>
                    <code className="text-content-emphasis">{key}</code>
                    {populationDescription(key) ? ` — ${populationDescription(key)}` : ''}
                </>
            )}
        </p>
    );

    /**
     * A DIGEST LINE — the head on screen, the whole of it REACHABLE.
     *
     * `<CopyText>`, not a `<Tooltip>` wrapping a `<p>`. #3150 shipped the
     * latter to satisfy `no-ad-hoc-tooltip-title`, and it bought nothing: a
     * `<p>` is hoverable and NOT focusable, so Radix's focus-open never fires
     * on it and the full digest stayed exactly as reachable as the native
     * `title=` it replaced — mouse and screen reader only. A keyboard user
     * could not get at it at all.
     *
     * `CopyText` renders a real `<button>`, so three things change at once:
     * Tab reaches it (and opens the hint), Enter/Space puts the WHOLE hash on
     * the clipboard, and the full hash is the control's accessible NAME rather
     * than a description that exists only while a hover hint is open. The
     * visible text stays the 12-char head — a prefix of that name, so the
     * label a speech-input user says is the label they can see.
     *
     * This is what `docs/tooltip-and-copy-strategy.md` prescribes for the
     * shape: "Inline value that IS the display (id, code, hash, key) →
     * <CopyText value={…}>{displayed}</CopyText>". `ToolManifestPins`'s
     * manifest-digest cells are the existing precedent in this subtree.
     *
     * Worth it because the digest is load-bearing rather than decoration: a
     * signature does not carry forward to replaced content — the row stores
     * the hash it was taken against and the promotion counts only matching
     * ones — so a count read without the digest beside it is a number an
     * operator can be misled by. That is the same failure
     * `expectedPendingHash` exists to prevent one layer up, and a hint only
     * a mouse can open is not a fix for it.
     *
     * No `<Button>` is involved, which matters: `primary-secondary-ratio`'s
     * shared ceiling is FULL at 175 = measured, so a primary added anywhere
     * reddens CI. `CopyText` emits a bare `<button>` the ratchet does not
     * count, and this page still ships with no primary at all.
     */
    const digestLine = (hash: string, className: string, children: ReactNode) => (
        <CopyText
            value={hash}
            label={t('parameterSets.copyDigest', { hash })}
            successMessage={t('parameterSets.digestCopied')}
            className={className}
        >
            {children}
        </CopyText>
    );

    const toolOptions = (tools ?? []).map((x) => ({ value: x.toolName, label: x.advertisedName }));
    const connectionOptions = connections.map((c) => ({ value: c.id, label: c.name }));
    // "No target" FIRST, and as a real option rather than an empty selection —
    // see the control for why removing a target is a decision rather than a
    // blank. `value: ''` is what `submitPropose` reads as an explicit null.
    const targetOptions = [
        { value: '', label: t('parameterSets.targetNone') },
        ...targetPopulations.map((p) => ({ value: p.key, label: `${p.key} — ${p.description}` })),
    ];

    return (
        <div className="space-y-section">
            <PageHeader
                back={{ smart: true }}
                title={t('parameterSets.title')}
                description={t('parameterSets.description')}
            />

            {connections.length === 0 ? (
                <EmptyState
                    title={t('parameterSets.noConnectionsTitle')}
                    description={t('parameterSets.noConnectionsDesc')}
                />
            ) : (
                <>
                    <div className="flex flex-wrap items-end gap-default">
                        <div className="w-full sm:w-64">
                            <FormField label={t('parameterSets.connectionLabel')}>
                                <Combobox
                                    id="parameter-sets-connection"
                                    options={connectionOptions}
                                    selected={
                                        connectionOptions.find((o) => o.value === connectionId) ?? null
                                    }
                                    setSelected={(o) => o && setConnectionId(String(o.value))}
                                />
                            </FormField>
                        </div>
                        <Button variant="secondary" onClick={() => void load()} disabled={loading}>
                            {t('parameterSets.refresh')}
                        </Button>
                    </div>

                    {loadError && (
                        <InlineNotice variant="error" data-testid="parameter-sets-load-error">
                            {loadError}
                        </InlineNotice>
                    )}

                    {/* ── THE BASELINE FORM ────────────────────────────────────
                        The trust-on-first-use sentence is rendered BEFORE the
                        form rather than only as a refusal, because the refusal
                        is reached by typing bounds the endpoint will not accept
                        — and an operator who has written them has already
                        decided what they want. Saying the ordering up front is
                        the difference between a control that explains itself and
                        one that argues after the fact. */}
                    <Card className="space-y-default p-4" data-testid="parameter-set-create">
                        {/* `level={3}` is the type scale (text-sm, the panel
                            rung); `as="h2"` is the OUTLINE — PageHeader above
                            already owns the page's <h1>, so this card title is
                            the document's second level whatever size it wears.
                            The two are separate axes and the primitive keeps
                            them separable. */}
                        <Heading level={3} as="h2">
                            {t('parameterSets.createTitle')}
                        </Heading>
                        <p className="max-w-3xl text-sm text-content-muted">
                            {t('parameterSets.createIntro')}
                        </p>

                        {catalogueError && (
                            <InlineNotice variant="warning" data-testid="parameter-sets-catalogue-error">
                                {catalogueError}
                            </InlineNotice>
                        )}

                        {tools !== null && tools.length === 0 && !catalogueError && (
                            <InlineNotice variant="info">
                                {t('parameterSets.noToolsDesc')}
                            </InlineNotice>
                        )}

                        <div className="flex flex-wrap items-end gap-default">
                            <div className="w-full sm:w-72">
                                <FormField label={t('parameterSets.toolLabel')}>
                                    <Combobox
                                        id="parameter-sets-tool"
                                        options={toolOptions}
                                        selected={toolOptions.find((o) => o.value === newToolName) ?? null}
                                        setSelected={(o) => o && setNewToolName(String(o.value))}
                                    />
                                </FormField>
                            </div>
                            <div className="w-full sm:w-64">
                                <FormField label={t('parameterSets.labelLabel')}>
                                    <Input
                                        id="parameter-sets-label"
                                        value={newLabel}
                                        onChange={(e) => setNewLabel(e.target.value)}
                                    />
                                </FormField>
                            </div>
                        </div>

                        <FormField
                            label={t('parameterSets.parametersLabel')}
                            description={t('parameterSets.parametersHelp')}
                        >
                            <Textarea
                                id="parameter-sets-parameters"
                                rows={5}
                                className="font-mono text-xs"
                                value={newParameters}
                                onChange={(e) => setNewParameters(e.target.value)}
                            />
                        </FormField>

                        {createError && (
                            <InlineNotice variant="error" data-testid="parameter-set-create-error">
                                {createError}
                            </InlineNotice>
                        )}

                        <Button
                            variant="secondary"
                            type="submit"
                            disabled={busy === 'create' || !newToolName || !newLabel}
                            onClick={() => void createBaseline()}
                        >
                            {t('parameterSets.create')}
                        </Button>
                    </Card>

                    {loading && (
                        <p className="text-sm text-content-muted">{t('parameterSets.loading')}</p>
                    )}

                    {/* An empty register and a register not yet read are
                        different facts, so only a completed read renders the
                        empty state. */}
                    {!loading && visible !== null && visible.length === 0 && (
                        <EmptyState
                            title={t('parameterSets.emptyTitle')}
                            description={t('parameterSets.emptyDesc')}
                        />
                    )}

                    {!loading && visible !== null && visible.length > 0 && (
                        <ol className="space-y-default" data-testid="parameter-sets-list">
                            {visible.map((set) => {
                                const ref = parseExternalToolName(set.toolName);
                                const pending = set.pending;
                                const rows = pending ? diffRows(set.parameters, pending.parameters) : [];
                                const changed = rows.filter((r) => r.state !== 'same');
                                const error = actionError[set.id];
                                return (
                                    <li key={set.id}>
                                        <Card
                                            className="space-y-default p-4"
                                            data-testid={`parameter-set-${set.label}`}
                                        >
                                            <div className="flex flex-wrap items-center gap-tight">
                                                <StatusBadge
                                                    variant={SOURCE_VARIANT[set.approvalSource] ?? 'neutral'}
                                                >
                                                    {set.approvalSource}
                                                </StatusBadge>
                                                <span className="text-sm font-medium text-content-emphasis">
                                                    {set.label}
                                                </span>
                                                <code className="text-xs text-content-muted">
                                                    {ref?.toolName ?? set.toolName}
                                                </code>
                                                <span className="text-xs tabular-nums text-content-subtle">
                                                    {t('parameterSets.revision', { revision: set.revision })}
                                                </span>
                                            </div>

                                            {/* WHO approved it and WHEN — or, for a
                                                baseline, that nobody did. The second
                                                sentence is the one that matters: a
                                                baseline is the only row on this page
                                                with no reviewed moment behind it. */}
                                            <p className="text-xs text-content-muted">
                                                {set.approvedByUserId
                                                    ? t('parameterSets.approvedBy', {
                                                          user: set.approvedByUserId,
                                                          date: formatDate(set.approvedAt),
                                                      })
                                                    : t('parameterSets.baselineNoApprover', {
                                                          date: formatDate(set.approvedAt),
                                                      })}
                                            </p>

                                            <div className="space-y-tight">
                                                <p className="text-xs font-medium text-content-emphasis">
                                                    {t('parameterSets.inForce')}
                                                </p>
                                                <pre className="overflow-x-auto rounded bg-bg-subtle p-2 text-xs text-content-muted">
                                                    {JSON.stringify(set.parameters, null, 2)}
                                                </pre>
                                                {openFieldsBlock(
                                                    set.openFields,
                                                    `parameter-set-open-fields-${set.label}`,
                                                )}
                                                {targetBlock(set.targetPopulation)}
                                                {/* The FULL digest, which the line
                                                    itself only shows the head of —
                                                    see `digestLine` for why this is
                                                    a focusable copy control and not
                                                    a hover hint. */}
                                                {digestLine(
                                                    set.parametersHash,
                                                    'text-content-subtle',
                                                    t('parameterSets.digest', {
                                                        hash: shortHash(set.parametersHash),
                                                    }),
                                                )}
                                            </div>

                                            {error && (
                                                <InlineNotice
                                                    variant="error"
                                                    data-testid={`parameter-set-error-${set.label}`}
                                                >
                                                    {error}
                                                </InlineNotice>
                                            )}

                                            {pending && (
                                                <div
                                                    className="space-y-default rounded border border-border-subtle p-3"
                                                    data-testid={`parameter-set-pending-${set.label}`}
                                                >
                                                    <p className="text-sm font-medium text-content-emphasis">
                                                        {t('parameterSets.pendingTitle')}
                                                    </p>
                                                    <p className="text-xs text-content-muted">
                                                        {t('parameterSets.pendingBy', {
                                                            user: pending.byUserId,
                                                            date: formatDate(pending.at),
                                                        })}
                                                    </p>
                                                    <InlineNotice variant="info">
                                                        {t('parameterSets.pendingNotInForce')}
                                                    </InlineNotice>

                                                    {/* ── THE DIFF, AGAINST WHAT IS IN FORCE ──
                                                        Every key of the union, so a REMOVED
                                                        argument is as loud as an added one.
                                                        A pending edit whose arguments are
                                                        untouched says so explicitly: the
                                                        change is then in the bounds or the
                                                        target, and an empty diff rendered as
                                                        nothing would read as "no change". */}
                                                    <div
                                                        className="space-y-tight"
                                                        data-testid={`parameter-set-diff-${set.label}`}
                                                    >
                                                        <p className="text-xs font-medium text-content-emphasis">
                                                            {t('parameterSets.diffTitle')}
                                                        </p>
                                                        {changed.length === 0 && (
                                                            <p className="text-xs text-content-muted">
                                                                {t('parameterSets.diffNoArgumentChanged')}
                                                            </p>
                                                        )}
                                                        {rows.map((row) => (
                                                            <div
                                                                key={row.key}
                                                                className={cn(
                                                                    'flex flex-wrap items-baseline gap-tight text-xs',
                                                                    row.state === 'same'
                                                                        ? 'text-content-subtle'
                                                                        : 'text-content-emphasis',
                                                                )}
                                                            >
                                                                <code>{row.key}</code>
                                                                <span className="rounded bg-bg-subtle px-1 text-content-muted">
                                                                    {t(`parameterSets.diffState.${row.state}`)}
                                                                </span>
                                                                {row.state !== 'added' && (
                                                                    <code className="break-all text-content-muted">
                                                                        {row.before}
                                                                    </code>
                                                                )}
                                                                {row.state !== 'removed' &&
                                                                    row.state !== 'same' && (
                                                                        <>
                                                                            <span className="text-content-subtle">
                                                                                {'→'}
                                                                            </span>
                                                                            <code className="break-all">
                                                                                {row.after}
                                                                            </code>
                                                                        </>
                                                                    )}
                                                            </div>
                                                        ))}
                                                    </div>

                                                    <div className="space-y-tight">
                                                        <p className="text-xs font-medium text-content-emphasis">
                                                            {t('parameterSets.pendingBounds')}
                                                        </p>
                                                        {openFieldsBlock(
                                                            pending.openFields,
                                                            `parameter-set-pending-open-fields-${set.label}`,
                                                        )}
                                                        {targetBlock(pending.targetPopulation)}
                                                    </div>

                                                    {/* ── THE DIGEST AND THE SIGNATURES ──────
                                                        The count and the hash TOGETHER. A
                                                        signature does not carry forward to
                                                        replaced content — the row stores the
                                                        hash it was taken against and the
                                                        promotion counts only matching ones —
                                                        so "1 of 1" beside no digest is a
                                                        number an operator can be misled by. */}
                                                    <div
                                                        className="space-y-tight"
                                                        data-testid={`parameter-set-signatures-${set.label}`}
                                                    >
                                                        {digestLine(
                                                            pending.hash,
                                                            'font-medium text-content-emphasis',
                                                            t('parameterSets.pendingDigest', {
                                                                hash: shortHash(pending.hash),
                                                            }),
                                                        )}
                                                        <p className="text-xs text-content-muted">
                                                            {t('parameterSets.signatureCount', {
                                                                count: set.signatures.length,
                                                                required: pending.requiredApprovals,
                                                            })}
                                                        </p>
                                                        {set.signatures.length === 0 ? (
                                                            <p className="text-xs text-content-muted">
                                                                {t('parameterSets.noSignatures')}
                                                            </p>
                                                        ) : (
                                                            <ul className="space-y-tight">
                                                                {set.signatures.map((sig) => (
                                                                    <li
                                                                        key={`${sig.approverUserId}-${sig.pendingHash}`}
                                                                        className="flex flex-wrap items-baseline gap-tight text-xs text-content-muted"
                                                                    >
                                                                        <code className="text-content-emphasis">
                                                                            {sig.approverUserId}
                                                                        </code>
                                                                        <span>{formatDate(sig.createdAt)}</span>
                                                                        {/* LOAD-BEARING, not decoration —
                                                                            `digestLine` carries the whole
                                                                            argument. The operator's question
                                                                            on this row is whether THIS hash
                                                                            and the pending one above it are
                                                                            the same, and comparing two
                                                                            64-char hashes is work for the
                                                                            clipboard rather than the eye. */}
                                                                        {digestLine(
                                                                            sig.pendingHash,
                                                                            'text-content-muted',
                                                                            t('parameterSets.signatureAgainst', {
                                                                                hash: shortHash(sig.pendingHash),
                                                                            }),
                                                                        )}
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        )}
                                                        <p className="max-w-3xl text-xs text-content-subtle">
                                                            {t('parameterSets.signatureHashNote')}
                                                        </p>
                                                    </div>

                                                    <div className="flex flex-wrap items-center gap-default">
                                                        <Button
                                                            variant="secondary"
                                                            disabled={busy === set.id}
                                                            onClick={() => void act(set, 'sign')}
                                                        >
                                                            {t('parameterSets.sign')}
                                                        </Button>
                                                        {/* APPROVE is the gravity of this
                                                            region — the four-eyes commit the
                                                            whole surface exists to make
                                                            reachable — and it is `secondary`
                                                            anyway, not because the emphasis is
                                                            unearned but because
                                                            `primary-secondary-ratio`'s shared
                                                            ceiling (175) is FULL: main measures
                                                            exactly 175, so keeping one primary
                                                            here reads 176. Raising the ceiling
                                                            to fit a new page is the one thing
                                                            that ratchet exists to refuse, so
                                                            this page ships with no primary at
                                                            all and the hierarchy is carried by
                                                            order and by the digest in the
                                                            label. If a slot is ever freed, THIS
                                                            is the button that should take it. */}
                                                        <Button
                                                            variant="secondary"
                                                            disabled={busy === set.id}
                                                            onClick={() => void act(set, 'approve')}
                                                        >
                                                            {t('parameterSets.approve', {
                                                                hash: shortHash(pending.hash),
                                                            })}
                                                        </Button>
                                                    </div>
                                                </div>
                                            )}

                                            {!pending && proposingId !== set.id && (
                                                <Button
                                                    variant="secondary"
                                                    size="xs"
                                                    onClick={() => openPropose(set)}
                                                >
                                                    {t('parameterSets.propose')}
                                                </Button>
                                            )}

                                            {proposingId === set.id && (
                                                <div
                                                    className="space-y-default rounded border border-border-subtle p-3"
                                                    data-testid={`parameter-set-propose-${set.label}`}
                                                >
                                                    <p className="text-sm font-medium text-content-emphasis">
                                                        {t('parameterSets.proposeTitle')}
                                                    </p>
                                                    <FormField
                                                        label={t('parameterSets.parametersLabel')}
                                                        description={t('parameterSets.parametersHelp')}
                                                    >
                                                        <Textarea
                                                            id={`propose-parameters-${set.id}`}
                                                            rows={6}
                                                            className="font-mono text-xs"
                                                            value={proposeParameters}
                                                            onChange={(e) =>
                                                                setProposeParameters(e.target.value)
                                                            }
                                                        />
                                                    </FormField>
                                                    <FormField
                                                        label={t('parameterSets.openFieldsLabel')}
                                                        description={t('parameterSets.openFieldsHelp')}
                                                    >
                                                        <Textarea
                                                            id={`propose-open-fields-${set.id}`}
                                                            rows={6}
                                                            className="font-mono text-xs"
                                                            value={proposeOpenFields}
                                                            onChange={(e) =>
                                                                setProposeOpenFields(e.target.value)
                                                            }
                                                        />
                                                    </FormField>
                                                    {/* The populations are a CLOSED, code-defined
                                                        set that only a deploy changes, and the
                                                        list arrives from the server rather than
                                                        being respelled here — a local copy is how
                                                        a page keeps offering a population the
                                                        registry has removed.

                                                        The "no target" row is a real option rather
                                                        than an empty selection, because removing a
                                                        target is a decision with consequences: it
                                                        unbinds which rows the agent may address,
                                                        which the promotion trigger accepts as an
                                                        ordinary narrowing.

                                                        The BOUND sits below the control. A reviewer
                                                        approving an open target is approving that
                                                        sentence, so it has to be in front of them
                                                        at the moment they choose. */}
                                                    <FormField label={t('parameterSets.targetLabel')}>
                                                        <Combobox
                                                            id={`propose-target-${set.id}`}
                                                            options={targetOptions}
                                                            selected={
                                                                targetOptions.find(
                                                                    (o) => o.value === proposeTarget,
                                                                ) ?? null
                                                            }
                                                            setSelected={(o) =>
                                                                o && setProposeTarget(String(o.value))
                                                            }
                                                        />
                                                    </FormField>
                                                    {proposeTarget !== '' && (
                                                        <p
                                                            className="max-w-3xl text-xs text-content-muted"
                                                            data-testid={`parameter-set-target-bound-${set.label}`}
                                                        >
                                                            {targetPopulations.find(
                                                                (p) => p.key === proposeTarget,
                                                            )?.bound ?? ''}
                                                        </p>
                                                    )}
                                                    <div className="flex flex-wrap items-center gap-default">
                                                        <Button
                                                            variant="secondary"
                                                            onClick={() => setProposingId(null)}
                                                        >
                                                            {t('parameterSets.cancel')}
                                                        </Button>
                                                        <Button
                                                            variant="secondary"
                                                            type="submit"
                                                            disabled={busy === set.id}
                                                            onClick={() => void submitPropose(set)}
                                                        >
                                                            {t('parameterSets.proposeSubmit')}
                                                        </Button>
                                                    </div>
                                                </div>
                                            )}
                                        </Card>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </>
            )}
        </div>
    );
}
