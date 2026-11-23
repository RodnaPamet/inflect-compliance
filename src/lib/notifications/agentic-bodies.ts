/**
 * The agentic notifications' bodies — the English the emitter STORES, and how
 * a reader's bell reads it back in the reader's language.
 *
 * A bell row is written once, at emit time, for recipients whose language the
 * server does not know, so `Notification.message` carries English prose. Each
 * type's body is one fixed sentence with two slots — the SUBJECT (an agent's
 * name, "Every agent in this workspace", `The tool "<name>"`) and an optional
 * type-specific DETAIL — and every piece of English that fills a slot is
 * built here too. So the stored text is enough structure to re-render: the
 * type says which sentence it is, the sentence's fixed text finds the slots,
 * and each slot is either a phrase this module wrote (translated) or a name a
 * person chose (shown as written).
 *
 * That is why there is no new column and no migration: rows written before
 * this module existed carry the same bytes, because the emitter has always
 * produced them from these same pieces, and they render translated too. A
 * stored body this module cannot read — written by a future emitter, or with a
 * detail it does not know — is shown exactly as stored. Nothing is rewritten.
 *
 * Client-safe on purpose — no server imports — since the bell and the
 * notifications page read it, and the emitter writes through it.
 */
import type { AgenticNotificationKind } from './agentic-titles';

// ─── The sentences ──────────────────────────────────────────────────

interface BodyShape {
    /** Text before the subject. */
    readonly lead: string;
    /** Text between the subject and the detail slot. */
    readonly mid: string;
    /** The detail slot: how it is opened and closed, and what stands in for none. */
    readonly detail: { readonly open: string; readonly close: string; readonly none: string } | null;
    /** Text after the detail slot. */
    readonly tail: string;
}

const SHAPES: Readonly<Record<AgenticNotificationKind, BodyShape>> = {
    AGENT_KILL_SWITCH_ENGAGED: {
        lead: '',
        mid:
            ' is stopped at the tool boundary, including runs already in flight. ' +
            'Its registered status is unchanged — lift the kill switch to let it act again.',
        detail: null,
        tail: '',
    },
    AGENT_PROPOSAL_QUARANTINED: {
        lead: 'The output guard refused a write from ',
        mid:
            '. Quarantine is terminal — the proposal cannot be approved. Read the attempted ' +
            'content before deciding whether the agent should keep running.',
        detail: null,
        tail: '',
    },
    AGENT_CIRCUIT_BREAKER_TRIPPED: {
        lead: '',
        mid: ' was stopped automatically by its behavioural circuit breaker',
        detail: { open: ' — firing signals: ', close: '', none: '' },
        tail: '. It cannot act at the tool boundary until somebody closes the breaker with a reason.',
    },
    AGENT_TOOL_MANIFEST_PIN_CHANGED: {
        lead: '',
        mid: " was accepted for every agent in this workspace, clearing the tool boundary's refusal",
        detail: { open: ' (', close: ')', none: '' },
        tail:
            ". A tool's description is instruction text the model reads, so an approval nobody " +
            'expected is a supply-chain event — check who approved it and why.',
    },
    AGENT_RISK_ASSESSMENT_STALE: {
        lead: '',
        mid: ' has been widened since its risk assessment was completed',
        detail: { open: ' — ', close: '', none: '' },
        tail:
            '. Its tier has already been re-scored from the answers on file, so the ceiling is ' +
            'current; what may no longer hold are the answers themselves. Re-assess it.',
    },
    AGENT_OWNER_DEPARTED: {
        lead: 'The accountable owner of ',
        mid: ' is no longer an active member of this workspace, or their HR record is terminated',
        detail: { open: ' — ', close: '', none: '.' },
        tail:
            ' Its ownership moves only by a two-step transfer: an OWNER proposes the new owner ' +
            'and the new owner accepts.',
    },
};

/** The English body the emitter stores. */
export function agenticBodyText(kind: AgenticNotificationKind, subject: string, detail: string | null): string {
    const s = SHAPES[kind];
    const slot = s.detail === null ? '' : detail === null ? s.detail.none : `${s.detail.open}${detail}${s.detail.close}`;
    return `${s.lead}${subject}${s.mid}${slot}${s.tail}`;
}

// ─── The phrases that fill the slots ────────────────────────────────

/** Subjects the product writes. Anything else in the slot is a name. */
export const AGENTIC_SUBJECT = {
    EVERY_AGENT: 'Every agent in this workspace',
    UNATTRIBUTED_CREDENTIAL: 'an unattributed credential',
} as const;

/** The subject of a manifest-pin bell: the tool's NAME and nothing else. */
export function toolSubject(toolName: string): string {
    return `The tool "${toolName}"`;
}

/** The subject when an agent id resolves to no name. */
export function agentIdSubject(agentId: string): string {
    return `Agent ${agentId}`;
}

/** The manifest-pin detail: a first approval, or which revision replaced one. */
export function pinDetail(revision: number | null): string {
    return revision === null
        ? 'first approval for this tool'
        : `revision ${revision}, replacing the definition previously on file`;
}

/** What the owner-orphan pass did, per outcome — the bell's detail sentence. */
export const ORPHAN_DETAIL = {
    WOULD_SUSPEND_AND_KILL:
        'the owner-orphan pass is in DRY_RUN, so it was NOT stopped. At AUTOMATIC it ' +
        'would be suspended and its kill switch engaged.',
    KILL_FAILED:
        'the owner-orphan pass could NOT engage its kill switch, so it may still be acting. ' +
        'Stop it by hand and check the pass record.',
    SUSPEND_FAILED:
        'the owner-orphan pass engaged its kill switch (OWNER_DEPARTED) but could not suspend ' +
        'it. Check the pass record.',
    CONTAINED:
        'the owner-orphan pass suspended it and engaged its kill switch (OWNER_DEPARTED). ' +
        'The kill lifts only after a completed ownership transfer, by the new owner.',
} as const;

