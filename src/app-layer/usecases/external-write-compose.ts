/**
 * A HUMAN COMPOSES AN EXTERNAL WRITE (#3301).
 *
 * ═══ WHAT THIS IS FOR ═══
 *
 * All twelve pages under `agents/` are governance over agent OUTPUT — a
 * review-and-approve console. No surface accepted an instruction. This is the
 * narrow intent surface the rest of the system already implies:
 *
 *   pick an approved template, fill the fields it OPENS, submit for approval.
 *
 * Not a chat box, and deliberately not. The reviewed template already exists
 * (`ExternalToolParameterSet` with `openFields`), so the operator is not
 * composing a tool call — they are filling the open fields of a shape somebody
 * already approved. A free-text intent layer above this is where a
 * prompt-injection path would enter, since the text would influence a tool call
 * against a directory; it is a separate, separately-reviewed question.
 *
 * ═══ IT ALWAYS PROPOSES, WHATEVER THE RUNG ═══
 *
 * The agent path branches on the connection's rung — DRY_RUN records,
 * PROPOSE_ONLY queues, AUTOMATIC opens an unattended journal row. This does
 * NOT: a human-originated intent always becomes a proposal subject to the
 * existing approval gate, even on an `AUTOMATIC` connection. #3301 is explicit
 * that the result is "a proposal subject to the existing approval gate, never a
 * direct dispatch", and the reason is four eyes: the person composing must not
 * also be the only person who saw it.
 *
 * ═══ THE NARROWING IS THE SAME NARROWING ═══
 *
 * Every check here is the primitive the agent path uses, not a second copy:
 *
 *   · `parseOpenFields`          — what the template opens
 *   · `refusalForValue`          — whether a supplied value is inside its bound
 *   · `checkTargetInPopulation`  — whether a subject is in the approved
 *                                  population, resolved from live data
 *
 * That matters more than the convenience. These are the teeth that make an
 * approved template a bound rather than a suggestion, and a surface with its
 * own copy of them is a surface that can drift into permitting what the agent
 * path refuses. The third was private to `external-tools.ts` until this issue
 * extracted it, which is why it is extracted rather than reimplemented.
 *
 * ═══ AND IT CANNOT WIDEN ═══
 *
 * Four refusals, in the agent path's own order: a key the template does not
 * open, a key that shadows an approved exact value, an open field left unfilled,
 * and a value outside its bound. The approved `parameters` are merged UNDER the
 * open values and never submitted by the caller at all — so there is no request
 * shape that edits the template.
 */
import { randomUUID } from 'node:crypto';

import { runInTenantContext } from '@/lib/db-context';
import { parseOpenFields, type OpenFields } from '@/lib/integrations/open-fields';
import { refusalForValue } from '@/lib/integrations/parameter-constraints';
import { parseExternalToolName } from '@/lib/mcp/external-tool-name';
import { callTool } from '@/app-layer/integrations/mcp/client';
import { authorizationFor } from '@/app-layer/integrations/mcp/token';
import { decryptField } from '@/lib/security/encryption';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { logger } from '@/lib/observability/logger';

import { assertCanRead, assertCanWrite } from '../policies/common';
import { createAgentProposal } from './agent-proposals';
import { getPriorStateRead } from './external-prior-state-read';
import {
    checkTargetInPopulation,
    resolveTargetPopulation,
    TARGET_POPULATIONS,
} from './external-tool-target-populations';
import type { RequestContext } from '../types';

/**
 * Why a compose was refused.
 *
 * Each is fixed by a different action, which is why they are not one
 * `invalid`: an unopened key means the operator sent something the form should
 * not have offered; a value refusal means they chose badly within a bound they
 * were shown; a population refusal means the subject is not theirs to name.
 */
export type ComposeRefusal =
    | { readonly kind: 'set_not_found' }
    | { readonly kind: 'open_fields_unreadable' }
    | { readonly kind: 'field_not_opened'; readonly field: string }
    | { readonly kind: 'field_shadows_value'; readonly field: string }
    | { readonly kind: 'field_missing'; readonly field: string }
    | { readonly kind: 'value_refused'; readonly field: string; readonly detail: string }
    | { readonly kind: 'target_refused'; readonly field: string; readonly detail: string }
    | { readonly kind: 'tool_name_unusable' }
    | { readonly kind: 'connection_unusable' }
    | { readonly kind: 'unpaired' }
    | { readonly kind: 'prior_state_unreadable'; readonly detail: string };

