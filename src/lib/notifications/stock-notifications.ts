/**
 * The product's stock notification sentences — the English an emitter STORES,
 * and how the bell and the `/notifications` page word it back in the reader's
 * language (#5929). The agentic notifications have their own pair of modules
 * (`./agentic-titles`, `./agentic-bodies`); this one holds every other
 * notification the product writes from a fixed template: assignment, review
 * request, task due, watched-task activity, the NIS2 gap-assessment
 * assignment, evidence review, vendor review and posture alerts, incident
 * reporting deadlines, an automation SLA breach, a SCIM AI-admin
 * deactivation, a framework update and an accepted A2A invitation.
 *
 * A row is written once, at emit time, for a recipient whose language the
 * server does not know (the UI locale is a per-browser cookie), so it carries
 * English. Each title and body here is a TEMPLATE with `{placeholders}`; the
 * emitter fills both through `stockNotificationTitle` / `stockNotificationText`,
 * and the reader recognises the row's KIND by its type, its title and its body
 * together, reads the placeholders back out, and renders the kind's catalogue
 * messages (`notificationTitles.stock.<KIND>`, `notificationBodies.stock.<KIND>`)
 * with them. So there is no new column and no migration, and rows written
 * before this module existed render translated too: the emitters have always
 * written these same bytes.
 *
 * Each English template is ALSO the `en` catalogue message for its kind
 * (`tests/unit/stock-notifications.test.ts` holds them equal), which is what
 * gives the mobile audit's leak detector a template to catch the English when
 * a page shows it as stored.
 *
 * A placeholder is either data (a record's key and title, a vendor's name, a
 * date — shown as written) or a phrase this module wrote (a question count, a
 * respondent group, a watched-task change, an incident report's name), which
 * is translated. A row that is no kind's, or whose phrase this module did not
 * write, is shown exactly as stored; a kind whose body may be a person's own
 * text (`freeBody`: a reviewer's comment, a rule's configured message) has its
 * title worded and that body shown as written. Nothing is rewritten.
 *
 * Client-safe on purpose — no server imports — since the bell and the
 * notifications page read it, and the emitters write through it. The bell
 * loads it on demand: it is on every page, and these templates do not belong
 * in every route's First Load JS.
 */

interface StockSentence {
    /** The row's `NotificationType`. */
    readonly type: string;
    readonly title: string;
    readonly body: string;
    /** The body may instead be a person's own text, shown as written. */
    readonly freeBody?: true;
}

const sentences = <K extends string>(m: Record<K, StockSentence>): Readonly<Record<K, StockSentence>> => m;

/** `{label} is now yours.` — the assignment body, for every assignable record. */
const NOW_YOURS = '{label} is now yours.';
const FRAMEWORK_UPDATED = '{framework} updated to v{version}';

