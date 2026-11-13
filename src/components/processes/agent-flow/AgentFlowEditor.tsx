'use client';

/**
 * THE AGENT-FLOW EDITOR (Phases 3 and 4 of `docs/ai-architecture/langflow.md`).
 *
 * A palette, a tldraw canvas, an inspector and a Compiled panel over ONE draft.
 *
 * ═══ ONE WRITE PATH ═══
 *
 * The editor writes exactly one thing: a new profile version, through the
 * EXISTING version route (`POST …/admin/agents/:id/profile/versions`), which
 * calls `createAgentProfileVersion` under `admin.agent_registry`. That version
 * is a DRAFT that a second person approves. There is no flow route, no layout
 * route and no other request here. The body is `flowVersionBody`, which takes
 * no layout, so moving a box cannot reach the governed write — and moving a box
 * creates no version, because the Save button reads `draftChangesFlow`, which
 * compares the flow's stored text and nothing else.
 *
 * Submission goes through the existing submit route; approval stays on the
 * Behaviour tab and stays a different person.
 *
 * ═══ THE PREVIEW IS THE ENGINE'S ═══
 *
 * The Compiled panel shows the server's `previewProfileRunMessage` (the run
 * path's own `runMessage`) and the server's tool states (`offerToolSet`, via
 * the agent projection) for the SAVED version. It computes neither: a draft
 * that differs from the saved version says so, rather than guessing what its
 * message would be.
 */
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import type { AgentCanvasProfileToolState } from '@/lib/agentic/agent-canvas-projection';
import type { AgentFlow, FlowNodeKind } from '@/lib/agentic/agent-flow';
import { mcpToolCapabilityClass } from '@/lib/mcp/tool-catalogue';
import {
    AGENT_FLOW_PALETTE,
    diagnoseFlowDraft,
    diffFlows,
    draftChangesFlow,
    draftFromFlow,
    flowVersionBody,
    layoutForDraft,
    nextNodeKey,
    type FlowDiagnostic,
    type FlowDraft,
    type FlowDraftNode,
    type FlowLayout,
    type FlowVersionBase,
} from '@/lib/processes/agent-flow/agent-flow-document';

import type { AgentFlowCanvasEdge, AgentFlowCanvasNode } from './AgentFlowCanvas';

/** tldraw needs `window`; the editor loads in the browser only, inside this segment. */
const AgentFlowCanvas = dynamic(() => import('./AgentFlowCanvas').then((m) => m.AgentFlowCanvas), { ssr: false });

/** The version the editor opened: the newest one. */
export interface OpenedFlowVersion extends FlowVersionBase {
    version: number;
    status: string;
    flow: AgentFlow | null;
}

/** The server's preview of the opened version (`ProfileRunPreview`, client copy). */
export type FlowRunPreview =
    | {
          state: 'SHOWN';
          version: number;
          runAs: 'RUN' | 'TEST_RUN' | null;
          /** Admission refuses this version on every engine: no run receives the message. */
          runRefused:
              | 'PROFILE_FLOW_NOT_RUNNABLE'
              | 'PROFILE_SUBAGENTS_NOT_RUNNABLE'
              | 'PROFILE_ENGINE_CANNOT_RUN_PROFILES'
              | null;
          message: string;
          readOnly: boolean;
      }
    | { state: 'NOT_FOUND' }
    | { state: 'UNRUNNABLE' };

export interface AgentFlowEditorProps {
    tenantSlug: string;
    agentId: string;
    /** This agent's profile, which a subagent step may not name. */
    profileId: string;
    opened: OpenedFlowVersion;
    /** The approved version in force, when it is not the opened one. */
    inForce: { version: number; flow: AgentFlow | null } | null;
    /** The agent's current grants: the tool picker lists these and nothing else. */
    grants: string[];
    /** Approved profiles in this workspace (`listFlowSubagentOptions`). */
    subagentOptions: Array<{ profileId: string; agentName: string; version: number }>;
    preview: FlowRunPreview;
    /** `offerToolSet`'s verdict on each of the opened version's tools, or null when not shown. */
    toolStates: AgentCanvasProfileToolState[] | null;
}

type Mode = 'edit' | 'diff';