export function describeComposeRefusal(r: ComposeRefusal): string {
    switch (r.kind) {
        case 'set_not_found':
            return 'That template no longer exists in this workspace.';
        case 'open_fields_unreadable':
            return (
                'That template\'s open-field bounds cannot be read, so nothing can be checked '
                + 'against them. It must be re-proposed and re-approved before it can be used.'
            );
        case 'field_not_opened':
            return `This template does not open "${r.field}", so that value cannot be set here.`;
        case 'field_shadows_value':
            return (
                `"${r.field}" is both an approved exact value and an open field on this `
                + 'template. The open value would be merged over the approved one, so the '
                + 'approved value would never be sent while still reading as in force. Fix the '
                + 'template.'
            );
        case 'field_missing':
            return `This template requires a value for "${r.field}".`;
        case 'value_refused':
            return `"${r.field}" is outside what this template permits: ${r.detail}`;
        case 'target_refused':
            return `"${r.field}" — ${r.detail}`;
        case 'tool_name_unusable':
            return 'That template names a tool that is not a usable external tool name.';
        case 'connection_unusable':
            return (
                'The connection behind that template is missing, disabled, or its credentials '
                + 'cannot be read, so the prior state cannot be captured.'
            );
        case 'unpaired':
            return (
                'That tool has no prior-state read nominated, so what the write would replace '
                + 'cannot be recorded. Nominate one on the external-tools page first.'
            );
        case 'prior_state_unreadable':
            return (
                `The prior-state read could not be run (${r.detail}), so nothing was proposed. `
                + 'This is NOT "there is no prior state" — it is "we could not look".'
            );
        default: {
            const unreachable: never = r;
            return unreachable;
        }
    }
}

export type ComposeOutcome =
    | {
          readonly ok: true;
          readonly proposalId: string;
          readonly status: string;
          readonly guardVerdict: string | null;
      }
    | { readonly ok: false; readonly refusal: ComposeRefusal };

/** The operator-facing sentence for a target refusal, by kind. */
function targetDetail(
    m: Exclude<Awaited<ReturnType<typeof checkTargetInPopulation>>, { ok: true }>,
    population: string,
): string {
    switch (m.kind) {
        case 'not_a_string':
            return 'names the row this request is about, so it takes a non-empty identifier.';
        case 'unknown_key':
            return (
                `is bounded by the target population "${population}", which this build does not `
                + 'define. The template must be re-proposed and re-approved.'
            );
        case 'unresolvable':
            return (
                `could not be checked: the target population "${population}" could not be read `
                + `(${m.detail}). This is NOT "the value is not allowed".`
            );
        case 'too_large':
            return (
                `cannot be checked: the target population "${population}" returns more than `
                + `${m.cap} rows, so it cannot act as a bound.`
            );
        case 'empty':
            return (
                `has no candidates: the target population "${population}" currently contains no `
                + 'rows, so there is no subject this request may be about.'
            );
        case 'not_a_member':
            return (
                `must name a row in the approved population "${population}", which currently has `
                + `${m.size} member(s), and the value given is not one of them.`
            );
        default: {
            const unreachable: never = m;
            return unreachable;
        }
    }
}

/**
 * WHAT A COMPOSE FORM MAY OFFER (#3301).
 *
 * The template's open fields, and for a target field the candidate subjects
 * resolved from the approved population — labelled where the population knows
 * how, raw where it does not.
 *
 * RESOLVED PER REQUEST, never cached. The bound is DATA and data moves; a list
 * assembled once and reused would be a snapshot presented as a live bound, and
 * the first subject to leave the population would stay offerable. The submitted
 * value is re-checked at compose and again at dispatch, so this list is a
 * convenience for the operator and never the thing that decides.
 *
 * It carries NO approved parameter values. The form has no business rendering
 * them as editable, and a payload that included them would be one refactor from
 * a payload that accepted them back.
 */
export interface ComposeFieldOffer {
    readonly name: string;
    /** `target` when the field names the subject, otherwise the constraint kind. */
    readonly kind: string;
    /**
     * The candidates, for a target field only.
     *
     * `label` is the population's own rendering and falls back to the value, so
     * a picker always has something to show. `value` is what gets submitted —
     * the identifier the bound checks, never the label.
     */
    readonly candidates?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
    /** Present when the candidates could not be resolved, saying why. */
    readonly unavailable?: string;
}

