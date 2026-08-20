'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { formatDate } from '@/lib/format-date';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useEntityListIds } from '@/lib/hooks/use-entity-list-ids';
import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { buttonVariants } from '@/components/ui/button-variants';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import type { PolicyDetailDTO, PolicyVersionDTO, AuditLogEntry } from '@/lib/dto';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { NumberStepper } from '@/components/ui/number-stepper';
import { sanitizeRichTextHtml } from '@/lib/security/sanitize';
import { enrichPolicyHtml, renderPolicyMarkdown } from '@/lib/policy/policy-content';
import type { RichTextContentType } from '@/components/ui/RichTextEditor';
import { ApprovalBanner } from '@/components/ui/ApprovalBanner';
import { VersionDiff } from '@/components/ui/VersionDiff';
import { PolicyAcknowledgementsPanel } from '@/components/policies/PolicyAcknowledgementsPanel';
import { AppIcon, type AppIconName } from '@/components/icons/AppIcon';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { MetaStrip } from '@/components/ui/meta-strip';
import { POLICY_STATUS_VARIANT } from '@/app-layer/domain/entity-status-mapping';
import { Card, cardVariants } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/hooks';
import { cn } from '@/lib/cn';
import { InheritedMappingsPanel } from '@/components/InheritedMappingsPanel';
import LinkedTasksPanel from '@/components/LinkedTasksPanel';
import { PolicySharePointSection } from './PolicySharePointSection';
import { PolicyEvidenceChecklist } from './PolicyEvidenceChecklist';

// Lazy-load loading states rendered via next-intl (module-scope dynamic()
// loading fns can't call the hook directly, so they route through a component).
function TraceabilityLoading() {
    const t = useTranslations('policies');
    return <div className="text-center text-content-subtle animate-pulse py-8">{t('detail.loadingTraceability')}</div>;
}
function EditorLoading() {
    const t = useTranslations('policies');
    return (
        <Card elevation="inset" density="compact" className="text-center text-sm text-content-muted">
            {t('detail.loadingEditor')}
        </Card>
    );
}

// Read-only traceability panel (linked controls + inherited risks/assets).
// Lazy — only the Traceability tab needs it.
const PolicyTraceabilityPanel = dynamic(() => import('@/components/PolicyTraceabilityPanel'), {
    ssr: false,
    loading: () => <TraceabilityLoading />,
});

// Lazy-load Tiptap. The editor + ProseMirror chunks land at
// ~200KB gzipped; deferring the import means the static parts of
// the policy detail page (current view, versions, activity) stay
// light unless the operator opens the Editor tab.
const RichTextEditor = dynamic(
    () => import('@/components/ui/RichTextEditor').then((m) => m.RichTextEditor),
    {
        ssr: false,
        loading: () => <EditorLoading />,
    },
);

// Polish PR-1 — STATUS_BADGE moved to shared domain mapping as
// POLICY_STATUS_VARIANT in @/app-layer/domain/entity-status-mapping.
const APPROVAL_BADGE: Record<string, StatusBadgeVariant> = {
    PENDING: 'info', APPROVED: 'success', REJECTED: 'error',
};

/**
 * Approval status → label, reusing the SAME `approval.*` keys the
 * `<ApprovalBanner>` renders so the two surfaces speak with one vocabulary.
 * Falls back to the raw value for an unmapped status rather than rendering
 * blank.
 */
function approvalStatusLabel(
    status: string,
    tApproval: (key: string) => string,
): string {
    switch (status) {
        case 'APPROVED': return tApproval('approved');
        case 'REJECTED': return tApproval('rejected');
        case 'PENDING': return tApproval('pendingReview');
        default: return status;
    }
}
// Real icon components (not string tokens) per event action. POLICY_REVIEWED
// (fired by markPolicyReviewed) is now mapped.
const EVENT_ICONS: Record<string, AppIconName> = {
    POLICY_CREATED: 'create', POLICY_VERSION_CREATED: 'versions', POLICY_UPDATED: 'edit',
    POLICY_APPROVAL_REQUESTED: 'userCheck', POLICY_APPROVED: 'checkCircle', POLICY_REJECTED: 'error',
    POLICY_PUBLISHED: 'publish', POLICY_ARCHIVED: 'archive',
    POLICY_REVIEWED: 'refresh', POLICY_REVIEW_OVERDUE: 'warning',
    POLICY_ATTESTED: 'userCheck', POLICY_ACK_REQUESTED: 'userCheck',
    POLICY_CONTROL_LINKED: 'link', POLICY_CONTROL_UNLINKED: 'link',
    POLICY_ROLLED_BACK: 'refresh',
};

// i18n keys for event titles (localized instead of raw enum tokens).
const EVENT_LABEL_KEYS: Record<string, string> = {
    POLICY_CREATED: 'detail.event.created', POLICY_VERSION_CREATED: 'detail.event.versionCreated',
    POLICY_UPDATED: 'detail.event.updated', POLICY_APPROVAL_REQUESTED: 'detail.event.approvalRequested',
    POLICY_APPROVED: 'detail.event.approved', POLICY_REJECTED: 'detail.event.rejected',
    POLICY_PUBLISHED: 'detail.event.published', POLICY_ARCHIVED: 'detail.event.archived',
    POLICY_REVIEWED: 'detail.event.reviewed', POLICY_REVIEW_OVERDUE: 'detail.event.reviewOverdue',
    POLICY_ATTESTED: 'detail.event.attested', POLICY_ACK_REQUESTED: 'detail.event.ackRequested',
    POLICY_CONTROL_LINKED: 'detail.event.controlLinked', POLICY_CONTROL_UNLINKED: 'detail.event.controlUnlinked',
    POLICY_ROLLED_BACK: 'detail.event.rolledBack',
};

type ContentMode = 'MARKDOWN' | 'EXTERNAL_LINK' | 'FILE';

