/**
 * Digest Email Templates — Grouped Notification Templates
 *
 * Templates for owner-grouped digest notifications sent from
 * periodic monitoring jobs. Each template renders multiple
 * DueItems for a single recipient into one consolidated email.
 *
 * Digest types:
 *   - DEADLINE_DIGEST  — controls, policies, tasks, risks, test plans
 *   - EVIDENCE_EXPIRY_DIGEST — evidence expiring/expired
 *   - VENDOR_RENEWAL_DIGEST — vendor reviews/renewals
 *
 * @module app-layer/notifications/digest-templates
 */

import type { DueItem, DueItemUrgency, MonitoredEntityType } from '../jobs/types';

export interface EmailTemplateResult {
    subject: string;
    bodyText: string;
    bodyHtml: string;
}

// ─── Shared Helpers ─────────────────────────────────────────────────

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const URGENCY_EMOJI: Record<DueItemUrgency, string> = {
    OVERDUE: '🔴',
    URGENT: '🟡',
    UPCOMING: '🟢',
};

const URGENCY_COLOR: Record<DueItemUrgency, string> = {
    OVERDUE: '#ef4444',
    URGENT: '#f59e0b',
    UPCOMING: '#10b981',
};

const URGENCY_LABEL: Record<DueItemUrgency, string> = {
    OVERDUE: 'Overdue',
    URGENT: 'Due Soon',
    UPCOMING: 'Upcoming',
};

const ENTITY_LABEL: Record<MonitoredEntityType, string> = {
    CONTROL: 'Control',
    EVIDENCE: 'Evidence',
    POLICY: 'Policy',
    VENDOR: 'Vendor',
    TASK: 'Task',
    RISK: 'Risk',
    TEST_PLAN: 'Test Plan',
    TREATMENT_PLAN: 'Treatment Plan',
    TREATMENT_MILESTONE: 'Treatment Milestone',
    AUDIT_CYCLE: 'Audit Cycle',
    FINDING: 'Finding',
};

const ENTITY_PATH: Record<MonitoredEntityType, string> = {
    CONTROL: 'controls',
    EVIDENCE: 'evidence',
    POLICY: 'policies',
    VENDOR: 'vendors',
    TASK: 'tasks',
    RISK: 'risks',
    TEST_PLAN: 'controls', // test plans live under controls
    // Both treatment-plan + milestone deep-link to the parent risk's
    // detail page where the treatment-plan card surfaces them.
    TREATMENT_PLAN: 'risks',
    TREATMENT_MILESTONE: 'risks',
    AUDIT_CYCLE: 'audits/cycles',
    // Findings have no detail route; the list page is the honest destination
    // (the calendar loader makes the same call for the same reason).
    FINDING: 'findings',
};

// ─── Text Rendering Helpers ─────────────────────────────────────────

function renderItemText(item: DueItem): string {
    const emoji = URGENCY_EMOJI[item.urgency];
    return `  ${emoji} ${item.name} — ${item.reason}`;
}

function renderItemHtml(item: DueItem, tenantSlug: string): string {
    const color = URGENCY_COLOR[item.urgency];
    const label = URGENCY_LABEL[item.urgency];
    const path = ENTITY_PATH[item.entityType];
    const entityLabel = ENTITY_LABEL[item.entityType];

    return `
<tr>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">
    <span style="display: inline-block; background: ${color}; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600;">${label}</span>
  </td>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666; font-size: 13px;">${escapeHtml(entityLabel)}</td>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">
    <a href="/t/${escapeHtml(tenantSlug)}/${path}" style="color: #4f46e5; text-decoration: none; font-weight: 500;">${escapeHtml(item.name)}</a>
  </td>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666; font-size: 13px;">${escapeHtml(item.reason)}</td>
</tr>`.trim();
}

// ─── Digest Table Builder ───────────────────────────────────────────

function buildDigestTable(items: DueItem[], tenantSlug: string): string {
    const rows = items.map(i => renderItemHtml(i, tenantSlug)).join('\n');
    return `
<table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
  <thead>
    <tr style="background: #f8fafc;">
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Status</th>
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Type</th>
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Name</th>
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Details</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>`.trim();
}