export type ComposeOfferOutcome =
    | {
          readonly ok: true;
          readonly label: string;
          readonly toolName: string;
          readonly fields: readonly ComposeFieldOffer[];
      }
    | { readonly ok: false; readonly refusal: ComposeRefusal };

export async function listComposeOffer(
    ctx: RequestContext,
    parameterSetId: string,
): Promise<ComposeOfferOutcome> {
    // READ, not write: this only says what could be composed.
    assertCanRead(ctx);

    const set = await runInTenantContext(ctx, (db) =>
        db.externalToolParameterSet.findFirst({
            where: { id: parameterSetId, tenantId: ctx.tenantId },
            select: { label: true, toolName: true, openFields: true, targetPopulation: true },
        }),
    );
    if (!set) return { ok: false, refusal: { kind: 'set_not_found' } };

    const parsed = parseOpenFields(set.openFields ?? null, set.targetPopulation ?? null);
    if (parsed.state === 'unreadable') {
        return { ok: false, refusal: { kind: 'open_fields_unreadable' } };
    }
    const open: OpenFields = parsed.state === 'ok' ? parsed.fields : {};

    const fields: ComposeFieldOffer[] = [];
    for (const [name, constraint] of Object.entries(open)) {
        if (constraint.kind !== 'target') {
            fields.push({ name, kind: constraint.kind });
            continue;
        }
        const resolved = await resolveTargetPopulation(ctx, constraint.population);
        if (resolved.state !== 'ok') {
            // Each non-ok state says something different and the form must not
            // collapse them: "we could not look" sends an operator to the
            // database, "nothing matched" sends them to the roster.
            fields.push({
                name,
                kind: 'target',
                unavailable: describeComposeRefusal({
                    kind: 'target_refused',
                    field: name,
                    detail: targetDetail(
                        resolved.state === 'unresolvable'
                            ? { ok: false, kind: 'unresolvable', detail: resolved.detail }
                            : resolved.state === 'too_large'
                              ? { ok: false, kind: 'too_large', cap: resolved.cap }
                              : resolved.state === 'empty'
                                ? { ok: false, kind: 'empty' }
                                : { ok: false, kind: 'unknown_key' },
                        constraint.population,
                    ),
                }),
            });
            continue;
        }
        const values = [...resolved.values];
        const entry = TARGET_POPULATIONS[constraint.population];
        let labels: ReadonlyMap<string, string> = new Map();
        if (entry?.label) {
            try {
                labels = await entry.label(ctx, values);
            } catch (err) {
                // A failed LABEL must not lose the candidates. The picker can
                // show identifiers; it cannot show nothing because a join broke.
                logger.warn('compose offer: population labels unavailable', {
                    component: 'external-write-compose',
                    tenantId: ctx.tenantId,
                    population: constraint.population,
                    detail: err instanceof Error ? err.message : 'unreadable',
                });
            }
        }
        fields.push({
            name,
            kind: 'target',
            candidates: values.map((v) => ({ value: v, label: labels.get(v) ?? v })),
        });
    }

    return { ok: true, label: set.label, toolName: set.toolName, fields };
}

