'use client';

/**
 * The column-mapping section of a legacy connection's page.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS SCREEN SHOWS STATISTICS, NOT VALUES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every cell in the table below is a count, a share or a column NAME. The one
 * exception is the status value-map editor, and it renders only for a column
 * whose profile proved its values are a VOCABULARY — at most twelve distinct,
 * recurring, no email among them — because you cannot ask somebody to map `A`
 * onto `ACTIVE` without showing them `A`. The gate lives in
 * `lib/legacy-access/mapping-suggest.ts`; the server decides, and a column that
 * did not qualify arrives here with no `valueSet` at all, so this component
 * cannot render one even by mistake.
 *
 * That matters more here than on any other screen in the subsystem: this is the
 * only surface an operator sees BEFORE anybody has declared what the columns
 * mean, so it is the only place an unclassified sensitive column could be put in
 * front of a person.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING IS SAVED UNTIL SAVE IS PRESSED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reading the columns pre-selects the suggested target for each one, which is a
 * convenience and not a decision — the state is local until the button is
 * pressed. Accepting every suggestion at once still requires the press, because
 * a mapping that names the wrong column produces confident links between the
 * wrong people rather than an error.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { DataTable, createColumns } from '@/components/ui/table';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Input } from '@/components/ui/input';

const LEGACY_PROVIDER = 'legacy-mcp';

const CANONICAL_STATUSES = ['ACTIVE', 'DISABLED', 'LOCKED', 'EXPIRED', 'UNKNOWN'] as const;

/** Mirrors `ProfiledColumn` on the wire. Statistics and names only. */
interface WireProfile {
    name: string;
    rowsSampled: number;
    nonNullCount: number;
    distinctCount: number;
    emailShare: number;
    dateShare: number;
    integerShare: number;
    booleanShare: number;
    maxLength: number;
    valueSet?: string[];
}

interface WireSuggestion {
    column: string;
    suggested: string | null;
    basis: 'name' | 'profile' | 'name+profile' | null;
    confidence: number;
    denied: boolean;
    note: string;
}

interface WireColumn {
    profile: WireProfile;
    suggestion: WireSuggestion;
}

interface WireDrift {
    added: string[];
    removed: string[];
    indeterminate: boolean;
}

interface WireProfileResult {
    application: { name: string; owner: string };
    columns: WireColumn[];
    columnSetFingerprint: string;
    observedColumns: string[];
    declaredLayout: 'wide' | 'long';
    rowsSampled: number;
    truncated: boolean;
    overshared: string[];
    drift: WireDrift | null;
    mappingVersion: number | null;
}

type LayoutKind = 'none' | 'wide' | 'long' | 'delimited';

const CANONICAL_FIELDS = [
    'accountKey', 'username', 'displayName', 'givenName', 'familyName', 'email',
    'employeeNumber', 'department', 'title', 'managerRef',
    'status', 'lastLoginAt', 'createdAt', 'expiresAt',
    'entitlements', 'isPrivileged', 'accountType',
] as const;