export function AgentFlowEditor(props: AgentFlowEditorProps) {
    const { tenantSlug, agentId, profileId, opened, inForce, grants, subagentOptions, preview, toolStates } = props;
    const t = useTranslations('agentFlow');
    const router = useRouter();
    const [draft, setDraft] = useState<FlowDraft>(() => draftFromFlow(opened.flow));
    const [held, setHeld] = useState<FlowLayout>({});
    const [selected, setSelected] = useState<string | null>(null);
    // The draft is SEEDED from the opened version, and re-seeded whenever a
    // different version opens — which is what a save does: the server writes
    // the next version (with each label sanitised and trimmed), the refresh
    // opens it, and the draft becomes that version's flow. Without this the
    // draft kept the text as typed, so a label the server normalised left the
    // draft different from the stored flow for good: Save stayed on, Submit
    // stayed hidden, and every click wrote another identical DRAFT.
    const [seededFrom, setSeededFrom] = useState(opened.version);
    if (seededFrom !== opened.version) {
        setSeededFrom(opened.version);
        setDraft(draftFromFlow(opened.flow));
        setSelected(null);
    }
    const [mode, setMode] = useState<Mode>('edit');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const outputKind = opened.outputKind === 'ANSWER_ONLY' ? 'ANSWER_ONLY' : 'ANSWER_AND_PROPOSALS';
    const diagnostics = useMemo(
        () =>
            diagnoseFlowDraft(draft, {
                grants,
                approvedProfileIds: subagentOptions.map((o) => o.profileId),
                selfProfileId: profileId,
                outputKind,
            }),
        [draft, grants, subagentOptions, profileId, outputKind],
    );
    const changed = draftChangesFlow(opened.flow, draft);
    const canSave = changed && diagnostics.length === 0 && !busy;
    const layout = useMemo(() => layoutForDraft(draft, held), [draft, held]);
    const diff = useMemo(() => diffFlows(inForce?.flow ?? null, opened.flow), [inForce, opened.flow]);

    const describe = useCallback((d: FlowDiagnostic) => t(`diagnostic.${d.code}`), [t]);
    const problemsOf = useCallback(
        (key: string) => diagnostics.filter((d) => d.nodeKey === key).map(describe),
        [diagnostics, describe],
    );
    const profileName = useCallback(
        (id: string | undefined) => subagentOptions.find((o) => o.profileId === id)?.agentName ?? id ?? '',
        [subagentOptions],
    );
    const detailOf = useCallback(
        (n: FlowDraftNode): string =>
            n.kind === 'read' || n.kind === 'propose'
                ? n.tool || t('detail.noTool')
                : n.kind === 'subagent'
                  ? n.profileRef ? profileName(n.profileRef) : t('detail.noProfile')
                  : t('detail.synthesis'),
        [t, profileName],
    );

    // ─── What the canvas draws ──────────────────────────────────────
    const canvas = useMemo((): { nodes: AgentFlowCanvasNode[]; edges: AgentFlowCanvasEdge[]; layout: FlowLayout } => {
        if (mode === 'diff') {
            // The union of both flows, each step and connection marked.
            const before = draftFromFlow(inForce?.flow ?? null);
            const after = draftFromFlow(opened.flow);
            const byKey = new Map([...before.nodes, ...after.nodes].map((n) => [n.key, n]));
            for (const n of after.nodes) byKey.set(n.key, n);
            const union: FlowDraft = {
                nodes: [...byKey.values()],
                edges: [...before.edges, ...after.edges].filter(
                    (e, i, all) => all.findIndex((x) => x.from === e.from && x.to === e.to) === i,
                ),
            };
            return {
                nodes: union.nodes.map((n) => ({
                    key: n.key,
                    kind: n.kind,
                    label: n.label,
                    detail: detailOf(n),
                    problems: [],
                    change: diff.nodes[n.key] === 'unchanged' ? '' : diff.nodes[n.key] ?? '',
                })),
                edges: union.edges.map((e) => {
                    const k = `${e.from}->${e.to}`;
                    return { ...e, change: diff.edgesAdded.includes(k) ? 'added' : diff.edgesRemoved.includes(k) ? 'removed' : '' };
                }),
                layout: layoutForDraft(union),
            };
        }
        return {
            nodes: draft.nodes.map((n) => ({
                key: n.key,
                kind: n.kind,
                label: n.label || t(`kind.${n.kind}`),
                detail: detailOf(n),
                problems: problemsOf(n.key),
                change: '',
            })),
            edges: draft.edges.map((e) => ({ ...e, change: '' })),
            layout,
        };
    }, [mode, inForce, opened.flow, diff, draft, layout, detailOf, problemsOf, t]);

    // ─── Logic edits (the inspector and the palette) ────────────────
    const addStep = (kind: FlowNodeKind) => {
        const key = nextNodeKey(draft, kind);
        setDraft((d) => ({ ...d, nodes: [...d.nodes, { key, kind, label: t(`kind.${kind}`) }] }));
        setSelected(key);
    };
    const updateStep = (key: string, patch: Partial<FlowDraftNode>) =>
        setDraft((d) => ({ ...d, nodes: d.nodes.map((n) => (n.key === key ? { ...n, ...patch } : n)) }));
    const removeStep = (key: string) => {
        setDraft((d) => ({
            nodes: d.nodes.filter((n) => n.key !== key),
            edges: d.edges.filter((e) => e.from !== key && e.to !== key),
        }));
        setSelected(null);
    };
    const setNextSteps = (key: string, next: string[]) =>
        setDraft((d) => ({
            ...d,
            edges: [...d.edges.filter((e) => e.from !== key), ...next.map((to) => ({ from: key, to }))],
        }));

    // ─── The one write ──────────────────────────────────────────────
    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/admin/agents/${agentId}/profile/versions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(flowVersionBody(opened, draft)),
            });
            if (!res.ok) {
                setError(apiErrorMessage(await res.json().catch(() => null), t('saveFailed')));
                return;
            }
            router.refresh();
        } finally {
            setBusy(false);
        }
    };
    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(
                `/api/t/${tenantSlug}/admin/agents/${agentId}/profile/versions/${opened.version}/submit`,
                { method: 'POST' },
            );
            if (!res.ok) {
                setError(apiErrorMessage(await res.json().catch(() => null), t('submitFailed')));
                return;
            }
            router.refresh();
        } finally {
            setBusy(false);
        }
    };

    const step = draft.nodes.find((n) => n.key === selected) ?? null;
    const globalProblems = diagnostics.filter((d) => d.nodeKey === undefined);

    return (
        <div className="space-y-section" data-testid="agent-flow-editor">
            <div className="flex flex-wrap items-center gap-default">
                <StatusBadge variant="neutral" data-testid="agent-flow-opened-version">
                    {t('openedVersion', { version: opened.version, status: opened.status })}
                </StatusBadge>
                {inForce && (
                    <Button
                        variant="secondary"
                        size="sm"
                        data-testid="agent-flow-toggle-diff"
                        onClick={() => setMode((m) => (m === 'edit' ? 'diff' : 'edit'))}
                    >
                        {mode === 'edit' ? t('showDiff', { version: inForce.version }) : t('backToEdit')}
                    </Button>
                )}
                <span className="ml-auto flex gap-tight">
                    <Button variant="primary" disabled={!canSave} onClick={save} data-testid="agent-flow-save">
                        {t('save')}
                    </Button>
                    {opened.status === 'DRAFT' && !changed && (
                        <Button variant="secondary" disabled={busy} onClick={submit} data-testid="agent-flow-submit">
                            {t('submit')}
                        </Button>
                    )}
                </span>
            </div>
            <p className="text-sm text-content-muted">{changed ? t('unsaved') : t('noChangesBody')}</p>
            {error && (
                <InlineNotice variant="error" data-testid="agent-flow-error">
                    {error}
                </InlineNotice>
            )}

            {mode === 'edit' && (
                <div className="flex flex-wrap gap-tight" data-testid="agent-flow-palette" role="toolbar" aria-label={t('palette')}>
                    {AGENT_FLOW_PALETTE.map((kind) => (
                        <Button
                            key={kind}
                            variant="secondary"
                            size="sm"
                            data-testid={`agent-flow-add-${kind}`}
                            onClick={() => addStep(kind)}
                        >
                            {t(`kind.${kind}`)}
                        </Button>
                    ))}
                </div>
            )}

            {mode === 'diff' && (
                <ul className="space-y-tight text-sm" data-testid="agent-flow-diff-list">
                    {diff.same && <li>{t('diffSame')}</li>}
                    {Object.entries(diff.nodes)
                        .filter(([, c]) => c !== 'unchanged')
                        .map(([key, c]) => (
                            <li key={key} data-testid={`agent-flow-diff-${key}`}>
                                {t(`change.${c}`)}: {key}
                            </li>
                        ))}
                    {diff.edgesAdded.map((e) => (
                        <li key={`+${e}`}>{t('change.edgeAdded')}: {e}</li>
                    ))}
                    {diff.edgesRemoved.map((e) => (
                        <li key={`-${e}`}>{t('change.edgeRemoved')}: {e}</li>
                    ))}
                </ul>
            )}

            <div className="grid gap-default lg:grid-cols-[1fr_320px]">
                <div
                    className="h-[60vh] min-h-96 overflow-hidden rounded-lg border border-border-default"
                    data-testid="agent-flow-surface"
                >
                    <AgentFlowCanvas
                        nodes={canvas.nodes}
                        edges={canvas.edges}
                        layout={canvas.layout}
                        readOnly={mode === 'diff'}
                        onMove={(key, at) => setHeld((h) => ({ ...h, [key]: at }))}
                        onSelect={setSelected}
                    />
                </div>

                {mode === 'edit' && (
                    <aside className="space-y-default" data-testid="agent-flow-inspector">
                        {globalProblems.map((d) => (
                            <InlineNotice key={d.code} variant="warning" data-testid={`agent-flow-diagnostic-${d.code}`}>
                                {describe(d)}
                            </InlineNotice>
                        ))}
                        {step === null ? (
                            <p className="text-sm text-content-muted">{t('selectStep')}</p>
                        ) : (
                            <StepInspector
                                step={step}
                                draft={draft}
                                grants={grants}
                                subagentOptions={subagentOptions}
                                problems={diagnostics.filter((d) => d.nodeKey === step.key)}
                                describe={describe}
                                onChange={(patch) => updateStep(step.key, patch)}
                                onNextSteps={(next) => setNextSteps(step.key, next)}
                                onRemove={() => removeStep(step.key)}
                            />
                        )}
                        <p className="text-xs text-content-subtle">{t('advisoryOrder')}</p>
                    </aside>
                )}
            </div>

            <CompiledPanel preview={preview} toolStates={toolStates} stale={changed} />
        </div>
    );
}