function summaryLine(items: DueItem[]): string {
    const overdue = items.filter(i => i.urgency === 'OVERDUE').length;
    const urgent = items.filter(i => i.urgency === 'URGENT').length;
    const upcoming = items.filter(i => i.urgency === 'UPCOMING').length;
    const parts: string[] = [];
    if (overdue > 0) parts.push(`🔴 ${overdue} overdue`);
    if (urgent > 0) parts.push(`🟡 ${urgent} due soon`);
    if (upcoming > 0) parts.push(`🟢 ${upcoming} upcoming`);
    return parts.join(', ');
}

// ─── Audience ───────────────────────────────────────────────────────

/**
 * WHY the reader was chosen, which is not the same as what is in the digest.
 *
 * `OWNER` — every item is assigned to this person. `TENANT_ADMIN` — the items
 * have NO owner, and the reader is receiving them because somebody has to see
 * work nobody has picked up (`digest-dispatcher`'s unowned fallback).
 *
 * Both audiences used to get the same sentence: "You have N item(s) that need
 * your attention". For an owner that is accurate. For an admin on the fallback
 * it describes work they were never assigned — and in production the fallback
 * is not the exception but the rule: 123 of 125 controls, 9 of 18 policies and
 * 4 of 4 risks have no owner, so almost every item an admin sees arrives
 * mislabelled as theirs. The report that opened #3165 was exactly that:
 * "people receive notifications of overdue policies when they are not assigned
 * on them".
 *
 * This is a copy change rather than a filter on purpose. Unowned overdue work
 * is a governance gap, and the digest is where it becomes visible — suppressing
 * it would be how an unowned overdue control stays overdue. What changes is
 * that the email now says which of the two things it is.
 */
export type DigestAudience = 'OWNER' | 'TENANT_ADMIN';

interface Lede {
    subject: string;
    /** The <h2>. A literal in every branch, so it is interpolated unescaped, as before. */
    heading: string;
    text: string;
    html: string;
}

interface LedeInput {
    audience: DigestAudience;
    count: number;
    /** What the items are called in prose: 'item(s)', 'evidence item(s)', 'vendor(s)'. */
    noun: string;
    urgencyMarker: string;
    /** The existing per-category copy, kept verbatim for the OWNER path. */
    owner: { subject: string; heading: string; text: string; html: string };
}

/**
 * The subject, heading and opening line for an audience.
 *
 * OWNER returns the caller's existing copy untouched, so a reader's filters and
 * mail threading do not move. TENANT_ADMIN leads with the absence of an owner,
 * because that is the actionable fact — the fix is to assign one, and that is
 * also what removes the item from this digest.
 */
function buildLede({ audience, count, noun, urgencyMarker, owner }: LedeInput): Lede {
    if (audience === 'TENANT_ADMIN') {
        const why =
            'You are receiving this as an admin of this workspace — not because '
            + 'these items are assigned to you. Assigning an owner moves an item '
            + 'out of this list and into theirs.';
        return {
            subject: `${urgencyMarker}Unassigned: ${count} ${noun} need an owner`,
            heading: 'Unassigned Compliance Items',
            text: `${count} ${noun} in this workspace have no owner assigned. ${why}`,
            html: `<strong>${count} ${noun}</strong> in this workspace have no owner assigned. ${why}`,
        };
    }
    return {
        subject: `${urgencyMarker}${owner.subject}`,
        heading: `${urgencyMarker}${owner.heading}`,
        text: owner.text,
        html: owner.html,
    };
}

// ─── Deadline Digest ────────────────────────────────────────────────

export interface DeadlineDigestPayload {
    recipientName: string;
    tenantSlug: string;
    items: DueItem[];
    /** Why this reader was chosen — decides whether the copy claims the items are theirs. */
    audience: DigestAudience;
}

