'use client';

/**
 * TOOL DEFINITION PINS — the supply-chain half of the Tools tab.
 *
 * ## Why a TENANT-WIDE surface renders inside a per-agent tab
 *
 * `GET/POST /admin/agents/tool-manifests` carries no agentId: a pin is one
 * tenant's record of the definition it reviewed, and approving one clears the
 * boundary's refusal for EVERY agent at once. It sits here because this is the
 * only page where somebody is already thinking about what a tool is, and it is
 * drawn as a visibly separate section with its own heading and a scope badge
 * for the same reason — a tenant-wide control that looks like a per-agent one
 * gets read as "this agent's tools", and the reader then under-estimates what
 * an approval does by a factor of the whole register.
 *
 * The argument for that placement is that this section stays reachable on its
 * OWN key, `admin.agent_registry`, which the page already required — and it
 * does. The shell briefly disabled the whole tools tab on `!canGrantTools`,
 * which meant a register-key holder without tool exposure reached no pin screen
 * anywhere in the product; that gate is gone, and `ToolsTab` now renders its
 * two halves independently.
 *
 * ## What the pin is actually watching
 *
 * A tool definition is three fields: a name, a parameter schema, and a
 * DESCRIPTION. The description is instruction text handed to the model on
 * every `tools/list`, and no screen in a normal session ever renders it — so
 * it is the field an attacker edits expecting nobody to look (OWASP ASI04).
 * That is why this component leads with WHICH HALF MOVED rather than with a
 * composite digest: `DESCRIPTION_CHANGED` and `SCHEMA_CHANGED` are different
 * conversations, and only the first one means the agent is reading new
 * instructions.
 *
 * WHICH HALF MOVED is computed from the digests, never read off `status` —
 * see `movedHalves`. The two disagree in a case that matters.
 *
 * ## The approve control is rendered even when it may be refused
 *
 * The POST asserts the role-tier `canAdmin` ON TOP of the route key, and no
 * flag for that reaches the client (`ToolsTabProps` carries the tool-exposure
 * key, which is a different key on a different resource). Hiding the button on
 * a guess would hide it from the admins who hold the authority; rendering it
 * and naming the refusal is the honest half of that trade.
 *
 * The status union and the row shape are declared here rather than imported
 * from `@/lib/mcp/tool-manifest`, which pulls `node:crypto` — the same reason
 * `QuarantineClient` restates its row type instead of importing the route's.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { ApiClientError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Card } from '@/components/ui/card';
import { CopyText } from '@/components/ui/copy-text';
import { ErrorState } from '@/components/ui/error-state';
import { useToast } from '@/components/ui/hooks';
import { ShieldKeyhole } from '@/components/ui/icons/nucleo';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';

/**
 * Exported so `ToolsTab` can read the SAME SWR cache entry rather than
 * hard-coding the path a second time — the hook keys on the resolved URL, so
 * one literal in one place is what makes the two reads one request.
 */
export const TOOL_MANIFEST_PATH = '/admin/agents/tool-manifests';

type ToolManifestStatus =
    | 'APPROVED'
    | 'UNPINNED'
    | 'DESCRIPTION_CHANGED'
    | 'SCHEMA_CHANGED'
    | 'DEFINITION_CHANGED';

/** One row of `GET /admin/agents/tool-manifests`, which returns a BARE ARRAY. */
export interface ToolManifestState {
    toolName: string;
    status: ToolManifestStatus;
    liveManifestHash: string;
    liveDescriptionHash: string;
    liveSchemaHash: string;
    /**
     * The LIVE text, so the approval can be read rather than guessed.
     * There is deliberately no `approvedDescription` twin: the pin stores
     * hashes only, so the previously approved wording is not recoverable and
     * this screen must not imply a comparison it cannot make.
     */
    liveDescription: string;
    liveSchema: string;
    approvedManifestHash: string | null;
    approvedDescriptionHash: string | null;
    approvedSchemaHash: string | null;
    approvalSource: string | null;
    approvedByUserId: string | null;
    approvedAt: string | null;
    revision: number | null;
    /** True while the MCP boundary is refusing this tool outright. */
    blocked: boolean;
}