export default function PolicyDetailPage() {
    const t = useTranslations('policies');
    // Same namespace the ApprovalBanner uses, so the per-version approval badge
    // reads with identical vocabulary instead of the raw enum.
    const tApproval = useTranslations('approval');
    const params = useParams();
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const tenant = useTenantContext();
    const toast = useToast();
    const policyId = params?.policyId as string;
    // Ordered ids for the prev/next stepper beside the name — list order,
    // so stepping walks the sequence the user just saw.
    const policyIds = useEntityListIds(CACHE_KEYS.policies.list());

    const [policy, setPolicy] = useState<PolicyDetailDTO | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [tab, setTab] = useState<'current' | 'versions' | 'mappings' | 'traceability' | 'acknowledgements' | 'tasks' | 'editor' | 'activity'>('current');

    // Editor state
    const [contentMode, setContentMode] = useState<ContentMode>('MARKDOWN');
    const [editorContent, setEditorContent] = useState('');
    // Epic 45.2 — when the operator toggles the rich editor's
    // markdown ↔ WYSIWYG switch, the editor reports the new type.
    // We persist that as `contentType` on the version so rendering
    // can branch correctly between markdown-as-text and HTML.
    const [editorContentType, setEditorContentType] =
        useState<RichTextContentType>('MARKDOWN');
    const [externalUrl, setExternalUrl] = useState('');
    const [changeSummary, setChangeSummary] = useState('');
    const [saving, setSaving] = useState(false);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);

    // Review editing
    const [editingReview, setEditingReview] = useState(false);
    const [reviewDays, setReviewDays] = useState('');
    const [nextReview, setNextReview] = useState('');
    const [savingReview, setSavingReview] = useState(false);

    // Activity feed
    const [activities, setActivities] = useState<AuditLogEntry[]>([]);
    const [activitiesLoading, setActivitiesLoading] = useState(false);

    // Action state
    const [actionLoading, setActionLoading] = useState('');
    // Emergency publish-bypass modal (admin-only "Publish without approval").
    /**
     * Bumped after publish / rollback to force the acknowledgement panel to
     * refetch. Both operations run `carryForwardAckCampaign`, which re-opens
     * everyone's acknowledgement against the new version — so a mounted panel
     * that does not refetch keeps telling the viewer they are compliant when
     * the server has just recorded that they are not.
     */
    const [ackRefreshToken, setAckRefreshToken] = useState(0);
    const [archiveOpen, setArchiveOpen] = useState(false);
    const [bypassOpen, setBypassOpen] = useState(false);
    const [bypassReason, setBypassReason] = useState('');
    // A4 — rollback confirmation (names the target version before committing).
    const [rollbackOpen, setRollbackOpen] = useState(false);

    const fetchPolicy = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}`));
            if (!res.ok) throw new Error(t('detail.notFound'));
            const data = await res.json();
            setPolicy(data);
            setReviewDays(data.reviewFrequencyDays?.toString() || '');
            setNextReview(data.nextReviewAt ? data.nextReviewAt.substring(0, 10) : '');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, policyId, t]);

    const fetchActivity = useCallback(async () => {
        setActivitiesLoading(true);
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}/activity`));
            if (res.ok) setActivities(await res.json());
        } finally {
            setActivitiesLoading(false);
        }
    }, [apiUrl, policyId]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchPolicy(); }, [fetchPolicy]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (tab === 'activity') fetchActivity(); }, [tab, fetchActivity]);

    // Pre-load the current version's content into the editor when the
    // Editor tab is opened directly (the "+ Version" button already seeds
    // it on its own click). Without this, opening the tab showed an empty
    // editor and the operator couldn't edit the existing policy. Only
    // text-bearing versions (MARKDOWN / HTML) are loaded; the rich editor
    // lives under the MARKDOWN content-mode and renders HTML in WYSIWYG.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => {
        if (tab !== 'editor' || editorContent) return;
        const cv = policy?.currentVersion || policy?.versions?.[0];
        if (cv?.contentText && (cv.contentType === 'HTML' || cv.contentType === 'MARKDOWN')) {
            setContentMode('MARKDOWN');
            setEditorContent(cv.contentText);
            setEditorContentType(cv.contentType === 'HTML' ? 'HTML' : 'MARKDOWN');
        }
        // editorContent intentionally omitted — re-seeding on every keystroke
        // would fight the operator's edits; the guard above runs it once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, policy]);

    // ── Actions ──

    /**
     * A policy is LIVE when a new version would otherwise withdraw it.
     *
     * `createPolicyVersion` demotes PUBLISHED/APPROVED policies to DRAFT. On a
     * PUBLISHED policy that is a withdrawal: `attestPolicy` requires PUBLISHED,
     * so every outstanding acknowledgement stops being possible and the policy
     * drops out of coverage — from the editor, with no warning.
     */
    const policyIsLive = policy?.status === 'PUBLISHED' || policy?.status === 'APPROVED';

    const createVersion = async () => {
        if (contentMode === 'MARKDOWN' && !editorContent.trim()) return;
        if (contentMode === 'EXTERNAL_LINK' && !externalUrl.trim()) return;
        if (contentMode === 'FILE' && !selectedFile) return;
        setSaving(true);
        setError('');
        try {
            // Epic 45.2 — when the editor is in WYSIWYG mode the
            // payload is HTML, not markdown. The backend's
            // `sanitizePolicyContent` allowlists HTML on write, so
            // the wire format simply needs the right `contentType`.
            const wireContentType =
                contentMode === 'FILE'
                    ? 'MARKDOWN'
                    : contentMode === 'MARKDOWN'
                      ? editorContentType
                      : contentMode;
            const body: Record<string, unknown> = {
                contentType: wireContentType,
                changeSummary: changeSummary || null,
                // Save as a PROPOSAL on a live policy rather than demoting it.
                // The flag has existed on the usecase all along for exactly
                // this (the SharePoint pull uses it so an external edit never
                // un-publishes a live policy); the editor simply never asked
                // for it. The live version keeps serving acknowledgements
                // until the proposal is approved and published.
                proposeOnly: policyIsLive,
            };

            if (contentMode === 'MARKDOWN') {
                body.contentText = editorContent;
            } else if (contentMode === 'EXTERNAL_LINK') {
                body.contentType = 'EXTERNAL_LINK';
                body.externalUrl = externalUrl;
                body.contentText = `External document: ${externalUrl}`;
            } else if (contentMode === 'FILE' && selectedFile) {
                // Upload file first
                const formData = new FormData();
                formData.append('file', selectedFile);
                const uploadRes = await fetch(apiUrl('/evidence'), {
                    method: 'POST',
                    body: formData,
                });
                if (!uploadRes.ok) throw new Error(t('detail.errFileUpload'));
                body.contentText = `File: ${selectedFile.name}`;
                body.changeSummary = changeSummary || `Uploaded file: ${selectedFile.name}`;
            }

            const res = await fetch(apiUrl(`/policies/${policyId}/versions`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || t('detail.errCreateVersion'));
            }
            setEditorContent(''); setExternalUrl(''); setChangeSummary(''); setEditorContentType('MARKDOWN');
            setSelectedFile(null); setTab('versions');
            toast.success(
                policyIsLive
                    ? t('detail.versionProposedToast')
                    : t('detail.versionCreatedToast'),
            );
            await fetchPolicy();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : t('detail.errUnknown'));
        } finally {
            setSaving(false);
        }
    };

    const saveReview = async () => {
        setSavingReview(true);
        try {
            const body: Record<string, unknown> = {};
            if (reviewDays) body.reviewFrequencyDays = parseInt(reviewDays);
            if (nextReview) body.nextReviewAt = nextReview;
            await fetch(apiUrl(`/policies/${policyId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            setEditingReview(false);
            await fetchPolicy();
        } finally {
            setSavingReview(false);
        }
    };

    const markReviewed = async () => {
        setActionLoading('review');
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}/review`), { method: 'POST' });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t('detail.errFailed')); }
            const updated = await res.json().catch(() => null);
            await fetchPolicy();
            // "Mark reviewed" stamps the periodic review date — it does NOT
            // change publication status. The toast makes the (otherwise
            // subtle) success visible and reinforces what it did.
            const next = updated?.nextReviewAt;
            toast.success(
                next ? t('detail.markedReviewedNext', { date: formatDate(next) }) : t('detail.markedReviewed'),
            );
        } catch (err: unknown) { setError(err instanceof Error ? err.message : t('detail.errUnknown')); } finally { setActionLoading(''); }
    };

    const requestApproval = async (versionId: string) => {
        setActionLoading('approve-' + versionId);
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}/approval`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ versionId }),
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t('detail.errFailed')); }
            await fetchPolicy();
        } catch (err: unknown) { setError(err instanceof Error ? err.message : t('detail.errUnknown')); } finally { setActionLoading(''); }
    };

    const decideApproval = async (approvalId: string, decision: 'APPROVED' | 'REJECTED') => {
        setActionLoading('decide-' + approvalId);
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}/approval/${approvalId}/decide`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision }),
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t('detail.errFailed')); }
            await fetchPolicy();
        } catch (err: unknown) { setError(err instanceof Error ? err.message : t('detail.errUnknown')); } finally { setActionLoading(''); }
    };

    const publishVersion = async (versionId: string, bypassApprovalReason?: string) => {
        setActionLoading('publish-' + versionId);
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}/publish`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ versionId, ...(bypassApprovalReason ? { bypassApprovalReason } : {}) }),
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t('detail.errFailed')); }
            setBypassOpen(false);
            setBypassReason('');
            setAckRefreshToken((n) => n + 1);
            await fetchPolicy();
        } catch (err: unknown) { setError(err instanceof Error ? err.message : t('detail.errUnknown')); } finally { setActionLoading(''); }
    };

    const rollbackToPrevious = async () => {
        setActionLoading('rollback');
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}/rollback`), { method: 'POST' });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t('detail.errFailed')); }
            setAckRefreshToken((n) => n + 1);
            await fetchPolicy();
        } catch (err: unknown) { setError(err instanceof Error ? err.message : t('detail.errUnknown')); } finally { setActionLoading(''); }
    };

    const archivePolicy = async () => {
        setActionLoading('archive');
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}/archive`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t('detail.errFailed')); }
            await fetchPolicy();
        } catch (err: unknown) { setError(err instanceof Error ? err.message : t('detail.errUnknown')); } finally { setActionLoading(''); }
    };

    /**
     * Reverse an archive. Lands the policy in DRAFT (see `unarchivePolicy`),
     * so the normal review path applies before it can go live again.
     */
    const unarchivePolicyAction = async () => {
        setActionLoading('unarchive');
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}/unarchive`), { method: 'POST' });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t('detail.errFailed')); }
            toast.success(t('detail.unarchivedToast'));
            await fetchPolicy();
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : t('detail.errUnknown'));
        } finally { setActionLoading(''); }
    };

    // ── Helpers ──

    const renderVersionContent = (v: PolicyVersionDTO) => {
        if (v.contentType === 'EXTERNAL_LINK' && v.externalUrl) {
            return (
                <a href={v.externalUrl} target="_blank" rel="noopener noreferrer"
                    className="text-[var(--brand-default)] hover:text-[var(--brand-muted)] underline flex items-center gap-1">
                    {v.externalUrl}
                </a>
            );
        }
        // Both HTML and MARKDOWN versions render as a styled document:
        //   - HTML  → sanitise the stored markup.
        //   - MARKDOWN → parse to HTML (marked), THEN sanitise — so the
        //     imported ciso-toolkit + legacy markdown policies get the same
        //     headers / lists / page breaks as native-HTML policies instead
        //     of rendering as a wall of raw markdown text.
        // The sanitised body is then enriched (heading anchors + auto Table
        // of Contents) and rendered inside `.policy-content` (the document
        // stylesheet: centred page, headers, page-break divider, print CSS).
        const rawHtml =
            v.contentType === 'HTML'
                ? v.contentText ?? ''
                : renderPolicyMarkdown(v.contentText);
        const safe = sanitizeRichTextHtml(rawHtml);
        if (!safe.trim()) {
            return <span className="text-content-subtle italic">{t('detail.contentEmpty')}</span>;
        }
        const enriched = enrichPolicyHtml(safe);
        return (
            <div
                className="policy-content"
                data-testid={`policy-version-html-${v.id}`}
                dangerouslySetInnerHTML={{ __html: enriched }}
            />
        );
    };

    const relativeTime = (date: string) => {
        const d = new Date(date);
        // `Date.now()` inside a callback that runs at render-string time
        // (`relativeTime(activity.createdAt)`). The label is allowed to be
        // mildly stale until the next re-render — used in an audit log,
        // not a high-precision context.
        // eslint-disable-next-line react-hooks/purity
        const diff = Date.now() - d.getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return t('detail.relJustNow');
        if (mins < 60) return t('detail.relMinAgo', { mins });
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return t('detail.relHrAgo', { hrs });
        const days = Math.floor(hrs / 24);
        return days === 1 ? t('detail.relYesterday') : t('detail.relDaysAgo', { days });
    };

    const isOverdue = policy?.nextReviewAt && new Date(policy.nextReviewAt) < new Date() && policy.status !== 'ARCHIVED';

    // ── Render ──

    const breadcrumbs = [
        { label: t('list.dashboard'), href: tenantHref('/dashboard') },
        { label: t('detail.crumbPolicies'), href: tenantHref('/policies') },
        { label: policy?.title ?? t('detail.crumbFallback') },
    ];
    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (error && !policy) {
        return (
            <EntityDetailLayout error={error} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!policy) {
        return (
            <EntityDetailLayout empty={{ message: t('detail.notFoundEmpty') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const currentVersion = policy.currentVersion || policy.versions?.[0];
    const versions = policy.versions || [];
    const canWrite = tenant.permissions.canWrite;
    const canAdmin = tenant.permissions.canAdmin;
    // A1 — client-side separation-of-duties: a reviewer may not approve a
    // change they requested OR authored. Mirrors the server-side refusal in
    // decidePolicyApproval so the button is disabled before the round-trip.
    const currentUserId = tenant.userId;

    // Promoted state-advancing verbs (Prompt-2.4) target the current/displayed
    // version — the same gating the per-version cards use, surfaced in the
    // page action cluster so publish/request-approval are reachable from Current.
    const headerVersion = versions.find((v) => v.id === policy.currentVersionId) ?? versions[0] ?? currentVersion;
    const headerApprovals = (headerVersion?.approvals || []).filter((a) => a.status === 'PENDING' || a.status === 'APPROVED' || a.status === 'REJECTED');
    const headerHasPending = headerApprovals.some((a) => a.status === 'PENDING');
    const headerHasApproved = headerApprovals.some((a) => a.status === 'APPROVED');
    const headerIsPublished = !!headerVersion && policy.currentVersionId === headerVersion.id && policy.status === 'PUBLISHED';
    const canRequestApproval = canWrite && !!headerVersion && !headerHasPending && !headerHasApproved && !headerIsPublished && policy.status !== 'ARCHIVED';
    /**
     * The version the server would actually accept a publish for.
     *
     * `publishPolicy` requires BOTH that the policy is APPROVED and that the
     * version matches the one the approval was granted for. `currentVersionId`
     * is NOT that version: nothing updates it when a version is created or
     * approved — it tracks the last PUBLISHED version — so after a new version
     * is drafted and approved it still points at the previous, live one.
     *
     * Deriving the target from the approval record (most recently decided
     * APPROVED row) is what makes the button agree with the server instead of
     * targeting whatever happens to be displayed.
     */
    const approvedTargetVersionId = (() => {
        const approved = (policy.approvals ?? [])
            .filter((a) => a.status === 'APPROVED')
            .sort((a, b) => {
                const at = a.decidedAt ? new Date(a.decidedAt).getTime() : 0;
                const bt = b.decidedAt ? new Date(b.decidedAt).getTime() : 0;
                return bt - at;
            });
        return approved[0]?.policyVersionId ?? null;
    })();

    /**
     * Publish is offered ONLY in the state the server accepts.
     *
     * This previously read `headerHasApproved && !headerIsPublished` with no
     * regard for the policy's own status. Creating a new version demotes the
     * policy to DRAFT but leaves `currentVersionId` on the OLD version — which
     * still carries its APPROVED approval — so the button lit up on a DRAFT
     * policy and every click threw "is DRAFT; cannot publish without going
     * through APPROVED". The gate was written against a comment (below, now
     * corrected) that claimed version creation sets `currentVersionId`.
     *
     * Requiring `status === 'APPROVED'` and targeting the approved version
     * makes the affordance and the server's rule the same rule.
     */
    // No "and not already published" clause: APPROVED and PUBLISHED are
    // mutually exclusive states, so requiring APPROVED already excludes it.
    const canPublishNow =
        canAdmin && policy.status === 'APPROVED' && !!approvedTargetVersionId;
    const canBypassPublish = canAdmin && !!headerVersion && !headerHasApproved && !headerIsPublished && policy.status !== 'ARCHIVED';

    type PolicyTab = 'current' | 'versions' | 'mappings' | 'traceability' | 'acknowledgements' | 'tasks' | 'editor' | 'activity';
    const tabs: ReadonlyArray<{ key: PolicyTab; label: string }> = [
        { key: 'current', label: t('detail.tabCurrent') },
        { key: 'versions', label: t('detail.tabVersions') },
        { key: 'mappings', label: t('detail.tabMappings') },
        { key: 'traceability', label: t('detail.tabTraceability') },
        { key: 'acknowledgements', label: t('detail.tabAcknowledgements') },
        { key: 'tasks', label: t('detail.tabTasks') },
        ...(canWrite ? ([{ key: 'editor' as const, label: t('detail.tabEditor') }]) : []),
        { key: 'activity', label: t('detail.tabActivity') },
    ];

    // Epic 45.3 — surface the active pending approval (if any) above
    // the page chrome so reviewers see it on first paint. Approvals
    // come back nested per-version on `policy.approvals`; we pick the
    // most recent PENDING row + augment it with the version number
    // the banner displays.
    const pendingApproval = (() => {
        const all = policy.approvals ?? [];
        const pending = all.find((a) => a.status === 'PENDING');
        if (!pending) return null;
        const matchingVersion = (policy.versions ?? []).find(
            (v) => v.id === pending.policyVersionId,
        );
        return {
            id: pending.id,
            status: 'PENDING' as const,
            requestedBy: pending.requestedBy ?? null,
            approvedBy: pending.approvedBy ?? null,
            decidedAt: pending.decidedAt ?? null,
            // `comment` is declared on the DTO now, so no cast.
            comment: pending.comment ?? null,
            versionNumber: matchingVersion?.versionNumber ?? null,
            // SoD: the banner must also block the version's AUTHOR from
            // approving, exactly as the per-version card and the server do.
            versionAuthor: matchingVersion?.createdBy ?? null,
        };
    })();

    return (
        <EntityDetailLayout
            id="policy-detail-page"
            back={{ smart: true }}
            breadcrumbs={breadcrumbs}
            tabs={tabs}
            activeTab={tab}
            onTabChange={setTab}
            title={<span className="truncate" id="policy-title">{policy.title}</span>}
            prevNext={{
                ids: policyIds,
                currentId: policyId,
                hrefFor: (id) => tenantHref(`/policies/${id}`),
                labelSingular: 'policy',
            }}
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            id: 'policy-status',
                            label: t('detail.metaStatus'),
                            value: policy.status,
                            variant:
                                POLICY_STATUS_VARIANT[policy.status] ??
                                'neutral',
                        },
                        ...(policy.owner
                            ? [
                                  {
                                      label: t('detail.metaOwner'),
                                      value: policy.owner.name,
                                  } as const,
                              ]
                            : []),
                        ...(policy.nextReviewAt
                            ? [
                                  {
                                      label: t('detail.metaNextReview'),
                                      value: formatDate(
                                          policy.nextReviewAt,
                                      ),
                                      tone: isOverdue
                                          ? ('critical' as const)
                                          : undefined,
                                  } as const,
                              ]
                            : []),
                    ]}
                />
            }
            actions={
                <>
                    {/* B9 — Export PDF. Uses a plain anchor so the
                        browser handles the download natively; the
                        route streams a `Content-Disposition:
                        attachment` PDF carrying cover + TOC + body
                        + classification chrome. */}
                    <a
                        href={apiUrl(`/policies/${policyId}/export`)}
                        id="export-policy-pdf-btn"
                        data-testid="export-policy-pdf-btn"
                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                    >
                        {t('detail.exportPdf')}
                    </a>
                    {/* Prompt-2.4 — state-advancing verbs promoted from the
                        per-version cards, gated on the current version's status. */}
                    {canRequestApproval && (
                        <Button variant="secondary" size="sm" onClick={() => headerVersion && requestApproval(headerVersion.id)} disabled={!!actionLoading} id="header-request-approval">
                            {t('detail.requestApproval')}
                        </Button>
                    )}
                    {/* Restore. Archiving used to be a one-way door — there was
                        no inverse anywhere in the product, and an archived
                        policy could not be edited, reviewed or published, so it
                        was effectively destroyed by a single unconfirmed
                        click. Offered on the same tier that archived it. */}
                    {canAdmin && policy.status === 'ARCHIVED' && (
                        <Button variant="secondary" size="sm" onClick={unarchivePolicyAction} disabled={!!actionLoading} id="unarchive-btn">
                            {actionLoading === 'unarchive' ? t('detail.restoring') : t('detail.restoreFromArchive')}
                        </Button>
                    )}
                    {canPublishNow && (
                        <Button variant="secondary" size="sm" onClick={() => approvedTargetVersionId && publishVersion(approvedTargetVersionId)} disabled={!!actionLoading} id="header-publish">
                            {t('detail.publish')}
                        </Button>
                    )}
                    {canBypassPublish && (
                        <Button variant="secondary" size="sm" onClick={() => setBypassOpen(true)} disabled={!!actionLoading} id="header-publish-bypass">
                            {t('detail.publishWithoutApproval')}
                        </Button>
                    )}
                    {canWrite && policy.status !== 'ARCHIVED' && (
                        <button onClick={() => {
                            setTab('editor');
                            setEditorContent(currentVersion?.contentText || '');
                            setEditorContentType(
                                currentVersion?.contentType === 'HTML'
                                    ? 'HTML'
                                    : 'MARKDOWN',
                            );
                        }} className={buttonVariants({ variant: 'primary' })} id="new-version-btn"><Plus className="-ml-0.5 -mr-2.5" />{t('detail.version')}</button>
                    )}
                    {canAdmin && policy.status !== 'ARCHIVED' && (
                        <Button variant="ghost" size="sm" className="text-content-muted hover:text-content-error" onClick={() => setArchiveOpen(true)} disabled={actionLoading === 'archive'} id="archive-btn">
                            {actionLoading === 'archive' ? '...' : t('detail.archive')}
                        </Button>
                    )}
                </>
            }
        >
            {/* Approval banner (Epic 45.3) — only mounts when an
                approval row is PENDING. Reviewer-only actions are
                gated by `canAdmin`; non-reviewers still see status
                + requester so the page is informative. */}
            {policy.status === 'IN_REVIEW' && pendingApproval && (
                <ApprovalBanner
                    approval={pendingApproval}
                    canDecide={canAdmin}
                    currentUserId={currentUserId}
                    busy={!!actionLoading && actionLoading.startsWith('decide-')}
                    onDecide={(approvalId, decision) =>
                        decideApproval(approvalId, decision)
                    }
                />
            )}

            {error && (
                <InlineNotice variant="error" icon={null} onDismiss={() => setError('')}>
                    {error}
                </InlineNotice>
            )}

            {/* Description + meta + review-schedule */}
            <div className={cardVariants()}>
                <div className="flex items-start justify-between gap-default">
                    <div className="flex-1 min-w-0">
                        {policy.description && <p className="text-sm text-content-muted mb-3">{policy.description}</p>}
                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-content-subtle">
                            {policy.category && <span>{policy.category}</span>}
                            {policy.owner && <span>{policy.owner.name}</span>}
                            {policy.nextReviewAt && (
                                <span className={isOverdue ? 'text-content-error' : ''}>
                                    {t('detail.review', { date: formatDate(policy.nextReviewAt) })}
                                </span>
                            )}
                            {policy.reviewFrequencyDays && <span>{t('detail.everyDays', { days: policy.reviewFrequencyDays })}</span>}
                            {policy.lastReviewedAt && <span>{t('detail.lastReviewed', { date: formatDate(policy.lastReviewedAt) })}</span>}
                            {isOverdue && <span className="text-content-error font-medium">{t('detail.reviewOverdue')}</span>}
                            <span>{t('detail.versionsCount', { count: versions.length })}</span>
                        </div>
                        {/* Review controls */}
                        {canWrite && !editingReview && (
                            <div className="flex items-center gap-default mt-2">
                                <button onClick={() => setEditingReview(true)} className="text-xs text-[var(--brand-default)] hover:text-[var(--brand-muted)]">
                                    {t('detail.editReviewSchedule')}
                                </button>
                                {policy.status !== 'ARCHIVED' && (
                                    <Tooltip content={t('detail.markReviewedTooltip')}>
                                        <Button
                                            variant="secondary"
                                            size="xs"
                                            onClick={markReviewed}
                                            disabled={actionLoading === 'review'}
                                            id="mark-reviewed-btn"
                                        >
                                            {actionLoading === 'review' ? '…' : t('detail.markReviewed')}
                                        </Button>
                                    </Tooltip>
                                )}
                            </div>
                        )}
                        {editingReview && (
                            <div className="flex gap-tight items-end mt-2">
                                <div>
                                    <label
                                        className="block text-center text-xs text-content-subtle mb-1"
                                        htmlFor="policy-review-frequency-input"
                                    >
                                        {t('detail.freqDaysLabel')}
                                    </label>
                                    {/* Epic 60 — NumberStepper gives us +/- buttons,
                                        ArrowUp/Down keyboard, bounded clamping, and
                                        a single accessible spinbutton. `reviewDays`
                                        stays a string in state so saveReview()'s
                                        parseInt() path is unchanged. The value is the
                                        bare number ("− 30 +") — the unit lives in the
                                        label, not inside the counter. */}
                                    <NumberStepper
                                        id="policy-review-frequency-input"
                                        className="w-32"
                                        size="sm"
                                        ariaLabel={t('detail.freqAria')}
                                        value={
                                            reviewDays === ""
                                                ? 30
                                                : Number(reviewDays) || 30
                                        }
                                        onChange={(v) => setReviewDays(String(v))}
                                        min={1}
                                        max={3650}
                                    />
                                </div>
                                <div>
                                    <label
                                        className="block text-xs text-content-subtle mb-1"
                                        htmlFor="policy-next-review-input"
                                    >
                                        {t('detail.nextReviewLabel')}
                                    </label>
                                    {/*
                                      Epic 58 — replaces the previous
                                      native date input with the shared
                                      DatePicker. `nextReview` keeps its
                                      YMD-string shape so `saveReview()`
                                      posts the same payload as before.
                                    */}
                                    <DatePicker
                                        id="policy-next-review-input"
                                        className="w-44 text-sm"
                                        placeholder={t('detail.pickDate')}
                                        clearable
                                        align="start"
                                        value={parseYMD(nextReview)}
                                        onChange={(next) => {
                                            setNextReview(toYMD(next) ?? '');
                                        }}
                                        disabledDays={{
                                            before: startOfUtcDay(new Date()),
                                        }}
                                        aria-label={t('detail.nextReviewAria')}
                                    />
                                </div>
                                <Button variant="secondary" size="xs" onClick={() => setEditingReview(false)}>{t('detail.cancel')}</Button>
                                <Button variant="primary" size="xs" onClick={saveReview} disabled={savingReview}>
                                    {savingReview ? '…' : t('detail.save')}
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Polish PR-5 — tab strip is now owned by EntityDetailLayout
                via the `tabs` slot. The shell paints a tablist with the
                same #tab-current / #tab-versions / #tab-editor /
                #tab-activity DOM ids E2E selectors rely on. */}

            {/* ── Current Version ── */}
            {/* Publication-flow guide — the Request Approval / Publish
                buttons live in the Versions tab, which isn't obvious from
                the Current view. Surface the next step for the two states
                whose action is a tab away (IN_REVIEW is already explained
                by the ApprovalBanner above; PUBLISHED/ARCHIVED need none). */}
            {tab === 'current' && canWrite && (policy.status === 'DRAFT' || policy.status === 'APPROVED') && (
                <InlineNotice
                    variant={policy.status === 'APPROVED' ? 'success' : 'info'}
                    title={policy.status === 'APPROVED' ? t('detail.guideApprovedTitle') : t('detail.guideDraftTitle')}
                >
                    <div className="flex items-center justify-between gap-default flex-wrap">
                        <span>
                            {policy.status === 'APPROVED'
                                ? t('detail.guideApprovedBody')
                                : t('detail.guideDraftBody')}
                        </span>
                        <Button variant="secondary" size="sm" onClick={() => setTab('versions')} id="goto-versions-btn">
                            {t('detail.gotoVersions')}
                        </Button>
                    </div>
                </InlineNotice>
            )}
            {tab === 'current' && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    {currentVersion ? (
                        <>
                            <div className="flex items-center justify-between mb-4">
                                <div className="text-sm text-content-muted">
                                    {t('detail.versionMeta', { n: currentVersion.versionNumber, name: currentVersion.createdBy?.name ?? '', date: formatDate(currentVersion.createdAt) })}
                                    {currentVersion.contentType === 'EXTERNAL_LINK' && <StatusBadge variant="info" className="ml-2">{t('detail.externalBadge')}</StatusBadge>}
                                </div>
                            </div>
                            {renderVersionContent(currentVersion)}
                        </>
                    ) : (
                        <div className="text-center text-content-subtle py-8">
                            <p>{t('detail.versionEmpty')}</p>
                            {canWrite && <p className="text-sm mt-1">{t('detail.createVersionHint')}</p>}
                        </div>
                    )}
                </div>
            )}

            {/* SP-4 — SharePoint link (renders nothing if SharePoint isn't set up) */}
            {tab === 'current' && (policy.evidenceItems?.length ?? 0) > 0 && (
                <PolicyEvidenceChecklist
                    policyId={policyId}
                    items={policy.evidenceItems ?? []}
                    canWrite={canWrite}
                    onChanged={fetchPolicy}
                />
            )}

            {tab === 'current' && <PolicySharePointSection policyId={policyId} />}

            {/* ── Version History ── */}
            {tab === 'versions' && (
                <div className="space-y-compact" id="version-history">
                    {/* Prompt-3.1 — published lineage + rollback to the previous
                        published version (targets recorded in lifecycleHistoryJson). */}
                    {(policy.lifecycleHistoryJson?.length ?? 0) > 0 && (
                        <div className="flex items-center justify-between rounded-lg border border-border-subtle p-3">
                            <span className="text-sm text-content-muted">
                                {t('detail.rollbackHint', { count: policy.lifecycleHistoryJson!.length })}
                            </span>
                            {canAdmin && (
                                <Button variant="secondary" size="sm" onClick={() => setRollbackOpen(true)} disabled={!!actionLoading} id="policy-rollback-btn">
                                    {actionLoading === 'rollback' ? '…' : t('detail.rollback')}
                                </Button>
                            )}
                        </div>
                    )}
                    {/* Version diff (Epic 45.3) — defaults to
                        previous-vs-current so a reviewer's first
                        impression is always meaningful. The picker
                        in the diff card lets them pick any pair. */}
                    {versions.length >= 2 && (
                        <VersionDiff
                            versions={versions.map((v) => ({
                                id: v.id,
                                versionNumber: v.versionNumber,
                                contentType: v.contentType,
                                text: v.contentText ?? '',
                            }))}
                        />
                    )}
                    {versions.length === 0 ? (
                        <Card className="text-center text-content-subtle">{t('detail.versionsEmpty')}</Card>
                    ) : versions.map((v: PolicyVersionDTO) => {
                        const vApprovals = (v.approvals || []).filter((a) => a.status === 'PENDING' || a.status === 'APPROVED' || a.status === 'REJECTED');
                        const hasPending = vApprovals.some((a) => a.status === 'PENDING');
                        const hasApproved = vApprovals.some((a) => a.status === 'APPROVED');
                        // `currentVersionId` marks the LAST PUBLISHED version, and
                        // it does NOT mean the policy is currently published.
                        //
                        // It is NOT "set at creation": `PolicyVersionRepository.create`
                        // writes the version row and nothing else — only
                        // `setCurrentVersion`, called from publish and rollback,
                        // moves this pointer. The old wording here is what the
                        // header publish gate was written against, which is how
                        // that button ended up offered on a DRAFT policy. A version is "Published"
                        // only when it's the current version AND the policy's lifecycle
                        // status is PUBLISHED. Keying off currentVersionId alone made a
                        // fresh draft's version show "Published" and hid Request Approval.
                        const isCurrentVersion = policy.currentVersionId === v.id;
                        const isPublishedVersion = isCurrentVersion && policy.status === 'PUBLISHED';

                        return (
                            <div key={v.id} className={cn(cardVariants({ density: 'compact' }), 'space-y-compact')}>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-compact">
                                        <span className="text-sm font-semibold text-[var(--brand-default)]">v{v.versionNumber}</span>
                                        {isPublishedVersion && <StatusBadge variant="success">{t('detail.published')}</StatusBadge>}
                                        {isCurrentVersion && !isPublishedVersion && (
                                            <span className="text-xs font-medium text-content-subtle">{t('detail.current')}</span>
                                        )}
                                        {v.contentType === 'EXTERNAL_LINK' && <StatusBadge variant="info">{t('detail.externalLink')}</StatusBadge>}
                                        <span className="text-xs text-content-subtle">
                                            {v.createdBy?.name} · {formatDate(v.createdAt)}
                                        </span>
                                    </div>
                                    <div className="flex gap-tight">
                                        {canWrite && !hasPending && !hasApproved && !isPublishedVersion && (
                                            <Button variant="secondary" size="sm" onClick={() => requestApproval(v.id)} disabled={!!actionLoading} id={`request-approval-${v.versionNumber}`}>
                                                {actionLoading === 'approve-' + v.id ? '...' : t('detail.requestApproval')}
                                            </Button>
                                        )}
                                        {canAdmin && hasApproved && !isPublishedVersion && (
                                            <Button variant="primary" size="sm" onClick={() => publishVersion(v.id)} disabled={!!actionLoading} id={`publish-version-${v.versionNumber}`}>
                                                {actionLoading === 'publish-' + v.id ? '...' : t('detail.publish')}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                                {v.changeSummary && <p className="text-sm text-content-muted italic">{v.changeSummary}</p>}
                                <details className="group">
                                    <summary className="text-xs text-[var(--brand-default)] cursor-pointer hover:text-[var(--brand-muted)]">{t('detail.showContent')}</summary>
                                    <div className="mt-2 border-t border-border-default pt-2">{renderVersionContent(v)}</div>
                                </details>
                                {vApprovals.length > 0 && (
                                    <div className="border-t border-border-default/50 pt-2 space-y-1">
                                        <p className="text-xs font-semibold text-content-subtle">{t('detail.approvalsLabel')}</p>
                                        {vApprovals.map((a) => (
                                            <div key={a.id} className="flex items-center justify-between text-xs">
                                                <div className="flex items-center gap-tight">
                                                    <StatusBadge variant={APPROVAL_BADGE[a.status]}>{approvalStatusLabel(a.status, tApproval)}</StatusBadge>
                                                    <span className="text-content-muted">
                                                        {t('detail.approvalBy', { name: a.requestedBy?.name || t('detail.unknown') })}
                                                        {a.decidedAt && ` · ${formatDate(a.decidedAt)}`}
                                                    </span>
                                                </div>
                                                {/* A PENDING row whose POLICY has moved past IN_REVIEW
                                                    is stale: the server now refuses to decide it, because
                                                    doing so would rewrite the policy's status out from
                                                    under whatever moved it (publishing left rows PENDING,
                                                    so one later Reject dropped a LIVE policy to DRAFT and
                                                    stranded its acknowledgements). Show the row, but not
                                                    an action that will be refused. The banner above is
                                                    already gated on IN_REVIEW; this surface was not. */}
                                                {canAdmin && a.status === 'PENDING' && policy.status !== 'IN_REVIEW' && (
                                                    <span className="text-xs text-content-subtle" data-testid={`approval-stale-${a.id}`}>
                                                        {t('detail.approvalNoLongerCurrent')}
                                                    </span>
                                                )}
                                                {canAdmin && a.status === 'PENDING' && policy.status === 'IN_REVIEW' && (() => {
                                                    // Client-side SoD mirror: block Approve when the viewer
                                                    // requested this approval or authored the version. The
                                                    // requester/author ids come off the nested refs
                                                    // (`requestedBy.id` / `createdBy.id`).
                                                    const isSelfApproval =
                                                        (a.requestedBy?.id != null && a.requestedBy.id === currentUserId) ||
                                                        (v.createdBy?.id != null && v.createdBy.id === currentUserId);
                                                    const approveBtn = (
                                                        <Button variant="primary" size="xs" onClick={isSelfApproval ? undefined : () => decideApproval(a.id, 'APPROVED')} disabled={isSelfApproval || !!actionLoading} id={`approve-${a.id}`}>
                                                            {actionLoading === 'decide-' + a.id ? '...' : t('detail.approve')}
                                                        </Button>
                                                    );
                                                    return (
                                                        <div className="flex gap-1">
                                                            {isSelfApproval ? (
                                                                <Tooltip content={t('detail.sodApproveBlocked')}>
                                                                    <span className="inline-flex">{approveBtn}</span>
                                                                </Tooltip>
                                                            ) : approveBtn}
                                                            <Button variant="destructive" size="xs" onClick={() => decideApproval(a.id, 'REJECTED')} disabled={!!actionLoading}>{t('detail.reject')}</Button>
                                                        </div>
                                                    );
                                                })()}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* ── Editor ── */}
            {tab === 'editor' && canWrite && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <div className="flex items-center justify-between">
                        <Heading level={3}>{t('detail.createNewVersion')}</Heading>
                    </div>

                    {/* Content type selector */}
                    <div className="flex gap-tight">
                        {([
                            { key: 'MARKDOWN' as const, label: t('detail.modeMarkdown'), icon: '' },
                            { key: 'EXTERNAL_LINK' as const, label: t('detail.externalLink'), icon: '' },
                            { key: 'FILE' as const, label: t('detail.modeFileUpload'), icon: '' },
                        ]).map(opt => (
                            <button key={opt.key} onClick={() => setContentMode(opt.key)}
                                className={`px-3 py-1.5 text-xs rounded-lg border transition ${contentMode === opt.key
                                        ? 'border-[var(--brand-default)] bg-[var(--brand-subtle)] text-[var(--brand-default)]'
                                        : 'border-border-default text-content-muted hover:text-content-emphasis'
                                    }`} id={`mode-${opt.key.toLowerCase()}`}>{opt.label}</button>
                        ))}
                    </div>

                    {/* Markdown / WYSIWYG editor (Epic 45.2) */}
                    {contentMode === 'MARKDOWN' && (
                        <RichTextEditor
                            id="version-editor"
                            value={editorContent}
                            contentType={editorContentType}
                            placeholder={t('detail.editorPlaceholder')}
                            onChange={(value, contentType) => {
                                setEditorContent(value);
                                setEditorContentType(contentType);
                            }}
                        />
                    )}

                    {/* External link input */}
                    {contentMode === 'EXTERNAL_LINK' && (
                        <div>
                            <label className="input-label">{t('detail.externalUrlLabel')}</label>
                            <input type="url" className="input w-full" value={externalUrl}
                                onChange={e => setExternalUrl(e.target.value)}
                                placeholder="https://docs.google.com/..." id="external-url-input" />
                            <p className="text-xs text-content-subtle mt-1">{t('detail.externalUrlHint')}</p>
                        </div>
                    )}

                    {/* File upload */}
                    {contentMode === 'FILE' && (
                        <div>
                            <label className="input-label">{t('detail.uploadFile')}</label>
                            <input type="file" className="input w-full" id="file-upload-input"
                                onChange={e => setSelectedFile(e.target.files?.[0] || null)}
                                accept=".pdf,.doc,.docx,.txt,.md" />
                            {selectedFile && (
                                <p className="text-xs text-[var(--brand-default)] mt-1">{selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)</p>
                            )}
                        </div>
                    )}

                    <div>
                        <label className="input-label">{t('detail.changeSummaryLabel')}</label>
                        <input className="input w-full" value={changeSummary} onChange={e => setChangeSummary(e.target.value)}
                            placeholder={t('detail.changeSummaryPlaceholder')} id="change-summary-input" />
                    </div>

                    {/* Say what saving will do BEFORE it happens. Editing a live
                        policy used to withdraw it silently — the editor gave no
                        indication that pressing Save would stop every outstanding
                        acknowledgement. It now saves as a proposal instead, which
                        is only reassuring if the user is told. */}
                    {policyIsLive && (
                        <InlineNotice variant="info" icon={null}>
                            {t('detail.liveEditProposalNotice')}
                        </InlineNotice>
                    )}

                    <Button variant="primary" icon={saving ? undefined : <Plus className="-ml-0.5 -mr-2.5" />} onClick={createVersion} disabled={saving} id="save-version-btn">
                        {saving ? t('detail.saving') : t('detail.version')}
                    </Button>
                </div>
            )}

            {/* ── Activity Feed ── */}
            {tab === 'mappings' && (
                <InheritedMappingsPanel
                    endpoint={apiUrl(`/policies/${policyId}/mappings`)}
                    tenantHref={tenantHref}
                    entityLabel="policy"
                />
            )}
            {tab === 'traceability' && (
                <PolicyTraceabilityPanel
                    endpoint={apiUrl(`/policies/${policyId}/traceability`)}
                    tenantHref={tenantHref}
                    policyId={policyId}
                    apiUrl={apiUrl}
                    canWrite={canWrite}
                />
            )}
            {tab === 'acknowledgements' && (
                <PolicyAcknowledgementsPanel
                    policyId={policyId}
                    canAdmin={canAdmin}
                    isPublished={policy.status === 'PUBLISHED'}
                    refreshToken={ackRefreshToken}
                    currentVersionNumber={headerVersion?.versionNumber ?? null}
                />
            )}
            {tab === 'tasks' && (
                <div className={cardVariants()}>
                    <LinkedTasksPanel
                        apiBase={apiUrl('')}
                        entityType="POLICY"
                        entityId={policyId}
                        tenantHref={tenantHref}
                        canWrite={canWrite}
                    />
                </div>
            )}
            {tab === 'activity' && (
                <div className={cardVariants()} id="activity-feed">
                    <Heading level={3} className="mb-4">{t('detail.activityTimeline')}</Heading>
                    {activitiesLoading ? (
                        <div className="text-center text-content-subtle animate-pulse py-8">{t('detail.loadingActivity')}</div>
                    ) : activities.length === 0 ? (
                        <div className="text-center text-content-subtle py-8">{t('detail.activityEmpty')}</div>
                    ) : (
                        <div className="space-y-compact">
                            {activities.map((evt: AuditLogEntry) => (
                                <div key={evt.id} className="flex items-start gap-compact text-sm">
                                    <AppIcon name={EVENT_ICONS[evt.action] ?? 'activity'} size={16} className="mt-0.5 text-content-muted shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-tight">
                                            <span className="font-medium text-content-emphasis text-xs">
                                                {EVENT_LABEL_KEYS[evt.action]
                                                    ? t(EVENT_LABEL_KEYS[evt.action])
                                                    : evt.action.replace('POLICY_', '').replace(/_/g, ' ')}
                                            </span>
                                            <span className="text-xs text-content-subtle">{relativeTime(evt.createdAt)}</span>
                                        </div>
                                        <p className="text-xs text-content-muted mt-0.5 truncate">
                                            {evt.user?.name || t('detail.systemActor')}{evt.details ? ` — ${evt.details.split('\n')[0]}` : ''}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Prompt-2.5 — emergency publish-bypass. Admin-only; requires a
                typed reason forwarded as bypassApprovalReason (audited). */}
            {bypassOpen && (
                <Modal showModal={bypassOpen} setShowModal={setBypassOpen}>
                    <Modal.Header title={t('detail.bypassTitle')} />
                    <Modal.Body>
                        <div className="space-y-default">
                            <p className="text-sm text-content-muted">{t('detail.bypassBody')}</p>
                            <textarea
                                className="input"
                                rows={3}
                                value={bypassReason}
                                onChange={(e) => setBypassReason(e.target.value)}
                                placeholder={t('detail.bypassReasonPlaceholder')}
                                data-testid="policy-bypass-reason"
                            />
                        </div>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button variant="secondary" onClick={() => setBypassOpen(false)}>{t('detail.cancel')}</Button>
                        <Button
                            variant="primary"
                            onClick={() => headerVersion && publishVersion(headerVersion.id, bypassReason.trim())}
                            disabled={!bypassReason.trim() || !!actionLoading}
                            data-testid="policy-bypass-confirm"
                        >
                            {t('detail.publishWithoutApproval')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            )}

            {/* A4 — rollback confirmation. Names the exact version that will
                become live (the newest recorded lifecycle-history entry) before
                committing. tone="warning": rollback re-publishes a prior version,
                it is not a destructive delete. */}
            {/* Archive confirmation.
                Archiving withdraws the policy from the library and blocks
                every edit path — createPolicyVersion and requestPolicyApproval
                both refuse archived policies — so it is far more consequential
                than the rollback below, which HAD a confirm while this had
                none. `tone="warning"` rather than "danger" because it is now
                genuinely reversible via Restore. */}
            <ConfirmDialog
                showModal={archiveOpen}
                setShowModal={setArchiveOpen}
                tone="warning"
                title={t('detail.archiveConfirmTitle')}
                description={t('detail.archiveConfirmBody')}
                confirmLabel={t('detail.archiveConfirmLabel')}
                onConfirm={archivePolicy}
            />

            <ConfirmDialog
                showModal={rollbackOpen}
                setShowModal={setRollbackOpen}
                tone="warning"
                title={t('detail.rollbackConfirmTitle', {
                    n: policy.lifecycleHistoryJson?.[policy.lifecycleHistoryJson.length - 1]?.versionNumber ?? '',
                })}
                description={t('detail.rollbackConfirmBody', {
                    n: policy.lifecycleHistoryJson?.[policy.lifecycleHistoryJson.length - 1]?.versionNumber ?? '',
                })}
                confirmLabel={t('detail.rollbackConfirmLabel', {
                    n: policy.lifecycleHistoryJson?.[policy.lifecycleHistoryJson.length - 1]?.versionNumber ?? '',
                })}
                onConfirm={rollbackToPrevious}
            />
        </EntityDetailLayout>
    );
}