export function buildDeadlineDigestEmail(payload: DeadlineDigestPayload): EmailTemplateResult {
    const { recipientName, tenantSlug, items, audience } = payload;
    const summary = summaryLine(items);
    const overdue = items.filter(i => i.urgency === 'OVERDUE').length;
    const urgencyMarker = overdue > 0 ? '🔴 ' : '';
    const lede = buildLede({
        audience,
        count: items.length,
        noun: 'item(s)',
        urgencyMarker,
        owner: {
            subject: `Compliance Deadline Digest: ${items.length} item(s) need attention`,
            heading: 'Compliance Deadline Digest',
            text: `You have ${items.length} item(s) that need attention:`,
            html: `You have <strong>${items.length} item(s)</strong> that need your attention:`,
        },
    });

    return {
        subject: lede.subject,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            lede.text,
            summary,
            '',
            ...items.map(renderItemText),
            '',
            `View your dashboard: /t/${tenantSlug}/dashboard`,
            '',
            '— Inflect Compliance',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 8px;">${lede.heading}</h2>
  <p style="color: #666; font-size: 14px; margin-bottom: 16px;">${escapeHtml(summary)}</p>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">${lede.html}</p>
  ${buildDigestTable(items, tenantSlug)}
  <a href="/t/${escapeHtml(tenantSlug)}/dashboard" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; margin-top: 8px;">View Dashboard</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Inflect Compliance</p>
</div>`.trim(),
    };
}

// ─── Evidence Expiry Digest ─────────────────────────────────────────

export interface EvidenceExpiryDigestPayload {
    recipientName: string;
    tenantSlug: string;
    items: DueItem[];
    /** Why this reader was chosen — decides whether the copy claims the items are theirs. */
    audience: DigestAudience;
}

export function buildEvidenceExpiryDigestEmail(payload: EvidenceExpiryDigestPayload): EmailTemplateResult {
    const { recipientName, tenantSlug, items, audience } = payload;
    const expired = items.filter(i => i.urgency === 'OVERDUE').length;
    const urgencyMarker = expired > 0 ? '⚠️ ' : '';
    const lede = buildLede({
        audience,
        count: items.length,
        noun: 'evidence item(s)',
        urgencyMarker,
        owner: {
            subject: `Evidence Expiry Alert: ${items.length} item(s) expiring`,
            heading: 'Evidence Expiry Alert',
            text: `${items.length} evidence item(s) are expiring or have expired:`,
            html: `<strong>${items.length} evidence item(s)</strong> are expiring or have expired:`,
        },
    });

    return {
        subject: lede.subject,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            lede.text,
            '',
            ...items.map(renderItemText),
            '',
            'Please upload refreshed evidence or extend retention dates.',
            '',
            `View evidence: /t/${tenantSlug}/evidence`,
            '',
            '— Inflect Compliance',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 8px;">${lede.heading}</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">${lede.html}</p>
  ${buildDigestTable(items, tenantSlug)}
  <p style="color: #444; line-height: 1.5;">Please upload refreshed evidence or extend retention dates.</p>
  <a href="/t/${escapeHtml(tenantSlug)}/evidence" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; margin-top: 8px;">View Evidence</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Inflect Compliance</p>
</div>`.trim(),
    };
}

// ─── Vendor Renewal Digest ──────────────────────────────────────────

export interface VendorRenewalDigestPayload {
    recipientName: string;
    tenantSlug: string;
    items: DueItem[];
    /** Why this reader was chosen — decides whether the copy claims the items are theirs. */
    audience: DigestAudience;
}

export function buildVendorRenewalDigestEmail(payload: VendorRenewalDigestPayload): EmailTemplateResult {
    const { recipientName, tenantSlug, items, audience } = payload;
    const overdue = items.filter(i => i.urgency === 'OVERDUE').length;
    const urgencyMarker = overdue > 0 ? '🔴 ' : '';
    const lede = buildLede({
        audience,
        count: items.length,
        noun: 'vendor(s)',
        urgencyMarker,
        owner: {
            subject: `Vendor Renewal Alert: ${items.length} vendor(s) need attention`,
            heading: 'Vendor Renewal Alert',
            text: `${items.length} vendor(s) have upcoming or overdue reviews/renewals:`,
            html: `<strong>${items.length} vendor(s)</strong> have upcoming or overdue reviews/renewals:`,
        },
    });

    return {
        subject: lede.subject,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            lede.text,
            '',
            ...items.map(renderItemText),
            '',
            `View vendors: /t/${tenantSlug}/vendors`,
            '',
            '— Inflect Compliance',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 8px;">${lede.heading}</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">${lede.html}</p>
  ${buildDigestTable(items, tenantSlug)}
  <a href="/t/${escapeHtml(tenantSlug)}/vendors" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; margin-top: 8px;">View Vendors</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Inflect Compliance</p>
</div>`.trim(),
    };
}