interface ApproveResult {
    toolName: string;
    revision: number;
    /** False when the pin already matched — the call was a no-op. */
    changed: boolean;
}

/**
 * Drift first, and the description ahead of the schema.
 *
 * Not alphabetical: the population is every tool the build defines, most of
 * them settled, and the two rows worth a person's attention are the ones where
 * the instruction text moved. Sorting by name buries them among the quiet ones.
 */
const STATUS_ORDER: Record<ToolManifestStatus, number> = {
    DESCRIPTION_CHANGED: 0,
    DEFINITION_CHANGED: 1,
    SCHEMA_CHANGED: 2,
    UNPINNED: 3,
    APPROVED: 4,
};

const STATUS_VARIANT: Record<ToolManifestStatus, StatusBadgeVariant> = {
    DESCRIPTION_CHANGED: 'error',
    DEFINITION_CHANGED: 'error',
    SCHEMA_CHANGED: 'warning',
    UNPINNED: 'neutral',
    APPROVED: 'success',
};

/** Enough hex to compare two digests by eye; the whole one is one click away. */
function shortDigest(hash: string): string {
    return `${hash.slice(0, 12)}…`;
}

/**
 * ── WHICH HALF MOVED, FROM THE DIGESTS ──────────────────────────────
 *
 * `status` is not sufficient. `verifyToolManifest` derives it as
 *
 *     descriptionChanged && schemaChanged ? DEFINITION_CHANGED
 *   : descriptionChanged                  ? DESCRIPTION_CHANGED
 *   : schemaChanged                       ? SCHEMA_CHANGED
 *   : DEFINITION_CHANGED
 *
 * — and that last branch is the case where the COMPOSITE digest moved while
 * both component digests sat still (a derivation change). It reports as
 * DEFINITION_CHANGED deliberately, to fail loud rather than silent. So
 * "DEFINITION_CHANGED" cannot be rendered as "the instruction text the model
 * reads was rewritten": that is the single claim on this screen an operator
 * escalates on, and in this branch `descriptionChanged` is FALSE.
 */
function movedHalves(row: ToolManifestState) {
    return {
        /** A pin exists to compare against at all. */
        pinned: row.approvedManifestHash !== null,
        descriptionMoved:
            row.approvedDescriptionHash !== null &&
            row.approvedDescriptionHash !== row.liveDescriptionHash,
        schemaMoved:
            row.approvedSchemaHash !== null && row.approvedSchemaHash !== row.liveSchemaHash,
    };
}

export interface ToolManifestPinsProps {
    /** Bridged to SWR the same way every tab bridges it. */
    refreshToken?: number;
}

/**
 * No `onChanged`, deliberately. The shell's refresh token exists so a mutation
 * on one tab re-reads the others, and an approval here changes nothing any
 * other tab renders — it moves a tenant-wide pin, not this agent's record.
 */