export const STOCK_NOTIFICATIONS = sentences({
    TASK_ASSIGNED: { type: 'TASK_ASSIGNED', title: 'You were assigned a task', body: NOW_YOURS },
    CONTROL_ASSIGNED: { type: 'CONTROL_ASSIGNED', title: 'You were assigned a control', body: NOW_YOURS },
    RISK_ASSIGNED: { type: 'RISK_ASSIGNED', title: 'You were assigned a risk', body: NOW_YOURS },
    ASSET_ASSIGNED: { type: 'ASSET_ASSIGNED', title: 'You were assigned an asset', body: NOW_YOURS },
    TASK_REVIEW_REQUESTED: {
        type: 'TASK_REVIEW_REQUESTED',
        title: 'A task is awaiting your review',
        // Says WHY it is theirs: the sign-off gate refuses everyone else.
        body: '{label} is ready for your sign-off — only you can complete it.',
    },
    TASK_DUE_WEEK: { type: 'TASK_DUE', title: 'Task due in one week', body: '{label} is due in one week.' },
    TASK_DUE_DAY: { type: 'TASK_DUE', title: 'Task due tomorrow', body: '{label} is due tomorrow.' },
    TASK_DUE_TODAY: { type: 'TASK_DUE', title: 'Task due today', body: '{label} is due today.' },
    TASK_WATCH_UPDATE: { type: 'TASK_WATCH_UPDATE', title: 'Watched task updated', body: '{label}: {detail}' },
    NIS2_GAP_ASSIGNED: {
        type: 'GENERAL',
        title: 'NIS2 gap assessment assigned',
        body: 'You have {count} to answer in the NIS2 gap assessment, for {group}.',
    },
    EVIDENCE_APPROVED: {
        type: 'EVIDENCE_APPROVED',
        title: 'Evidence approved: {title}',
        body: 'Your evidence "{title}" has been approved.',
        freeBody: true,
    },
    EVIDENCE_REJECTED: {
        type: 'EVIDENCE_REJECTED',
        title: 'Evidence rejected: {title}',
        body: 'Your evidence "{title}" has been rejected.',
        freeBody: true,
    },
    VENDOR_REVIEW_PAST_DUE: {
        type: 'VENDOR_REVIEW_DUE',
        title: 'Vendor review due: {name}',
        body: 'Vendor "{name}" is past its scheduled review date. Re-assess the vendor or extend the review date.',
    },
    VENDOR_BREACH: {
        type: 'VENDOR_POSTURE_ALERT',
        title: 'Vendor breach: {name}',
        body: 'Vendor domain {domain} appeared in a breach ({date})',
        freeBody: true,
    },
    VENDOR_ATTESTATION_EXPIRED: {
        type: 'VENDOR_POSTURE_ALERT',
        title: 'Vendor attestation expired: {name}',
        body: '{attestation} expired (period ended {date}) — assessment is stale',
        freeBody: true,
    },
    INCIDENT_DEADLINE_DUE: {
        type: 'INCIDENT_DEADLINE_DUE',
        title: 'Deadline approaching: {report} for {reference}',
        body: 'The NIS2 Article 23 {reportLower} for incident {reference} is approaching. Prepare to file.',
    },
    INCIDENT_DEADLINE_OVERDUE: {
        type: 'INCIDENT_DEADLINE_OVERDUE',
        title: 'OVERDUE: {report} for {reference}',
        body: 'The NIS2 Article 23 {reportLower} for incident {reference} has passed without a filed report. File it now.',
    },
    AUTOMATION_SLA_BREACH: {
        type: 'GENERAL',
        title: 'Automation SLA breached',
        body: "An automation rule's {minutes}m SLA window was breached.",
        freeBody: true,
    },
    SCIM_AI_ADMIN_DEACTIVATED: {
        type: 'GENERAL',
        title: 'An AI admin was deactivated by your directory',
        body:
            '{who} was deactivated in this workspace by your identity provider (SCIM). ' +
            'They held the AI admin role. Review the agents they own on the agent register.',
    },
    FRAMEWORK_UPDATED: { type: 'GENERAL', title: FRAMEWORK_UPDATED, body: '{added} new requirement(s) affect you.' },
    FRAMEWORK_UPDATED_REVIEW: {
        type: 'GENERAL',
        title: FRAMEWORK_UPDATED,
        body: '{added} new requirement(s) affect you, {flagged} control(s) need re-review.',
    },
    A2A_INVITATION_ACCEPTED: {
        type: 'GENERAL',
        title: '{name} accepted your A2A invitation',
        body: 'Read its agent card and approve it to start exchanging tasks. Nothing is exchanged until you do.',
    },
});

export type StockNotificationKind = keyof typeof STOCK_NOTIFICATIONS;

const KINDS = Object.keys(STOCK_NOTIFICATIONS) as StockNotificationKind[];

const fill = (template: string, params: Readonly<Record<string, string | number>>): string =>
    template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]));

/** A kind's English title: what the emitter stores. */
export const stockNotificationTitle = (kind: StockNotificationKind, params: Readonly<Record<string, string | number>> = {}) =>
    fill(STOCK_NOTIFICATIONS[kind].title, params);

/** A kind's English body: what the emitter stores. */
export const stockNotificationText = (kind: StockNotificationKind, params: Readonly<Record<string, string | number>> = {}) =>
    fill(STOCK_NOTIFICATIONS[kind].body, params);

/** A record as a body names it: `T-12 "Rotate keys"`, or `"Rotate keys"` with no key. */
export function recordLabel(title: string, key?: string | null): string {
    return key ? `${key} "${title}"` : `"${title}"`;
}

// ─── The phrases that fill the slots ────────────────────────────────

/** NIS2 respondent groups, as the assignment names them. */
export const NIS2_GROUP = {
    CEO: 'leadership',
    IT: 'IT',
    HR: 'HR',
    PROCUREMENT: 'procurement',
    ANYONE: 'anyone in the organisation',
} as const;

/** How many questions an NIS2 assignment holds. */
export const nis2QuestionCount = (n: number): string => (n === 1 ? '1 question' : `${n} questions`);

/** What happened to a watched task, for the changes a watcher's bell names in words. */
export const WATCH_DETAIL = {
    commented: 'new comment added',
    reassigned: 'reassigned',
    unassigned: 'unassigned',
    reviewerReassigned: 'reviewer reassigned',
    reviewerCleared: 'reviewer cleared',
} as const;

/** A watched task's status change: `status changed OPEN → IN_PROGRESS`. */
export const watchStatusDetail = (from: string, to: string): string => `status changed ${from} → ${to}`;

/** What a due-date change names when there is no date on one side. */
export const NO_DUE_DATE = 'no due date';

/** A watched task's due-date change, `YYYY-MM-DD` either side: `due 2026-11-01 → 2026-12-01`. */
export const watchDueDetail = (from: string | null, to: string | null): string =>
    `due ${from ?? NO_DUE_DATE} → ${to ?? NO_DUE_DATE}`;

/** Several changes to one watched task, in one body. */
export const WATCH_DETAIL_SEPARATOR = ', ';

/** Task statuses a status-change body may name (`TaskStatus`). */
const TASK_STATUSES = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'RESOLVED', 'CLOSED', 'CANCELED'];