function StepInspector({
    step,
    draft,
    grants,
    subagentOptions,
    problems,
    describe,
    onChange,
    onNextSteps,
    onRemove,
}: {
    step: FlowDraftNode;
    draft: FlowDraft;
    grants: string[];
    subagentOptions: AgentFlowEditorProps['subagentOptions'];
    problems: FlowDiagnostic[];
    describe: (d: FlowDiagnostic) => string;
    onChange: (patch: Partial<FlowDraftNode>) => void;
    onNextSteps: (next: string[]) => void;
    onRemove: () => void;
}) {
    const tStep = useTranslations('agentFlow');
    // The tool picker lists the agent's GRANTS of this step's kind — never the
    // catalogue — so a step cannot name a tool the save would refuse.
    const toolOptions: ComboboxOption[] =
        step.kind === 'read' || step.kind === 'propose'
            ? grants.filter((g) => mcpToolCapabilityClass(g) === step.kind).map((g) => ({ value: g, label: g }))
            : [];
    const profileOptions: ComboboxOption[] = subagentOptions.map((o) => ({
        value: o.profileId,
        label: tStep('profileOption', { name: o.agentName, version: o.version }),
    }));
    const nextOptions: ComboboxOption[] = draft.nodes
        .filter((n) => n.key !== step.key)
        .map((n) => ({ value: n.key, label: `${n.label} (${n.key})` }));
    const nextSelected = nextOptions.filter((o) => draft.edges.some((e) => e.from === step.key && e.to === o.value));

    return (
        <div className="space-y-default" data-testid={`agent-flow-inspector-${step.key}`}>
            <p className="text-xs uppercase text-content-subtle">
                {tStep(`kind.${step.kind}`)} · {step.key}
            </p>
            <FormField label={tStep('field.label')}>
                <Input
                    id="agent-flow-step-label"
                    value={step.label}
                    onChange={(e) => onChange({ label: e.target.value })}
                />
            </FormField>
            {(step.kind === 'read' || step.kind === 'propose') && (
                <FormField label={tStep('field.tool')} hint={tStep('field.toolHint')}>
                    <Combobox
                        id="agent-flow-step-tool"
                        options={toolOptions}
                        selected={toolOptions.find((o) => o.value === step.tool) ?? null}
                        setSelected={(o) => onChange({ tool: o?.value })}
                        placeholder={tStep('field.toolPlaceholder')}
                        emptyState={tStep('field.noToolsHint')}
                    />
                </FormField>
            )}
            {step.kind === 'subagent' && (
                <FormField label={tStep('field.profile')}>
                    <Combobox
                        id="agent-flow-step-profile"
                        options={profileOptions}
                        selected={profileOptions.find((o) => o.value === step.profileRef) ?? null}
                        setSelected={(o) => onChange({ profileRef: o?.value })}
                        placeholder={tStep('field.profilePlaceholder')}
                        emptyState={tStep('field.noProfilesHint')}
                    />
                </FormField>
            )}
            <FormField label={tStep('field.next')}>
                <Combobox
                    id="agent-flow-step-next"
                    multiple
                    options={nextOptions}
                    selected={nextSelected}
                    setSelected={(opts) => onNextSteps(opts.map((o) => o.value))}
                    placeholder={tStep('field.nextPlaceholder')}
                />
            </FormField>
            {problems.map((d) => (
                <InlineNotice key={d.code} variant="warning" data-testid={`agent-flow-diagnostic-${d.code}`}>
                    {describe(d)}
                </InlineNotice>
            ))}
            <Button variant="secondary" size="sm" onClick={onRemove} data-testid="agent-flow-remove-step">
                {tStep('removeStep')}
            </Button>
        </div>
    );
}