export function ToolManifestPins({ refreshToken }: ToolManifestPinsProps) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    const { data, error, isLoading, mutate } =
        useTenantSWR<ToolManifestState[]>(TOOL_MANIFEST_PATH);

    useEffect(() => { void mutate(); }, [refreshToken, mutate]);

    const [pending, setPending] = useState<string | null>(null);
    const [writeError, setWriteError] = useState<string | null>(null);
    /**
     * The row awaiting confirmation (#2452). Approving a pin was ONE CLICK, and
     * it is the widest action on this screen: it accepts a new tool definition
     * and clears the boundary's refusal for EVERY agent in the tenant at once.
     * It is also the tool-poisoning surface — see `movedHalves` above.
     */
    const [confirming, setConfirming] = useState<ToolManifestState | null>(null);

    const rows = useMemo(() => {
        const list = data ?? [];
        return [...list].sort(
            (a, b) =>
                STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
                a.toolName.localeCompare(b.toolName),
        );
    }, [data]);

    const driftCount = rows.filter((r) => r.status !== 'APPROVED' && r.status !== 'UNPINNED').length;

    async function approve(row: ToolManifestState) {
        if (pending) return;
        setPending(row.toolName);
        setWriteError(null);
        try {
            const res = await fetch(apiUrl(TOOL_MANIFEST_PATH), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // The hash the operator is looking at, not "whatever the build
                // says when this lands" — the route refuses the second one, and
                // that refusal is the whole reason the field is required.
                body: JSON.stringify({
                    toolName: row.toolName,
                    expectedManifestHash: row.liveManifestHash,
                }),
            });
            const body: unknown = await res.json().catch(() => null);

            if (!res.ok) {
                if (res.status === 403) {
                    // Never the body message on a 403 — it is deliberately
                    // uninformative and never names the key. This one is the
                    // role-tier `canAdmin` the route asserts on top of the
                    // permission, which no prop on this page can predict.
                    setWriteError(t('agentDetail.tools.manifests.approveForbidden'));
                    return;
                }
                if (res.status === 400 || res.status === 404) {
                    // Both are answered by re-reading: a mismatch means the
                    // build moved under the page, and a 404 means the tool is
                    // gone from it entirely.
                    setWriteError(
                        apiErrorMessage(body, t('agentDetail.tools.manifests.approveStale')),
                    );
                    await mutate().catch(() => undefined);
                    return;
                }
                setWriteError(apiErrorMessage(body, t('agentDetail.tools.manifests.approveFailed')));
                return;
            }

            const result = body as ApproveResult | null;
            // The approval LANDED. A revalidation that fails afterwards must
            // not be reported as a refused approval — the pin is written and
            // the boundary has already stopped refusing — so its rejection is
            // swallowed here rather than falling into the catch below.
            await mutate().catch(() => undefined);
            if (result && !result.changed) {
                toast.info(
                    t('agentDetail.tools.manifests.approveUnchanged', { toolName: row.toolName }),
                );
            } else {
                toast.success(
                    t('agentDetail.tools.manifests.approveSuccess', {
                        toolName: row.toolName,
                        revision: result?.revision ?? 1,
                    }),
                );
            }
        } catch {
            // A rejected fetch never reaches the `!res.ok` branch above.
            // Without this the spinner stops and the row looks untouched, which
            // on this screen is indistinguishable from "the definition is still
            // refused because nobody has approved it".
            setWriteError(t('agentDetail.tools.manifests.approveFailed'));
        } finally {
            setPending(null);
        }
    }

    /** The sentence under the row, corrected for the fallback status. */
    function explainFor(row: ToolManifestState): string {
        const { descriptionMoved, schemaMoved } = movedHalves(row);
        if (row.status === 'DEFINITION_CHANGED' && !descriptionMoved && !schemaMoved) {
            return t('agentDetail.tools.manifests.explainDefinitionOpaque');
        }
        return t(`agentDetail.tools.manifests.explain.${row.status}`);
    }

    function digestValue(hash: string): ReactNode {
        return (
            <CopyText value={hash} label={t('agentDetail.tools.manifests.copyDigest')}>
                {shortDigest(hash)}
            </CopyText>
        );
    }

    function factsFor(row: ToolManifestState): { label: string; value: ReactNode }[] {
        const facts: { label: string; value: ReactNode }[] = [];
        const { pinned, descriptionMoved, schemaMoved } = movedHalves(row);
        // On a DRIFTED row BOTH halves are rendered, not only the one that
        // moved. "The schema sat still" is a fact the reader needs stated: an
        // absent row reads as "not checked", and the half that did not move is
        // half the reason the other half is worth escalating.
        const drifted = pinned && row.status !== 'APPROVED';

        /** Two digests when the half moved, one labelled unchanged when it did not. */
        function pushHalf(
            moved: boolean,
            labels: { approved: string; live: string; unchanged: string },
            approvedHash: string | null,
            liveHash: string,
        ) {
            if (approvedHash === null) {
                // A pin carries all three digests or none — the columns are not
                // nullable — so this cannot fire today. It is still not a null
                // to fall through: "unchanged" would then be a comparison the
                // page never made, asserted about the one field nobody reads.
                facts.push({ label: labels.live, value: digestValue(liveHash) });
                return;
            }
            if (!moved) {
                facts.push({ label: labels.unchanged, value: digestValue(liveHash) });
                return;
            }
            facts.push({ label: labels.approved, value: digestValue(approvedHash) });
            facts.push({ label: labels.live, value: digestValue(liveHash) });
        }

        if (drifted) {
            pushHalf(
                descriptionMoved,
                {
                    approved: t('agentDetail.tools.manifests.descriptionApproved'),
                    live: t('agentDetail.tools.manifests.descriptionLive'),
                    unchanged: t('agentDetail.tools.manifests.descriptionUnchanged'),
                },
                row.approvedDescriptionHash,
                row.liveDescriptionHash,
            );
            pushHalf(
                schemaMoved,
                {
                    approved: t('agentDetail.tools.manifests.schemaApproved'),
                    live: t('agentDetail.tools.manifests.schemaLive'),
                    unchanged: t('agentDetail.tools.manifests.schemaUnchanged'),
                },
                row.approvedSchemaHash,
                row.liveSchemaHash,
            );
        }

        if (row.status !== 'APPROVED') {
            // What the approve button would send. Shown so the digest on the
            // receipt is one somebody can say they looked at.
            facts.push({
                label: t('agentDetail.tools.manifests.manifestLive'),
                value: digestValue(row.liveManifestHash),
            });
        }
        if (row.revision !== null) {
            facts.push({
                label: t('agentDetail.tools.manifests.revisionLabel'),
                value: <span className="tabular-nums">{row.revision}</span>,
            });
            facts.push({
                label: t('agentDetail.tools.manifests.approvedAtLabel'),
                value: formatDateTime(row.approvedAt),
            });
            facts.push({
                label: t('agentDetail.tools.manifests.sourceLabel'),
                // Never the raw server enum on the fallback arm: an unrecognised
                // third value is something this UI does not understand, and
                // printing the token would present it as though it did.
                value:
                    row.approvalSource === 'APPROVED'
                        ? t('agentDetail.tools.manifests.sourceApproved')
                        : row.approvalSource === 'BASELINE'
                          ? t('agentDetail.tools.manifests.sourceBaseline')
                          : t('agentDetail.tools.manifests.sourceUnknown'),
            });
            facts.push({
                label: t('agentDetail.tools.manifests.approvedByLabel'),
                value: row.approvedByUserId ? (
                    <span className="font-mono">{row.approvedByUserId}</span>
                ) : (
                    // A BASELINE pin has no approver by construction: nobody
                    // accepted it, the boundary merely met it first.
                    t('agentDetail.tools.manifests.approvedByNobody')
                ),
            });
        }
        return facts;
    }

    function body() {
        if (error) {
            const status = error instanceof ApiClientError ? error.status : 0;
            if (status === 403) {
                return (
                    <InlineNotice
                        variant="info"
                        title={t('agentDetail.tools.manifests.forbiddenTitle')}
                    >
                        {t('agentDetail.tools.manifests.forbiddenBody')}
                    </InlineNotice>
                );
            }
            return (
                <ErrorState
                    title={t('agentDetail.tools.manifests.loadFailedTitle')}
                    description={t('agentDetail.tools.manifests.loadFailedBody')}
                    onRetry={() => void mutate()}
                    retryLabel={t('agentDetail.tools.retry')}
                />
            );
        }
        if (isLoading && !data) return <SkeletonCard lines={5} />;
        if (rows.length === 0) {
            return (
                <InlineEmptyState
                    icon={ShieldKeyhole}
                    title={t('agentDetail.tools.manifests.noDefinitions')}
                    description={t('agentDetail.tools.manifests.noDefinitionsDescription')}
                />
            );
        }
        return (
            <ul className="divide-y divide-border-subtle">
                {rows.map((row) => (
                    <li key={row.toolName} className="space-y-compact py-compact">
                        <div className="flex flex-wrap items-start justify-between gap-default">
                            <div className="space-y-tight">
                                <div className="flex flex-wrap items-center gap-tight">
                                    <span className="font-mono text-sm text-content-emphasis">
                                        {row.toolName}
                                    </span>
                                    <StatusBadge variant={STATUS_VARIANT[row.status]} size="sm">
                                        {t(`agentDetail.tools.manifests.status.${row.status}`)}
                                    </StatusBadge>
                                    {row.blocked && (
                                        <StatusBadge variant="error" tone="solid" size="sm">
                                            {t('agentDetail.tools.manifests.blockedBadge')}
                                        </StatusBadge>
                                    )}
                                </div>
                                <p className="max-w-prose text-xs text-content-muted">
                                    {explainFor(row)}
                                </p>
                            </div>
                            {row.status !== 'APPROVED' && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    loading={pending === row.toolName}
                                    onClick={() => {
                                        setWriteError(null);
                                        setConfirming(row);
                                    }}
                                    data-testid={`tool-manifest-approve-${row.toolName}`}
                                >
                                    {t('agentDetail.tools.manifests.approveAction')}
                                </Button>
                            )}
                        </div>
                        <dl className="flex flex-wrap gap-default">
                            {factsFor(row).map((fact) => (
                                <div key={fact.label} className="space-y-tight">
                                    <dt className="text-xs uppercase tracking-wide text-content-subtle">
                                        {fact.label}
                                    </dt>
                                    <dd className="text-xs text-content-default">{fact.value}</dd>
                                </div>
                            ))}
                        </dl>
                    </li>
                ))}
            </ul>
        );
    }

    return (
        <Card as="section" density="compact" className="space-y-default">
            <div className="space-y-tight">
                <div className="flex flex-wrap items-center gap-tight">
                    <ShieldKeyhole className="w-4 h-4 text-content-subtle" aria-hidden="true" />
                    <Heading level={2}>{t('agentDetail.tools.manifests.heading')}</Heading>
                    {/* The scope, said in the chrome. Everything else on this
                        page is about one agent; this section is not. */}
                    <StatusBadge variant="info" size="sm">
                        {t('agentDetail.tools.manifests.scopeBadge')}
                    </StatusBadge>
                    {/* `!error` as well: the hook keeps previous data across a
                        failed revalidation, and "2 needing review" beside a body
                        saying the pin states did not load is a count nobody can
                        act on presented as a live one. */}
                    {!error && driftCount > 0 && (
                        <StatusBadge variant="error" tone="solid" size="sm">
                            {t('agentDetail.tools.manifests.driftCount', { count: driftCount })}
                        </StatusBadge>
                    )}
                </div>
                <p className="max-w-prose text-sm text-content-muted">
                    {t('agentDetail.tools.manifests.intro')}
                </p>
            </div>

            {writeError && (
                <InlineNotice variant="error" onDismiss={() => setWriteError(null)}>
                    {writeError}
                </InlineNotice>
            )}

            {body()}

            {confirming && (
                <ManifestApprovalDialog
                    row={confirming}
                    busy={pending === confirming.toolName}
                    onCancel={() => setConfirming(null)}
                    onConfirm={async () => {
                        const row = confirming;
                        await approve(row);
                        setConfirming(null);
                    }}
                />
            )}
        </Card>
    );
}