export async function composeExternalWriteProposal(
    ctx: RequestContext,
    input: { parameterSetId: string; openFieldValues: Record<string, unknown> },
): Promise<ComposeOutcome> {
    // WRITE, not admin. Composing is the lower bar on purpose: the proposal
    // reaches a reviewer who needs the authority to approve, and requiring that
    // authority to compose as well would make four eyes into two.
    assertCanWrite(ctx);

    const set = await runInTenantContext(ctx, (db) =>
        db.externalToolParameterSet.findFirst({
            where: { id: input.parameterSetId, tenantId: ctx.tenantId },
            select: {
                id: true,
                label: true,
                toolName: true,
                parameters: true,
                openFields: true,
                targetPopulation: true,
            },
        }),
    );
    if (!set) return { ok: false, refusal: { kind: 'set_not_found' } };

    const parsed = parseOpenFields(set.openFields ?? null, set.targetPopulation ?? null);
    if (parsed.state === 'unreadable') {
        return { ok: false, refusal: { kind: 'open_fields_unreadable' } };
    }
    const open: OpenFields = parsed.state === 'ok' ? parsed.fields : {};

    // The approved values, merged UNDER the open ones. The caller never submits
    // these, so there is no request that edits the template.
    const merged: Record<string, unknown> = {
        ...((set.parameters ?? {}) as Record<string, unknown>),
    };
    const supplied = Object.entries(input.openFieldValues);

    // 1. nothing the template does not open
    for (const [name] of supplied) {
        if (!(name in open)) {
            return { ok: false, refusal: { kind: 'field_not_opened', field: name } };
        }
    }
    // 2-4. every opened field, in the agent path's own order
    for (const [name, constraint] of Object.entries(open)) {
        if (name in merged) {
            return { ok: false, refusal: { kind: 'field_shadows_value', field: name } };
        }
        const entry = supplied.find(([k]) => k === name);
        if (entry === undefined) {
            return { ok: false, refusal: { kind: 'field_missing', field: name } };
        }
        if (constraint.kind === 'target') {
            // Resolved from LIVE data here and again at dispatch. A bound
            // resolved only now would be a snapshot presented as a live bound.
            const m = await checkTargetInPopulation(ctx, constraint.population, entry[1]);
            if (!m.ok) {
                return {
                    ok: false,
                    refusal: {
                        kind: 'target_refused',
                        field: name,
                        detail: targetDetail(m, constraint.population),
                    },
                };
            }
            merged[name] = entry[1];
            continue;
        }
        const refusal = refusalForValue(constraint, entry[1]);
        if (refusal) {
            return {
                ok: false,
                refusal: { kind: 'value_refused', field: name, detail: refusal.detail },
            };
        }
        merged[name] = entry[1];
    }

    const ref = parseExternalToolName(set.toolName);
    if (!ref) return { ok: false, refusal: { kind: 'tool_name_unusable' } };

    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: ref.connectionId, tenantId: ctx.tenantId, isEnabled: true },
            select: { id: true, name: true, configJson: true, secretEncrypted: true },
        }),
    );
    if (!connection) return { ok: false, refusal: { kind: 'connection_unusable' } };
    const url = ((connection.configJson ?? {}) as { url?: unknown }).url;
    if (typeof url !== 'string' || !url.trim()) {
        return { ok: false, refusal: { kind: 'connection_unusable' } };
    }

    let authorization: string | undefined;
    try {
        const secrets = connection.secretEncrypted
            ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
            : {};
        // The SHARED resolver, so this surface and the dispatch agree about what
        // a credential means — and so a connection configured for OAuth is not
        // silently sent a static header.
        authorization = await authorizationFor(
            connection.id,
            (connection.configJson ?? {}) as Record<string, unknown>,
            secrets,
        );
    } catch {
        return { ok: false, refusal: { kind: 'connection_unusable' } };
    }

    // THE PAIRED READ, before anything is proposed. `setPriorStateRead`'s rule
    // is that a write with no pairing is REFUSED, and that refusal is the
    // deliverable rather than a gap — so it is honoured here too, where the
    // proposal is made, and not left for the dispatch to discover.
    const pairing = await getPriorStateRead(ctx, set.toolName);
    if (!pairing) return { ok: false, refusal: { kind: 'unpaired' } };
    const readRef = parseExternalToolName(pairing.readToolName);
    if (!readRef) return { ok: false, refusal: { kind: 'tool_name_unusable' } };

    let priorState: unknown;
    try {
        priorState = await callTool(
            { url: url.trim(), authorization },
            readRef.toolName,
            merged,
        );
    } catch (err) {
        return {
            ok: false,
            refusal: {
                kind: 'prior_state_unreadable',
                detail: err instanceof Error ? err.message : 'unreadable',
            },
        };
    }

    const proposal = await createAgentProposal(ctx, {
        kind: 'EXTERNAL_WRITE',
        payload: {
            connectionId: connection.id,
            connectionName: connection.name,
            endpointUrl: url.trim(),
            toolName: set.toolName,
            advertisedToolName: ref.toolName,
            arguments: merged,
            priorState,
        },
        // NO AGENT, so NO CARD — and the sentinel rather than null, because the
        // row records that the question was asked and the answer was "none".
        // `resolvePolicyCardPin` returns exactly this for a human-started
        // proposal, without a query.
        policyCardVersion: NO_POLICY_CARD,
        // Which template was in force, so a reviewer sees what was filled in
        // rather than only the result.
        proposedBySessionRef: `compose:${set.label}:${randomUUID()}`,
    });

    logger.info('external write composed by a human', {
        component: 'external-write-compose',
        tenantId: ctx.tenantId,
        proposalId: proposal.id,
        parameterSetLabel: set.label,
        openFieldCount: Object.keys(open).length,
    });

    return {
        ok: true,
        proposalId: proposal.id,
        status: proposal.status,
        guardVerdict: proposal.guardVerdict ?? null,
    };
}