/** The staleness axes, as `agent-assessment-staleness.ts` names them in its detail. */
export const STALE_AXES = ['autonomyLevel', 'dataAccessScope', 'reversibility', 'provenance', 'modelRef'] as const;
const STALE_GRANTED_PREFIX = 'granted since scoring: ';
const STALE_NONE = '(none)';

/** The breaker's trip reasons that a bell can name. */
export const BREAKER_SIGNAL_CODES = [
    'PROPOSAL_RATE',
    'REJECTION_RATE',
    'TOOL_MIX',
    'GUARD_BLOCK',
    'BEHAVIOUR_ANOMALY',
] as const;

// ─── Reading a stored body back ─────────────────────────────────────

export interface ParsedAgenticBody {
    readonly subject: string;
    readonly detail: string | null;
}

/** The slots of a stored body, or null when it is not this type's sentence. */
export function parseAgenticBody(kind: AgenticNotificationKind, message: string): ParsedAgenticBody | null {
    const s = SHAPES[kind];
    if (!message.startsWith(s.lead) || !message.endsWith(s.tail)) return null;
    const inner = message.slice(s.lead.length, message.length - s.tail.length);
    const at = inner.indexOf(s.mid);
    if (at <= 0) return null;
    const subject = inner.slice(0, at);
    const rest = inner.slice(at + s.mid.length);
    if (s.detail === null) return rest === '' ? { subject, detail: null } : null;
    if (rest === s.detail.none) return { subject, detail: null };
    if (!rest.startsWith(s.detail.open) || !rest.endsWith(s.detail.close)) return null;
    const detail = rest.slice(s.detail.open.length, rest.length - s.detail.close.length);
    return detail === '' ? null : { subject, detail };
}

/** A translator rooted at `notificationBodies`. */
export type BodyTranslator = (key: string, values?: Record<string, string | number>) => string;

const AGENT_ID = /^Agent (c[a-z0-9]{20,})$/;
const TOOL = /^The tool "(.*)"$/;

function subjectText(subject: string, t: BodyTranslator): string {
    if (subject === AGENTIC_SUBJECT.EVERY_AGENT) return t('subject.everyAgent');
    if (subject === AGENTIC_SUBJECT.UNATTRIBUTED_CREDENTIAL) return t('subject.unattributedCredential');
    const tool = TOOL.exec(subject);
    if (tool) return t('subject.tool', { name: tool[1] });
    const id = AGENT_ID.exec(subject);
    if (id) return t('subject.agentId', { id: id[1] });
    return subject; // An agent's name, as its owner wrote it.
}

function detailText(kind: AgenticNotificationKind, detail: string, t: BodyTranslator): string | null {
    switch (kind) {
        case 'AGENT_CIRCUIT_BREAKER_TRIPPED':
            return detail
                .split(', ')
                .map((code) =>
                    (BREAKER_SIGNAL_CODES as readonly string[]).includes(code) ? t(`signal.${code}`) : code,
                )
                .join(', ');
        case 'AGENT_TOOL_MANIFEST_PIN_CHANGED': {
            if (detail === pinDetail(null)) return t('pin.first');
            const m = /^revision (\d+), replacing the definition previously on file$/.exec(detail);
            return m ? t('pin.revision', { revision: m[1] }) : null;
        }
        case 'AGENT_RISK_ASSESSMENT_STALE': {
            const parts: string[] = [];
            for (const item of detail.split('; ')) {
                if (item.startsWith(STALE_GRANTED_PREFIX)) {
                    parts.push(t('stale.granted', { tools: item.slice(STALE_GRANTED_PREFIX.length) }));
                    continue;
                }
                const m = /^(\w+) (.*) → (.*)$/.exec(item);
                if (!m || !(STALE_AXES as readonly string[]).includes(m[1])) return null;
                const value = (v: string) => (v === STALE_NONE ? t('stale.none') : v);
                parts.push(t('stale.moved', { axis: t(`stale.axis.${m[1]}`), from: value(m[2]), to: value(m[3]) }));
            }
            return parts.join('; ');
        }
        case 'AGENT_OWNER_DEPARTED': {
            const key = (Object.keys(ORPHAN_DETAIL) as (keyof typeof ORPHAN_DETAIL)[]).find(
                (k) => ORPHAN_DETAIL[k] === detail,
            );
            return key ? t(`orphan.${key}`) : null;
        }
        default:
            return null;
    }
}

/**
 * The body to show. `t` is rooted at `notificationBodies`. A body that is not
 * one of the agentic sentences, or whose detail this module did not write, is
 * shown as stored.
 */
export function localizedNotificationBody(type: string, storedMessage: string, t: BodyTranslator): string {
    if (!Object.prototype.hasOwnProperty.call(SHAPES, type)) return storedMessage;
    const kind = type as AgenticNotificationKind;
    const parsed = parseAgenticBody(kind, storedMessage);
    if (parsed === null) return storedMessage;
    const subject = subjectText(parsed.subject, t);
    if (parsed.detail === null) return t(`body.${kind}`, { subject });
    const detail = detailText(kind, parsed.detail, t);
    if (detail === null) return storedMessage;
    return t(`bodyWithDetail.${kind}`, { subject, detail });
}