/** The NIS2 Article 23 reports an incident deadline names (`IncidentNotificationKind`). */
export const INCIDENT_REPORT = {
    EARLY_WARNING_24H: '24-hour early warning',
    DETAILED_72H: '72-hour detailed report',
    FINAL_1MONTH: '1-month final report',
} as const;

/** Who a SCIM deactivation names when the person has neither a name nor an e-mail. */
export const SOMEBODY = 'A member';

/** What an expired attestation is called when its report type is not recorded. */
export const ATTESTATION = 'Attestation';

// ─── Reading a stored row back ──────────────────────────────────────

/** A translator rooted at `notificationTitles` or `notificationBodies`. */
export type StockTranslator = (key: string, values?: Record<string, string>) => string;

const keyOf = (map: Readonly<Record<string, string>>, value: string): string | undefined =>
    Object.keys(map).find((k) => map[k] === value);

/** The placeholders of a stored text, or null when it is not the template. */
export function parseStockTemplate(template: string, text: string): Record<string, string> | null {
    const names: string[] = [];
    const source = template
        .split(/\{(\w+)\}/)
        .map((part, i) => (i % 2 ? (names.push(part), '(.+)') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('');
    const m = new RegExp(`^${source}$`, 's').exec(text);
    return m ? Object.fromEntries(names.map((name, i) => [name, m[i + 1]])) : null;
}

/** A placeholder in the reader's language, or null when this module wrote it and cannot read it back. */
function slotText(name: string, value: string, t: StockTranslator): string | null {
    let key: string | undefined;
    switch (name) {
        case 'count': {
            const m = /^(\d+) questions?$/.exec(value);
            return m && value === nis2QuestionCount(Number(m[1]))
                ? t(`stock.count.${m[1] === '1' ? 'one' : 'other'}`, { n: m[1] })
                : null;
        }
        case 'group':
            key = keyOf(NIS2_GROUP, value);
            return key ? t(`stock.group.${key}`) : null;
        case 'detail': {
            const parts = value.split(WATCH_DETAIL_SEPARATOR).map((part) => changeText(part, t));
            return parts.includes(null) ? null : parts.join(WATCH_DETAIL_SEPARATOR);
        }
        case 'report':
        case 'reportLower':
            key = Object.keys(INCIDENT_REPORT).find((k) => {
                const words: string = INCIDENT_REPORT[k as keyof typeof INCIDENT_REPORT];
                return (name === 'report' ? words : words.toLowerCase()) === value;
            });
            return key ? t(`stock.report.${key}`) : null;
        case 'who':
            return value === SOMEBODY ? t('stock.somebody') : value;
        case 'attestation':
            return value === ATTESTATION ? t('stock.attestation') : value;
        default:
            return value; // A name, a key, a date or a count, as the record holds it.
    }
}

/** One change to a watched task in the reader's language, or null when this module did not write it. */
function changeText(value: string, t: StockTranslator): string | null {
    const key = keyOf(WATCH_DETAIL, value);
    if (key) return t(`stock.detail.${key}`);
    let m = /^status changed (\w+) → (\w+)$/.exec(value);
    if (m) {
        return TASK_STATUSES.includes(m[1]) && TASK_STATUSES.includes(m[2])
            ? t('stock.detail.status', { from: t(`stock.status.${m[1]}`), to: t(`stock.status.${m[2]}`) })
            : null;
    }
    const day = (v: string) => (v === NO_DUE_DATE ? t('stock.detail.noDueDate') : v);
    m = /^due (\d{4}-\d{2}-\d{2}|no due date) → (\d{4}-\d{2}-\d{2}|no due date)$/.exec(value);
    return m ? t('stock.detail.due', { from: day(m[1]), to: day(m[2]) }) : null;
}

function render(
    template: string,
    text: string,
    key: string,
    t: StockTranslator,
    slots: StockTranslator,
): string | undefined {
    const params = parseStockTemplate(template, text);
    if (!params) return undefined;
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(params)) {
        const shown = slotText(name, value, slots);
        if (shown === null) return undefined;
        values[name] = shown;
    }
    return t(key, values);
}

/**
 * A stored row in the reader's language, or undefined when it is no stock
 * kind (it is then another reader's, or shown as stored). `tTitles` is rooted
 * at `notificationTitles`, `tBodies` at `notificationBodies`, which also holds
 * the phrases that fill both.
 */
export function localizedStockNotification(
    row: { readonly type: string; readonly title: string; readonly message: string },
    tTitles: StockTranslator,
    tBodies: StockTranslator,
): { title: string; message: string } | undefined {
    for (const kind of KINDS) {
        const s = STOCK_NOTIFICATIONS[kind];
        if (s.type !== row.type) continue;
        const title = render(s.title, row.title, `stock.${kind}`, tTitles, tBodies);
        if (title === undefined) continue;
        const message = render(s.body, row.message, `stock.${kind}`, tBodies, tBodies);
        if (message !== undefined) return { title, message };
        // Two kinds may share a title (a framework update with and without
        // controls to re-review), so a body that is not this kind's may be
        // the next one's.
        if (s.freeBody) return { title, message: row.message };
    }
    return undefined;
}