function CompiledPanel({
    preview,
    toolStates,
    stale,
}: {
    preview: FlowRunPreview;
    toolStates: AgentCanvasProfileToolState[] | null;
    stale: boolean;
}) {
    const tPanel = useTranslations('agentFlow');
    // The omission reasons are worded once, on the agent view, for both.
    const tCanvas = useTranslations('agentCanvas');
    return (
        <section className="space-y-default" data-testid="agent-flow-compiled">
            <Heading level={2}>{tPanel('compiled.title')}</Heading>
            {stale && (
                <InlineNotice variant="info" data-testid="agent-flow-compiled-stale">
                    {tPanel('compiled.stale')}
                </InlineNotice>
            )}
            {preview.state !== 'SHOWN' ? (
                <InlineNotice variant="warning" data-testid="agent-flow-compiled-absent">
                    {tPanel(`compiled.${preview.state}`)}
                </InlineNotice>
            ) : (
                <>
                    {preview.runRefused !== null ? (
                        // Never "a run receives this message" for a version
                        // admission refuses on every engine.
                        <InlineNotice variant="warning" data-testid="agent-flow-compiled-refused">
                            {tPanel(`compiled.refused.${preview.runRefused}`, { version: preview.version })}
                        </InlineNotice>
                    ) : (
                        <p className="text-sm text-content-muted" data-testid="agent-flow-compiled-run-as">
                            {tPanel(`compiled.runAs.${preview.runAs ?? 'NONE'}`, { version: preview.version })}
                            {preview.readOnly ? ` ${tPanel('compiled.readOnly')}` : ''}
                        </p>
                    )}
                    <pre
                        className="whitespace-pre-wrap rounded-md border border-border-subtle bg-bg-subtle p-3 text-xs text-content-default"
                        data-testid="agent-flow-compiled-message"
                    >
                        {preview.message}
                    </pre>
                </>
            )}
            {toolStates !== null && (
                <ul className="space-y-tight text-sm" data-testid="agent-flow-compiled-tools">
                    {toolStates.map((s) => (
                        <li key={s.name} data-testid={`agent-flow-compiled-tool-${s.name}`}>
                            <span className="font-medium">{s.name}</span>{' '}
                            {s.offered ? tPanel('compiled.offered') : tCanvas(`reason.${s.reason}`)}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