/**
 * WHAT ACCEPTING THIS PIN ACTUALLY DOES (#2452).
 *
 * ── WHY A DIFF, AND WHY IT IS NOT A TEXT DIFF ───────────────────────
 *
 * The pin stores HASHES ONLY — `McpToolManifestPin` has `descriptionHash`,
 * `schemaHash`, `manifestHash` and no text. The previously approved WORDING IS
 * NOT RECOVERABLE, at any cost, so an old-vs-new text diff is not a thing this
 * screen can honestly render. It says so, rather than implying a comparison it
 * cannot make.
 *
 * What it renders instead is the two things that are true and sufficient:
 * WHICH of the halves moved, from the hashes, and the LIVE TEXT the operator is
 * being asked to accept.
 *
 * ── THE DESCRIPTION-ONLY CASE IS CALLED OUT BY NAME ─────────────────
 *
 * `tool-manifest.ts` explains why: the description is instruction text
 * delivered straight to the model, so it is the one field an attacker can edit
 * to change behaviour while every structural signal stays identical. A reader
 * skimming "name unchanged, schema unchanged" waves that through. So when the
 * description moved and the schema did not, that combination gets its own
 * warning rather than being left for the reader to assemble.
 */
function ManifestApprovalDialog({
    row,
    busy,
    onCancel,
    onConfirm,
}: {
    row: ToolManifestState;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void | Promise<void>;
}) {
    const t = useTranslations('admin');
    const moved = movedHalves(row);
    const descriptionOnly = moved.descriptionMoved && !moved.schemaMoved;

    return (
        <Modal showModal setShowModal={(v) => { if (!v && !busy) onCancel(); }} size="lg" preventDefaultClose={busy}>
            <Modal.Header
                title={t('agentDetail.tools.manifests.confirmTitle', { tool: row.toolName })}
            />
            <Modal.Body>
                <div className="space-y-default" data-testid="manifest-approval-dialog">
                    {/* TENANT-WIDE, said first. This is not this agent's pin. */}
                    <InlineNotice variant="warning" data-testid="manifest-approval-scope">
                        {t('agentDetail.tools.manifests.confirmTenantWide')}
                    </InlineNotice>

                    {descriptionOnly && (
                        <InlineNotice variant="error" data-testid="manifest-approval-description-only">
                            {t('agentDetail.tools.manifests.confirmDescriptionOnly')}
                        </InlineNotice>
                    )}

                    <dl className="space-y-tight text-sm" data-testid="manifest-approval-halves">
                        <div>
                            <dt className="text-xs uppercase tracking-wide text-content-subtle">
                                {t('agentDetail.tools.manifests.halfName')}
                            </dt>
                            {/* The tool NAME cannot move without becoming a
                                different tool — a rename is a new row, not a
                                changed one. Stated so its absence from the
                                changed list is not read as "not checked". */}
                            <dd data-testid="manifest-half-name">
                                {row.toolName} — {t('agentDetail.tools.manifests.halfUnchanged')}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-xs uppercase tracking-wide text-content-subtle">
                                {t('agentDetail.tools.manifests.halfDescription')}
                            </dt>
                            <dd
                                data-testid="manifest-half-description"
                                className={moved.descriptionMoved ? 'text-content-error' : undefined}
                            >
                                {moved.descriptionMoved
                                    ? t('agentDetail.tools.manifests.halfChanged')
                                    : t('agentDetail.tools.manifests.halfUnchanged')}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-xs uppercase tracking-wide text-content-subtle">
                                {t('agentDetail.tools.manifests.halfSchema')}
                            </dt>
                            <dd
                                data-testid="manifest-half-schema"
                                className={moved.schemaMoved ? 'text-content-error' : undefined}
                            >
                                {moved.schemaMoved
                                    ? t('agentDetail.tools.manifests.halfChanged')
                                    : t('agentDetail.tools.manifests.halfUnchanged')}
                            </dd>
                        </div>
                    </dl>

                    <p className="text-xs text-content-muted">
                        {t('agentDetail.tools.manifests.confirmNoPriorText')}
                    </p>

                    <div>
                        <p className="text-xs uppercase tracking-wide text-content-subtle">
                            {t('agentDetail.tools.manifests.liveDescriptionLabel')}
                        </p>
                        <pre
                            className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-bg-subtle p-2 text-xs"
                            data-testid="manifest-live-description"
                        >
                            {row.liveDescription}
                        </pre>
                    </div>

                    <div>
                        <p className="text-xs uppercase tracking-wide text-content-subtle">
                            {t('agentDetail.tools.manifests.liveSchemaLabel')}
                        </p>
                        <pre
                            className="mt-1 max-h-48 overflow-auto rounded bg-bg-subtle p-2 text-xs"
                            data-testid="manifest-live-schema"
                        >
                            {row.liveSchema}
                        </pre>
                    </div>
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
                    {t('agentDetail.kill.cancel')}
                </Button>
                <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    loading={busy}
                    data-testid="manifest-approval-confirm"
                    onClick={() => void onConfirm()}
                >
                    {t('agentDetail.tools.manifests.confirmAction')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}