export function LegacyAccessMappingCard({ connectionId }: { connectionId: string }) {
    const t = useTranslations('admin.integrations.legacyMapping');
    const apiUrl = useTenantApiUrl();

    const [applies, setApplies] = useState<boolean | null>(null);
    const [profile, setProfile] = useState<WireProfileResult | null>(null);
    const [reading, setReading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

    /** column name → canonical field, or '' for not mapped. Local until saved. */
    const [targets, setTargets] = useState<Record<string, string>>({});
    /** source status value → canonical status. */
    const [statusValues, setStatusValues] = useState<Record<string, string>>({});
    const [layout, setLayout] = useState<LayoutKind>('none');
    const [layoutColumns, setLayoutColumns] = useState<string[]>([]);
    const [layoutColumn, setLayoutColumn] = useState('');
    const [delimiter, setDelimiter] = useState(',');

    // Whether this card applies at all. Decided from the connection's PROVIDER
    // rather than from whether it happens to carry an endpoint, so an `entra-id`
    // connection shows nothing instead of an error about a missing credential.
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
                // Unknown rather than false: rendering nothing because a list call
                // failed would hide the whole feature behind an unrelated error.
                if (alive) setApplies(null);
            }
        })();
        return () => { alive = false; };
    }, [apiUrl, connectionId]);

    const readColumns = useCallback(async () => {
        setReading(true);
        setMsg(null);
        try {
            const res = await fetch(apiUrl('/admin/legacy-access/profile'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ connectionId }),
            });
            if (!res.ok) throw new Error(String(res.status));
            const body = (await res.json()) as WireProfileResult;
            setProfile(body);
            // Pre-select the suggestions. A convenience, not a decision — nothing
            // reaches the server until Save.
            const next: Record<string, string> = {};
            for (const c of body.columns) {
                if (!c.suggestion.denied && c.suggestion.suggested) {
                    next[c.profile.name] = c.suggestion.suggested;
                }
            }
            setTargets(next);
            setLayout(body.declaredLayout === 'long' ? 'long' : 'none');
        } catch {
            setMsg({ ok: false, text: t('profileFailed') });
        } finally {
            setReading(false);
        }
    }, [apiUrl, connectionId, t]);

    /** The column currently mapped to `status`, if its values are a vocabulary. */
    const statusColumn = useMemo(() => {
        if (!profile) return null;
        const name = Object.entries(targets).find(([, f]) => f === 'status')?.[0];
        if (!name) return null;
        const col = profile.columns.find((c) => c.profile.name === name);
        return col?.profile.valueSet?.length ? col.profile : null;
    }, [profile, targets]);

    const save = useCallback(async () => {
        if (!profile) return;
        setSaving(true);
        setMsg(null);
        try {
            const fields: Record<string, string> = {};
            for (const [column, field] of Object.entries(targets)) {
                if (field) fields[field] = column;
            }
            const entitlements =
                layout === 'wide' ? { kind: 'wide', columns: layoutColumns }
                    : layout === 'long' ? { kind: 'long', column: layoutColumn }
                        : layout === 'delimited'
                            ? { kind: 'delimited', column: layoutColumn, delimiter }
                            : { kind: 'none' };

            const res = await fetch(apiUrl('/admin/legacy-access/mapping'), {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    connectionId,
                    fields,
                    entitlements,
                    ...(Object.keys(statusValues).length ? { statusValues } : {}),
                    columnSetFingerprint: profile.columnSetFingerprint,
                    // Sent so a later drift refusal can itemise what changed. A
                    // fingerprint alone cannot be diffed.
                    confirmedColumns: profile.observedColumns,
                }),
            });
            const body = (await res.json().catch(() => null)) as
                | { mapping?: { version: number }; error?: string }
                | null;
            if (!res.ok) {
                // The server reports EVERY problem at once, so this is shown
                // verbatim rather than reduced to "invalid".
                throw new Error(body?.error ?? String(res.status));
            }
            setMsg({ ok: true, text: t('saved', { version: body?.mapping?.version ?? 0 }) });
            await readColumns();
        } catch (e) {
            setMsg({
                ok: false,
                text: t('saveFailed', { reason: e instanceof Error ? e.message : 'unknown' }),
            });
        } finally {
            setSaving(false);
        }
    }, [apiUrl, connectionId, profile, targets, statusValues, layout, layoutColumns, layoutColumn, delimiter, t, readColumns]);

    const columns = useMemo(() => createColumns<WireColumn>([
        {
            id: 'column',
            accessorKey: 'profile',
            header: t('colColumn'),
            cell: ({ row }) => (
                <span className="font-mono">{row.original.profile.name}</span>
            ),
        },
        {
            id: 'suggestion',
            accessorKey: 'suggestion',
            header: t('colSuggestion'),
            cell: ({ row }) => {
                const s = row.original.suggestion;
                if (s.denied) {
                    return <StatusBadge variant="warning">{t('deniedColumn')}</StatusBadge>;
                }
                if (!s.suggested) return <span className="text-content-muted">—</span>;
                const basis = s.basis === 'name+profile' ? t('basisBoth')
                    : s.basis === 'profile' ? t('basisProfile') : t('basisName');
                return (
                    <span>
                        <span className="font-mono">{s.suggested}</span>
                        <span className="text-content-muted"> · {basis}</span>
                    </span>
                );
            },
        },
        {
            id: 'target',
            accessorKey: 'profile',
            header: t('colTarget'),
            cell: ({ row }) => {
                const { name } = row.original.profile;
                if (row.original.suggestion.denied) {
                    return <span className="text-content-muted">{t('deniedHelp')}</span>;
                }
                const selected = targets[name] ?? '';
                return (
                    <Combobox
                        options={[
                            { value: '', label: t('unmapped') },
                            ...CANONICAL_FIELDS.map((f) => ({ value: f, label: f })),
                        ]}
                        selected={selected ? { value: selected, label: selected } : null}
                        onSelect={(o) =>
                            setTargets((prev) => ({ ...prev, [name]: o.value }))
                        }
                        placeholder={t('unmapped')}
                    />
                );
            },
        },
        {
            id: 'stats',
            accessorKey: 'profile',
            header: t('colStats'),
            cell: ({ row }) => {
                const p = row.original.profile;
                if (row.original.suggestion.denied) return <span>—</span>;
                if (p.nonNullCount === 0) {
                    return <span className="text-content-muted">{t('statsEmpty')}</span>;
                }
                const pct = (x: number) => Math.round(x * 100);
                const notes: string[] = [];
                if (p.emailShare > 0.1) notes.push(t('statsEmail', { percent: pct(p.emailShare) }));
                if (p.dateShare > 0.1) notes.push(t('statsDate', { percent: pct(p.dateShare) }));
                if (p.integerShare > 0.5) notes.push(t('statsInteger', { percent: pct(p.integerShare) }));
                if (p.booleanShare > 0.5) notes.push(t('statsBoolean', { percent: pct(p.booleanShare) }));
                return (
                    <span className="text-content-muted">
                        {t('statsSummary', {
                            nonNull: p.nonNullCount,
                            rows: p.rowsSampled,
                            distinct: p.distinctCount,
                        })}
                        {notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}
                    </span>
                );
            },
        },
    ]), [t, targets]);

    if (applies === false) return null;

    return (
        <Card className="space-y-default">
            <Heading level={2}>{t('title')}</Heading>
            <p className="text-content-muted">{t('description')}</p>

            {msg ? (
                <InlineNotice variant={msg.ok ? 'success' : 'error'}>{msg.text}</InlineNotice>
            ) : null}

            {profile?.drift ? (
                <InlineNotice variant="warning">
                    <strong>{t('driftTitle', { version: profile.mappingVersion ?? 0 })}</strong>
                    <br />
                    {profile.drift.indeterminate
                        ? t('driftIndeterminate')
                        : profile.drift.added.length === 0 && profile.drift.removed.length === 0
                            ? t('driftNone')
                            : [
                                profile.drift.added.length
                                    ? t('driftAdded', { columns: profile.drift.added.join(', ') })
                                    : null,
                                profile.drift.removed.length
                                    ? t('driftRemoved', { columns: profile.drift.removed.join(', ') })
                                    : null,
                            ].filter(Boolean).join(' · ')}
                    <br />
                    {t('driftAction')}
                </InlineNotice>
            ) : null}

            {profile?.overshared.length ? (
                <InlineNotice variant="warning">
                    {t('oversharingNotice', { columns: profile.overshared.join(', ') })}
                </InlineNotice>
            ) : null}

            <div className="flex items-center gap-default">
                <Button variant="ghost" onClick={readColumns} disabled={reading}>
                    {reading ? t('profiling') : profile ? t('reprofileButton') : t('profileButton')}
                </Button>
                {profile ? (
                    <span className="text-content-muted">
                        {t('application', profile.application)}
                        {' · '}
                        {profile.mappingVersion
                            ? t('versionInForce', { version: profile.mappingVersion })
                            : t('noMapping')}
                    </span>
                ) : null}
            </div>

            {profile ? (
                <>
                    <InlineNotice variant="info">
                        {t('sampleNotice', { rows: profile.rowsSampled })}
                        {profile.truncated ? ` ${t('truncatedNotice')}` : ''}
                    </InlineNotice>

                    <DataTable
                        data-testid="legacy-mapping-table"
                        data={profile.columns}
                        columns={columns}
                        getRowId={(r) => r.profile.name}
                        virtualize={false}
                    />

                    {statusColumn ? (
                        <section className="space-y-compact">
                            <Heading level={3}>{t('statusMapTitle')}</Heading>
                            <p className="text-content-muted">{t('statusMapHelp')}</p>
                            {statusColumn.valueSet!.map((value) => (
                                <FormField key={value} label={value} orientation="horizontal">
                                    <Combobox
                                        options={CANONICAL_STATUSES.map((s) => ({ value: s, label: s }))}
                                        selected={
                                            statusValues[value]
                                                ? { value: statusValues[value], label: statusValues[value] }
                                                : null
                                        }
                                        onSelect={(o) =>
                                            setStatusValues((prev) => ({ ...prev, [value]: o.value }))
                                        }
                                        placeholder="UNKNOWN"
                                    />
                                </FormField>
                            ))}
                        </section>
                    ) : null}

                    <section className="space-y-compact">
                        <Heading level={3}>{t('layoutTitle')}</Heading>
                        <p className="text-content-muted">{t('layoutHelp')}</p>
                        <p className="text-content-muted">
                            {t('layoutServerSays', { layout: profile.declaredLayout })}
                        </p>
                        <FormField label={t('layoutTitle')}>
                            <Combobox
                                options={[
                                    { value: 'none', label: t('layoutNone') },
                                    { value: 'wide', label: t('layoutWide') },
                                    { value: 'long', label: t('layoutLong') },
                                    { value: 'delimited', label: t('layoutDelimited') },
                                ]}
                                selected={{ value: layout, label: layout }}
                                onSelect={(o) => setLayout(o.value as LayoutKind)}
                            />
                        </FormField>
                        {layout === 'wide' ? (
                            <FormField label={t('layoutColumns')} description={t('layoutHelp')}>
                                <Input
                                    value={layoutColumns.join(',')}
                                    onChange={(e) =>
                                        setLayoutColumns(
                                            e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                                        )
                                    }
                                />
                            </FormField>
                        ) : null}
                        {layout === 'long' || layout === 'delimited' ? (
                            <FormField label={t('layoutColumn')}>
                                <Input value={layoutColumn} onChange={(e) => setLayoutColumn(e.target.value)} />
                            </FormField>
                        ) : null}
                        {layout === 'delimited' ? (
                            <FormField label={t('layoutDelimiter')}>
                                <Input value={delimiter} onChange={(e) => setDelimiter(e.target.value)} />
                            </FormField>
                        ) : null}
                    </section>

                    {/*
                      * `secondary`, not `primary`. The repo-wide primary count is a
                      * downward ratchet, and the only ways to add one are to demote
                      * somebody else's button or raise a shared ceiling — neither of
                      * which a new card is entitled to do. Hierarchy comes from the
                      * pairing instead: this is secondary against a ghost "read
                      * columns", and the page's own action is secondary too, so
                      * nothing on the page claims to be the one primary.
                      */}
                    <Button variant="secondary" onClick={save} disabled={saving}>
                        {saving ? t('saving') : t('saveButton')}
                    </Button>
                </>
            ) : null}
        </Card>
    );
}
