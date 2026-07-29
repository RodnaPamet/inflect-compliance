'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { formatDate } from '@/lib/format-date';
import { useEffect, useMemo, useState, useCallback, use } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTenantApiUrl, useTenantHref, useTenantContext, usePermissions } from '@/lib/tenant-context-provider';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';
import { Button } from '@/components/ui/button';
import { Pen2, Plus, ChevronRight } from '@/components/ui/icons/nucleo';
import { Tooltip, InfoTooltip } from '@/components/ui/tooltip';
import { DataTable, createColumns } from '@/components/ui/table';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import {
    EntityPicker,
    type EntityPickerKind,
} from '@/components/ui/entity-picker';
import { useToastWithUndo, useToast } from '@/components/ui/hooks';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { NumberStepper } from '@/components/ui/number-stepper';
import { CopyText } from '@/components/ui/copy-text';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { normaliseHref } from '@/lib/security/safe-url';
import { StatusBadge } from '@/components/ui/status-badge';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Heading } from '@/components/ui/typography';
import { MetaStrip } from '@/components/ui/meta-strip';
import { VendorMonitoringPanel } from './_components/VendorMonitoringPanel';
import {
    VENDOR_STATUS_VARIANT,
    VENDOR_CRITICALITY_VARIANT,
    VENDOR_ASSESSMENT_VARIANT,
    vendorAssessmentStatusLabelKey,
    isG3AssessmentStatus,
} from '@/app-layer/domain/entity-status-mapping';
import { cardVariants } from '@/components/ui/card';
import LinkedTasksPanel from '@/components/LinkedTasksPanel';
import { cn } from '@/lib/cn';

// Polish PR-1 — STATUS_BADGE / CRIT_BADGE moved to shared domain
// mapping. Local aliases preserved so the dozens of inline-table
// consumers below stay short and readable.
const CRIT_BADGE = VENDOR_CRITICALITY_VARIANT;
const DOC_TYPE_KEYS = ['CONTRACT','SOC2','ISO_CERT','DPA','SECURITY_POLICY','PEN_TEST','OTHER'] as const;
const buildDocTypeLabels = (t: (k: string) => string): Record<string, string> => Object.fromEntries(DOC_TYPE_KEYS.map(k => [k, t(`docTypeLabels.${k}`)]));
const DOC_TYPES = [...DOC_TYPE_KEYS];

const ASSESSMENT_STATUS_BADGE = VENDOR_ASSESSMENT_VARIANT;
// PR-T — vendor status/criticality edit options are built localized inside the
// component (STATUS_OPTIONS_L / CRIT_OPTIONS_L); the old raw-label module consts
// were removed. dataAccess enum → its localized value-label key.
const DATA_ACCESS_LABEL_KEY: Record<string, string> = { NONE: 'dataNone', LOW: 'dataLow', MEDIUM: 'dataMedium', HIGH: 'dataHigh' };
const buildDocTypeCbOptions = (docTypeLabels: Record<string, string>): ComboboxOption[] => DOC_TYPES.map(ty => ({ value: ty, label: docTypeLabels[ty] || ty }));
// B4 — Document filter options. Prepended "All types" sentinel so
// clearing the type filter is a single click.
const buildDocTypeFilterOptions = (tx: (k: string) => string, docTypeCbOptions: ComboboxOption[]): ComboboxOption[] => [
    { value: '', label: tx('detail.allTypes') },
    ...docTypeCbOptions,
];
const buildVendorLinkTypeOptions = (t: (key: string) => string): ComboboxOption[] =>
    ['ASSET', 'RISK', 'ISSUE', 'CONTROL'].map((v) => ({ value: v, label: t(`linkType.${v}`) }));
const buildVendorLinkRelationOptions = (t: (key: string) => string): ComboboxOption[] =>
    ['RELATED', 'USES', 'MITIGATES', 'STORES_DATA_FOR'].map((v) => ({ value: v, label: t(`linkRelation.${v}`) }));

// Cross-entity link → target detail-page path (relative to tenant root).
// ISSUE links resolve to the tasks surface (issues redirect to tasks).
const LINK_ENTITY_HREF: Record<string, (id: string) => string> = {
    RISK: (id) => `/risks/${id}`,
    CONTROL: (id) => `/controls/${id}`,
    ASSET: (id) => `/assets/${id}`,
    ISSUE: (id) => `/tasks/${id}`,
};

type Tab = 'overview' | 'documents' | 'assessments' | 'monitoring' | 'links' | 'bundles' | 'subprocessors' | 'tasks';

/** Runtime list of the Tab union — used to validate the `?tab=` param. */
const VENDOR_TABS: readonly Tab[] = [
    'overview', 'documents', 'assessments', 'monitoring',
    'links', 'bundles', 'subprocessors', 'tasks',
];

// vendor → getVendor → VendorRepository.getById (vendor scalars + owner + _count).
// owner/_count optional: absent on the scalar-only PATCH/enrich responses that
// also setVendor.
interface VendorOwner {
    id: string;
    name: string | null;
    email: string;
}
interface VendorDetail {
    id: string;
    name: string;
    legalName: string | null;
    websiteUrl: string | null;
    domain: string | null;
    country: string | null;
    description: string | null;
    status: string;
    criticality: string;
    inherentRisk: string | null;
    residualRisk: string | null;
    dataAccess: string | null;
    isSubprocessor: boolean;
    nextReviewAt: string | null;
    contractRenewalAt: string | null;
    certificationsJson: string[] | null;
    enrichmentLastRunAt: string | null;
    enrichmentStatus: string | null;
    privacyPolicyUrl: string | null;
    securityPageUrl: string | null;
    owner?: VendorOwner | null;
    _count?: { documents: number; assessments: number; contacts: number; links: number };
}
interface VendorEditForm {
    name: string;
    legalName: string;
    websiteUrl: string;
    domain: string;
    country: string;
    description: string;
    criticality: string;
    status: string;
    /** Empty string = clear (send null). Otherwise a VendorCriticality value. */
    residualRisk: string;
    /** Empty string = clear (send null). Otherwise a VendorDataAccess value. */
    dataAccess: string;
}

// Epic G-3 — VendorAssessmentTemplate rows (the questionnaire model
// authored in Admin → Vendor Templates + the globally-seeded two).
// Sent to a vendor's respondent via the send flow — the single
// assessment-creation path.
interface SendTemplateRow {
    id: string;
    name: string;
    isPublished: boolean;
    isGlobal: boolean;
    _count?: { sections: number; questions: number };
}
// Cross-entity links — GET /vendors/[id]/links.
interface VendorLinkRow {
    id: string;
    entityType: string;
    entityId: string;
    /** Display name of the target entity; null until the backend resolves it. */
    entityName?: string | null;
    relation: string;
    createdAt: string;
}
// Evidence bundles — GET /vendors/[id]/bundles.
interface VendorBundleRow {
    id: string;
    name: string;
    frozenAt: string | null;
    createdAt: string;
    createdBy: { name: string | null } | null;
    _count?: { items: number };
}
// P3.3 — bundle item entity types (the frozen-evidence set). Only
// these four may be bundled. EVIDENCE + CONTROL are picked via the
// shared <EntityPicker>; VENDOR_DOCUMENT + ASSESSMENT are vendor-
// scoped so they draw from this page's already-loaded lists.
const BUNDLE_ITEM_TYPE_KEYS = ['VENDOR_DOCUMENT', 'ASSESSMENT', 'EVIDENCE', 'CONTROL'] as const;
type BundleItemType = (typeof BUNDLE_ITEM_TYPE_KEYS)[number];
const buildBundleItemTypeOptions = (t: (k: string) => string): ComboboxOption[] =>
    BUNDLE_ITEM_TYPE_KEYS.map((v) => ({ value: v, label: t(`detail.bundleItemTypes.${v}`) }));
// GET /vendors/[id]/bundles/[bundleId] — a single bundle + its items.
interface VendorBundleItem {
    id: string;
    entityType: string;
    entityId: string;
    snapshotJson?: unknown;
}
interface VendorBundleDetail {
    id: string;
    name: string;
    frozenAt: string | null;
    items: VendorBundleItem[];
    createdBy?: { name: string | null } | null;
}
// P3.7b — recursive subprocessor chain (nth-party). GET
// /vendors/[id]/subprocessors/chain returns the tenant's vendor at
// the root (depth 0) with its transitive subprocessors nested,
// bounded-depth + cycle-safe on the server.
interface SubprocessorChainNode {
    vendorId: string;
    name: string;
    criticality: string;
    inherentRisk: string | null;
    depth: number;
    subprocessors: SubprocessorChainNode[];
}

export default function VendorDetailPage(props: { params: Promise<{ tenantSlug: string; vendorId: string }> }) {
    const params = use(props.params);
    const tx = useTranslations('vendors');
    const tCommon = useTranslations('common');
    const DOC_TYPE_LABELS = buildDocTypeLabels(tx);
    const DOC_TYPE_CB_OPTIONS = buildDocTypeCbOptions(DOC_TYPE_LABELS);
    const VENDOR_LINK_TYPE_OPTIONS = useMemo(() => buildVendorLinkTypeOptions(tx), [tx]);
    const VENDOR_LINK_RELATION_OPTIONS = useMemo(() => buildVendorLinkRelationOptions(tx), [tx]);
    // PR-T — localized edit-form option arrays (the module-level consts used raw
    // enum values as labels). Reuse the read-view keys: statusOption.* / criticalityLabel.*.
    const STATUS_OPTIONS_L = useMemo<ComboboxOption[]>(
        () => ['ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'OFFBOARDED'].map((s) => ({ value: s, label: tx('statusOption.' + s) })),
        [tx],
    );
    const CRIT_OPTIONS_L = useMemo<ComboboxOption[]>(
        () => ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((c) => ({ value: c, label: tx('criticalityLabel.' + c) })),
        [tx],
    );
    // Mirrors DATA_ACCESS_OPTIONS in the create form (NewVendorFields) so the
    // edit surface offers exactly the values creation does — same enum, same
    // localized labels.
    const DATA_ACCESS_OPTIONS_L = useMemo<ComboboxOption[]>(
        () =>
            (['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const).map((v) => ({
                value: v,
                label: tx('form.' + DATA_ACCESS_LABEL_KEY[v]),
            })),
        [tx],
    );
    const DOC_TYPE_FILTER_OPTIONS = buildDocTypeFilterOptions(tx, DOC_TYPE_CB_OPTIONS);
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { permissions } = useTenantContext();
    const canWrite = permissions?.canWrite;
    const triggerUndoToast = useToastWithUndo();
    const toast = useToast();

    const [vendor, setVendor] = useState<VendorDetail | null>(null);
    const [loading, setLoading] = useState(true);
    // Seed the active tab from `?tab=` so other surfaces can deep-link to
    // a specific section. The compliance calendar uses this to land a
    // vendor-document expiry on the Documents tab rather than dropping the
    // user on Overview to hunt for it. Unknown/absent values fall back to
    // overview, so old links keep working.
    const tabParam = useSearchParams()?.get('tab');
    const [tab, setTab] = useState<Tab>(() =>
        VENDOR_TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'overview',
    );
    const [docs, setDocs] = useState<VendorDocRow[]>([]);
    const [assessments, setAssessments] = useState<VendorAssessmentRow[]>([]);
    const [editing, setEditing] = useState(false);
    const [editForm, setEditForm] = useState<VendorEditForm>({
        name: '', legalName: '', websiteUrl: '', domain: '',
        country: '', description: '', criticality: '', status: '',
        residualRisk: '', dataAccess: '',
    });

    // Doc form
    const [showDocForm, setShowDocForm] = useState(false);
    const [docForm, setDocForm] = useState({ type: 'CONTRACT', title: '', externalUrl: '', notes: '', folder: '' });
    // B4 — Documents filter state.
    const [docSearch, setDocSearch] = useState('');
    const [docTypeFilter, setDocTypeFilter] = useState('');
    // B8 — folder filter. Empty string = "all folders"; a literal
    // value matches that label exactly; `__none__` matches docs with
    // a null/empty folder so legacy unfoldered docs stay findable.
    const [docFolderFilter, setDocFolderFilter] = useState('');
    // Assessment start (legacy in-app flow)
    // Epic G-3 — send-to-vendor flow (published VendorAssessmentTemplate)
    const [sendTemplates, setSendTemplates] = useState<SendTemplateRow[]>([]);
    const [showSendModal, setShowSendModal] = useState(false);
    const [sendForm, setSendForm] = useState({
        templateVersionId: '',
        respondentEmail: '',
        respondentName: '',
        expiresInDays: 14,
    });
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);
    const [sendLink, setSendLink] = useState<string | null>(null);
    // Both returned by send/resend and both previously discarded: whether the
    // invitation email actually queued, and when the link dies.
    const [sendLinkEmailed, setSendLinkEmailed] = useState(true);
    const [sendLinkExpiresAt, setSendLinkExpiresAt] = useState<string | null>(null);
    // Dismissing the reveal destroys the only copy of the raw token. Recovery
    // means a resend, which ROTATES it and invalidates anything already
    // shared — so the dismiss is confirmed rather than instant.
    const [confirmDismissLink, setConfirmDismissLink] = useState(false);
    // Hydration-safe clock — see the note in inviteState.
    const hydratedNow = useHydratedNow();
    // Enrichment
    const [enriching, setEnriching] = useState(false);
    // Links
    const [links, setLinks] = useState<VendorLinkRow[]>([]);
    const [showLinkForm, setShowLinkForm] = useState(false);
    const [linkForm, setLinkForm] = useState({ entityType: 'ASSET', entityId: '', relation: 'RELATED' });
    // Bundles
    const [bundles, setBundles] = useState<VendorBundleRow[]>([]);
    const [bundleName, setBundleName] = useState('');
    // P3.3 — bundle-detail (expand-in-place) state.
    const [expandedBundleId, setExpandedBundleId] = useState<string | null>(null);
    const [bundleDetail, setBundleDetail] = useState<VendorBundleDetail | null>(null);
    const [bundleItemType, setBundleItemType] = useState<BundleItemType>('EVIDENCE');
    const [bundleItemId, setBundleItemId] = useState('');
    const BUNDLE_ITEM_TYPE_OPTIONS = useMemo(() => buildBundleItemTypeOptions(tx), [tx]);
    // Subprocessors
    const [subs, setSubs] = useState<VendorSubprocessorRow[]>([]);
    // PR-T — dataTypes + country are the 4th-party data-residency fields; the
    // route/usecase/model already accept them, the form just never collected them.
    const [subForm, setSubForm] = useState({ subprocessorVendorId: '', purpose: '', dataTypes: '', country: '' });
    // P3.7b — recursive subprocessor chain.
    const [chain, setChain] = useState<SubprocessorChainNode | null>(null);
    // Distinguishes "this vendor does not exist" (404) from "we could not
    // load it" (500, offline, aborted). Both used to render as
    // detail.notFound, which told the operator a vendor was deleted when the
    // server had merely failed.
    const [loadError, setLoadError] = useState<'missing' | 'failed' | null>(null);

    const fetchVendor = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const res = await fetch(apiUrl(`/vendors/${params.vendorId}`));
            if (!res.ok) {
                // A 404 genuinely means "no such vendor"; anything else is a
                // failure to load one that may well exist. Reporting a 500 as
                // "vendor doesn't exist" sends the operator looking for a
                // deletion that never happened.
                setLoadError(res.status === 404 ? 'missing' : 'failed');
                return;
            }
            const v = await res.json();
            setVendor(v);
            setEditForm({ name: v.name, legalName: v.legalName || '', websiteUrl: v.websiteUrl || '', domain: v.domain || '', country: v.country || '', description: v.description || '', criticality: v.criticality, status: v.status, residualRisk: v.residualRisk || '', dataAccess: v.dataAccess || '' });
        } catch {
            // Without this, a thrown fetch (offline, DNS, abort) skipped the
            // setLoading(false) below and left a skeleton on screen forever.
            setLoadError('failed');
        } finally {
            setLoading(false);
        }
    }, [apiUrl, params.vendorId]);

    const fetchDocs = useCallback(async () => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/documents`));
        // An `if (res.ok)` with no else renders a 403 or 500 as the "no
        // documents" empty state — the operator is told there is nothing
        // here when in fact we could not find out.
        if (res.ok) setDocs(await res.json());
        else toast.error(tx('detail.loadDocsFailed'));
    }, [apiUrl, params.vendorId]);

    const fetchAssessments = useCallback(async () => {
        // Epic G-3 — the send picker draws from the VendorAssessmentTemplate
        // model (Admin → Vendor Templates + the globally-seeded questionnaires).
        // Only PUBLISHED templates can be sent, so filter here.
        const gRes = await fetch(apiUrl(`/vendor-assessment-templates`));
        if (gRes.ok) {
            const rows = (await gRes.json()) as SendTemplateRow[];
            setSendTemplates(rows.filter((t) => t.isPublished));
        }
        // PR-S — the vendor getById payload never carried the assessments
        // relation (a regression that left this tab always empty); fetch the
        // dedicated list endpoint instead.
        const aRes = await fetch(apiUrl(`/vendors/${params.vendorId}/assessments`));
        if (aRes.ok) {
            setAssessments((await aRes.json()) as VendorAssessmentRow[]);
        }
    }, [apiUrl, params.vendorId]);

    // PR-S — resend an in-flight invite. Mints a FRESH link server-side (the
    // original is unrecoverable) and reveals it via the same CopyText affordance
    // the send flow uses, so the one-time link is no longer the only artifact.
    const handleResend = useCallback(async (assessmentId: string) => {
        try {
            const res = await fetch(apiUrl(`/vendor-assessment-reviews/${assessmentId}/resend`), { method: 'POST' });
            if (!res.ok) { toast.error(tx('detail.resendFailed')); return; }
            const result = (await res.json()) as {
                assessmentId: string;
                externalAccessToken: string;
                expiresAt?: string;
                notificationQueued?: boolean;
            };
            setSendLink(`${window.location.origin}/vendor-assessment/${result.assessmentId}?t=${result.externalAccessToken}`);
            setSendLinkExpiresAt(result.expiresAt ?? null);
            // Same honesty as the send path — a resend can also collapse in
            // the outbox dedupe, and the operator needs to know the link was
            // rotated without anyone being told.
            if (result.notificationQueued === false) {
                setSendLinkEmailed(false);
                toast.info(tx('detail.sentNotEmailedToast'));
            } else {
                setSendLinkEmailed(true);
                toast.success(tx('detail.resendToast'));
            }
            fetchAssessments();
        } catch {
            toast.error(tx('detail.resendFailed'));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchVendor(); }, [fetchVendor]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (tab === 'documents') fetchDocs(); }, [tab, fetchDocs]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (tab === 'assessments') fetchAssessments(); }, [tab, fetchAssessments]);

    const fetchLinks = useCallback(async () => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/links`));
        if (res.ok) setLinks(await res.json());
        else toast.error(tx('detail.loadLinksFailed'));
    }, [apiUrl, params.vendorId]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (tab === 'links') fetchLinks(); }, [tab, fetchLinks]);

    const fetchBundles = useCallback(async () => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/bundles`));
        if (res.ok) setBundles(await res.json());
        else toast.error(tx('detail.loadBundlesFailed'));
    }, [apiUrl, params.vendorId]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (tab === 'bundles') fetchBundles(); }, [tab, fetchBundles]);

    // P3.3 — load a single bundle's items (expand-in-place).
    const fetchBundleDetail = useCallback(async (bundleId: string) => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/bundles/${bundleId}`));
        if (res.ok) setBundleDetail(await res.json());
    }, [apiUrl, params.vendorId]);

    // Plain handlers (React Compiler auto-memoizes) — manual useCallback here
    // tripped preserve-manual-memoization because the inferred setter deps
    // didn't match the hand-written list.
    const toggleBundle = (bundleId: string) => {
        setBundleItemId('');
        setBundleItemType('EVIDENCE');
        if (expandedBundleId === bundleId) {
            setExpandedBundleId(null);
            setBundleDetail(null);
            return;
        }
        setExpandedBundleId(bundleId);
        setBundleDetail(null);
        fetchBundleDetail(bundleId);
    };

    // The add picker draws VENDOR_DOCUMENT / ASSESSMENT candidates from
    // this page's vendor-scoped lists; lazy-load them the first time
    // the operator selects that type.
    const onBundleItemTypeChange = (next: BundleItemType) => {
        setBundleItemType(next);
        setBundleItemId('');
        if (next === 'VENDOR_DOCUMENT' && docs.length === 0) fetchDocs();
        if (next === 'ASSESSMENT' && assessments.length === 0) fetchAssessments();
    };

    const addBundleItem = async (bundleId: string) => {
        if (!bundleItemId) return;
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/bundles/${bundleId}`), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entityType: bundleItemType, entityId: bundleItemId }),
        });
        if (res.ok) {
            setBundleItemId('');
            fetchBundleDetail(bundleId);
            fetchBundles();
        }
    };

    const removeBundleItem = useCallback(async (bundleId: string, itemId: string) => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/bundles/${bundleId}?itemId=${itemId}`), { method: 'DELETE' });
        if (res.ok) { fetchBundleDetail(bundleId); fetchBundles(); }
    }, [apiUrl, params.vendorId, fetchBundleDetail, fetchBundles]);

    const freezeBundle = useCallback(async (bundleId: string) => {
        if (!confirm(tx('detail.freezeConfirm'))) return;
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/bundles/${bundleId}?action=freeze`), { method: 'POST' });
        if (res.ok) {
            fetchBundles();
            if (expandedBundleId === bundleId) fetchBundleDetail(bundleId);
        }
    }, [apiUrl, params.vendorId, tx, fetchBundles, fetchBundleDetail, expandedBundleId]);

    const fetchSubs = useCallback(async () => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/subprocessors`));
        if (res.ok) setSubs(await res.json());
        else toast.error(tx('detail.loadSubsFailed'));
    }, [apiUrl, params.vendorId]);
    // P3.7b — recursive nth-party chain, fetched alongside the flat list.
    const fetchChain = useCallback(async () => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/subprocessors/chain`));
        if (res.ok) setChain(await res.json());
        else toast.error(tx('detail.loadSubsFailed'));
    }, [apiUrl, params.vendorId]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (tab === 'subprocessors') { fetchSubs(); fetchChain(); } }, [tab, fetchSubs, fetchChain]);

    const saveEdit = async () => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}`), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            // residualRisk + dataAccess are nullable: an empty selection clears
            // each one (send null rather than '', which the schema would reject).
            body: JSON.stringify({
                ...editForm,
                residualRisk: editForm.residualRisk || null,
                dataAccess: editForm.dataAccess || null,
            }),
        });
        if (res.ok) { setVendor(await res.json()); setEditing(false); }
    };

    const addDoc = async (e: React.FormEvent) => {
        e.preventDefault();
        const body: Record<string, string> = { type: docForm.type };
        if (docForm.title) body.title = docForm.title;
        if (docForm.externalUrl) body.externalUrl = docForm.externalUrl;
        if (docForm.notes) body.notes = docForm.notes;
        if (docForm.folder) body.folder = docForm.folder.trim();
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/documents`), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (res.ok) {
            const newDoc = await res.json();
            setDocs(prev => [newDoc, ...prev]);
            setShowDocForm(false);
            setDocForm({ type: 'CONTRACT', title: '', externalUrl: '', notes: '', folder: '' });
            // Also call fetchDocs just in case we need uploadedBy info, but state already has the doc
            fetchDocs();
        }
    };

    // Epic 67 — delayed-commit doc removal. The 5-second undo window
    // replaces the previous `confirm()` modal: the user gets a more
    // forgiving "you have time to take it back" affordance instead of
    // a blocking double-click. Snapshot + optimistic-filter pattern,
    // identical shape to tasks/removeLink and the other rolled-out
    // sites — see docs/destructive-actions.md.
    // Epic 67 — same shape as removeDoc below. These were bare DELETEs with
    // no confirm and no undo: one mis-click permanently detached a link or a
    // subprocessor relationship with nothing to grab. Optimistic remove,
    // 5-second window, restore on undo OR on failure.
    const removeLink = (linkId: string) => {
        const previous = links;
        setLinks(prev => prev.filter(l => l.id !== linkId));
        triggerUndoToast({
            message: tx('detail.linkRemovedToast'),
            undoMessage: tx('detail.undo'),
            action: async () => {
                const res = await fetch(
                    apiUrl(`/vendors/${params.vendorId}/links/${linkId}`),
                    { method: 'DELETE' },
                );
                if (!res.ok) throw new Error(tx('detail.removeLinkFailed'));
                fetchLinks();
            },
            undoAction: () => setLinks(previous),
            onError: () => setLinks(previous),
        });
    };

    const removeSubprocessor = (relationId: string) => {
        const previous = subs;
        setSubs(prev => prev.filter(r => r.id !== relationId));
        triggerUndoToast({
            message: tx('detail.subRemovedToast'),
            undoMessage: tx('detail.undo'),
            action: async () => {
                const res = await fetch(
                    apiUrl(`/vendors/${params.vendorId}/subprocessors?relationId=${relationId}`),
                    { method: 'DELETE' },
                );
                if (!res.ok) throw new Error(tx('detail.removeSubFailed'));
                fetchSubs();
                fetchChain();
            },
            undoAction: () => setSubs(previous),
            onError: () => setSubs(previous),
        });
    };

    const removeDoc = (docId: string) => {
        const previous = docs;
        setDocs(prev => prev.filter(d => d.id !== docId));
        triggerUndoToast({
            message: tx('detail.docRemovedToast'),
            undoMessage: tx('detail.undo'),
            action: async () => {
                const res = await fetch(
                    apiUrl(`/vendors/${params.vendorId}/documents/${docId}`),
                    { method: 'DELETE' },
                );
                if (!res.ok) throw new Error(tx('detail.removeDocFailed'));
            },
            undoAction: () => setDocs(previous),
            onError: () => setDocs(previous),
        });
    };

    // Epic G-3 — send a published VendorAssessmentTemplate to the
    // vendor's external respondent (the single assessment-creation path).
    // On success we surface the raw access link so the admin can share it
    // manually if the invite email bounces.
    const sendAssessmentToVendor = async () => {
        if (!sendForm.templateVersionId || !sendForm.respondentEmail) return;
        setSending(true);
        setSendError(null);
        try {
            const res = await fetch(
                apiUrl(`/vendors/${params.vendorId}/assessments/send`),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        templateVersionId: sendForm.templateVersionId,
                        respondentEmail: sendForm.respondentEmail.trim(),
                        respondentName: sendForm.respondentName.trim() || undefined,
                        expiresInDays: sendForm.expiresInDays,
                    }),
                },
            );
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setSendError(err?.error?.message || err?.message || tx('detail.sendFailed'));
                return;
            }
            const result = (await res.json()) as {
                assessmentId: string;
                externalAccessToken: string;
                expiresAt?: string;
                notificationQueued?: boolean;
            };
            const link = `${window.location.origin}/vendor-assessment/${result.assessmentId}?t=${result.externalAccessToken}`;
            setSendLink(link);
            setSendLinkExpiresAt(result.expiresAt ?? null);
            setShowSendModal(false);
            // sendAssessment returns notificationQueued: false when tenant
            // notifications are off or the same-day outbox dedupe collapsed
            // the send. The flag was destructured away and the toast said
            // "sent to vendor" regardless — asserting an email that never
            // left. When it is false the link exists but nobody was told, so
            // say that and let the operator deliver it themselves.
            if (result.notificationQueued === false) {
                setSendLinkEmailed(false);
                toast.info(tx('detail.sentNotEmailedToast'));
            } else {
                setSendLinkEmailed(true);
                toast.success(tx('detail.sentToast'));
            }
            fetchAssessments();
        } catch {
            setSendError(tx('detail.sendFailed'));
        } finally {
            setSending(false);
        }
    };

    const handleEnrich = async () => {
        setEnriching(true);
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/enrich`), { method: 'POST' });
        if (res.ok) { setVendor(await res.json()); }
        setEnriching(false);
    };

    const breadcrumbs = [
        { label: tx('breadcrumbDashboard'), href: tenantHref('/dashboard') },
        { label: tx('detail.crumbVendors'), href: tenantHref('/vendors') },
        { label: vendor?.name ?? tx('detail.crumbFallback') },
    ];
    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (loadError === 'failed') {
        // Retryable. The vendor may exist perfectly well — we just could not
        // reach it — so offer the retry rather than asserting it is gone.
        return (
            <EntityDetailLayout
                title=""
                breadcrumbs={breadcrumbs}
                error={{ message: tx('detail.loadFailed'), onRetry: fetchVendor }}
            >
                <></>
            </EntityDetailLayout>
        );
    }
    if (!vendor) {
        return (
            <EntityDetailLayout empty={{ message: tx('detail.notFound') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const fmtDate = (d: string | null) => d ? formatDate(d) : '—';
    const tabs: { key: Tab; label: string; count?: number }[] = [
        { key: 'overview', label: tx('detail.tabs.overview') },
        { key: 'documents', label: tx('detail.tabs.documents'), count: vendor._count?.documents || 0 },
        { key: 'assessments', label: tx('detail.tabs.assessments'), count: vendor._count?.assessments || 0 },
        { key: 'monitoring', label: tx('detail.tabs.monitoring') },
        { key: 'links', label: tx('detail.tabs.links') },
        { key: 'bundles', label: tx('detail.tabs.bundles') },
        { key: 'subprocessors', label: tx('detail.tabs.subprocessors') },
        { key: 'tasks', label: tx('detail.tabs.tasks') },
    ];

    return (
        <EntityDetailLayout
            id="vendor-detail-page"
            back={{ smart: true }}
            breadcrumbs={breadcrumbs}

            title={<span id="vendor-detail-name">{vendor.name}</span>}
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            label: tx('detail.status'),
                            value: tx('statusOption.' + vendor.status),
                            variant:
                                VENDOR_STATUS_VARIANT[vendor.status] ??
                                'neutral',
                        },
                        {
                            kind: 'status',
                            label: tx('detail.criticality'),
                            value: tx('criticalityLabel.' + vendor.criticality),
                            variant:
                                VENDOR_CRITICALITY_VARIANT[
                                    vendor.criticality
                                ] ?? 'neutral',
                        },
                    ]}
                />
            }
            actions={
                <>
                    {canWrite && (vendor.domain || vendor.websiteUrl) && (
                        <Button variant="secondary" onClick={handleEnrich} disabled={enriching} id="enrich-vendor-btn">
                            {enriching ? tx('detail.enriching') : tx('detail.autofill')}
                        </Button>
                    )}
                    {canWrite && !editing && (
                        // B2 — icon-only edit affordance.
                        <Tooltip content={tx('detail.editVendor')}>
                            <Button
                                variant="secondary"
                                size="icon"
                                onClick={() => setEditing(true)}
                                id="edit-vendor-btn"
                                aria-label={tx('detail.editVendor')}
                            >
                                <Pen2 className="size-4" />
                            </Button>
                        </Tooltip>
                    )}
                </>
            }
            tabs={tabs}
            activeTab={tab}
            onTabChange={(next) => setTab(next as Tab)}
        >
            {/* OVERVIEW */}
            {tab === 'overview' && !editing && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <div className="grid grid-cols-2 gap-default text-sm">
                        <div><span className="text-content-muted">{tx('detail.legalName')}:</span> <span className="ml-2">{vendor.legalName || '—'}</span></div>
                        <div><span className="text-content-muted">{tx('detail.domain')}:</span> <span className="ml-2">{vendor.domain || '—'}</span></div>
                        <div><span className="text-content-muted">{tx('detail.website')}:</span> <span className="ml-2">{normaliseHref(vendor.websiteUrl) ? <a href={normaliseHref(vendor.websiteUrl)!} target="_blank" rel="noopener noreferrer" className="text-content-info underline">{vendor.websiteUrl}</a> : '—'}</span></div>
                        <div><span className="text-content-muted">{tx('detail.country')}:</span> <span className="ml-2">{vendor.country || '—'}</span></div>
                        <div><span className="text-content-muted">{tx('detail.owner')}:</span> <span className="ml-2">{vendor.owner?.name || '—'}</span></div>
                        <div><span className="text-content-muted">{tx('detail.dataAccess')}:</span> <span className="ml-2">{vendor.dataAccess ? tx('form.' + (DATA_ACCESS_LABEL_KEY[vendor.dataAccess] ?? 'dataNone')) : '—'}</span></div>
                        <div><span className="text-content-muted">{tx('detail.subprocessor')}:</span> <span className="ml-2">{vendor.isSubprocessor ? tx('detail.yes') : tx('detail.no')}</span></div>
                        <div>
                            <span className="text-content-muted">{tx('detail.inherentRisk')}:</span>
                            <InfoTooltip content={tx('detail.inherentRiskHint')} aria-label={tx('detail.inherentRiskHint')} iconClassName="ml-1 align-text-bottom" />
                            <span className="ml-2">{vendor.inherentRisk ? <StatusBadge variant={CRIT_BADGE[vendor.inherentRisk]}>{tx('criticalityLabel.' + vendor.inherentRisk)}</StatusBadge> : '—'}</span>
                        </div>
                        <div><span className="text-content-muted">{tx('detail.nextReview')}:</span> <span className="ml-2">{fmtDate(vendor.nextReviewAt)}</span></div>
                        <div id="vendor-contract-renewal" className="scroll-mt-24"><span className="text-content-muted">{tx('detail.contractRenewal')}:</span> <span className="ml-2">{fmtDate(vendor.contractRenewalAt)}</span></div>
                    </div>
                    {/* Enrichment Fields */}
                    {(vendor.privacyPolicyUrl || vendor.securityPageUrl || vendor.certificationsJson) && (
                        <div className="border-t border-border-default pt-3 mt-3 space-y-tight">
                            <Heading level={3}>{tx('detail.enrichmentData')}</Heading>
                            <div className="grid grid-cols-2 gap-compact text-sm">
                                {normaliseHref(vendor.privacyPolicyUrl) && <div><span className="text-content-muted">{tx('detail.privacyPolicy')}:</span> <a href={normaliseHref(vendor.privacyPolicyUrl)!} target="_blank" rel="noopener noreferrer" className="text-content-info underline ml-1" id="enrichment-privacy">{tx('detail.viewLink')}</a></div>}
                                {normaliseHref(vendor.securityPageUrl) && <div><span className="text-content-muted">{tx('detail.securityPage')}:</span> <a href={normaliseHref(vendor.securityPageUrl)!} target="_blank" rel="noopener noreferrer" className="text-content-info underline ml-1" id="enrichment-security">{tx('detail.viewLink')}</a></div>}
                                {vendor.certificationsJson && Array.isArray(vendor.certificationsJson) && (
                                    <div className="col-span-2"><span className="text-content-muted">{tx('detail.certifications')}:</span> {(vendor.certificationsJson as string[]).map((c: string) => <StatusBadge variant="info" className="ml-1" key={c}>{c}</StatusBadge>)}</div>
                                )}
                            </div>
                            {vendor.enrichmentLastRunAt && <p className="text-xs text-content-subtle">{tx('detail.lastEnriched', { date: fmtDate(vendor.enrichmentLastRunAt), status: vendor.enrichmentStatus ?? '' })}</p>}
                        </div>
                    )}
                    {vendor.description && <div className="text-sm text-content-default border-t border-border-default pt-3 mt-3">{vendor.description}</div>}
                </div>
            )}

            {/* EDIT FORM */}
            {tab === 'overview' && editing && canWrite && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <div className="grid grid-cols-2 gap-default">
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{tx('detail.name')}</label>
                            <input className="input w-full" value={editForm.name} onChange={e => setEditForm((p) => ({ ...p, name: e.target.value }))} />
                        </div>
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{tx('detail.legalName')}</label>
                            <input className="input w-full" value={editForm.legalName} onChange={e => setEditForm((p) => ({ ...p, legalName: e.target.value }))} />
                        </div>
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{tx('detail.status')}</label>
                            <Combobox hideSearch selected={STATUS_OPTIONS_L.find(o => o.value === editForm.status) ?? null} setSelected={(opt) => setEditForm((p) => ({ ...p, status: opt?.value ?? p.status }))} options={STATUS_OPTIONS_L} matchTriggerWidth />
                        </div>
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{tx('detail.criticality')}</label>
                            <Combobox hideSearch selected={CRIT_OPTIONS_L.find(o => o.value === editForm.criticality) ?? null} setSelected={(opt) => setEditForm((p) => ({ ...p, criticality: opt?.value ?? p.criticality }))} options={CRIT_OPTIONS_L} matchTriggerWidth />
                        </div>
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{tx('detail.residualRisk')}</label>
                            {/* Nullable: the leading option clears residualRisk (sent as null). */}
                            <Combobox
                                hideSearch
                                selected={
                                    editForm.residualRisk
                                        ? { value: editForm.residualRisk, label: tx('criticalityLabel.' + editForm.residualRisk) }
                                        : { value: '', label: tx('detail.residualRiskNone') }
                                }
                                setSelected={(opt) => setEditForm((p) => ({ ...p, residualRisk: opt?.value ?? '' }))}
                                options={[{ value: '', label: tx('detail.residualRiskNone') }, ...CRIT_OPTIONS_L]}
                                matchTriggerWidth
                            />
                        </div>
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{tx('detail.dataAccess')}</label>
                            {/* Nullable, and manually owned — nothing writes dataAccess
                                except create/update, so it is safe to edit here. It was
                                accepted by UpdateVendorSchema and settable at creation but
                                absent from this form, which froze it at its creation value. */}
                            <Combobox
                                hideSearch
                                selected={
                                    editForm.dataAccess
                                        ? { value: editForm.dataAccess, label: tx('form.' + DATA_ACCESS_LABEL_KEY[editForm.dataAccess]) }
                                        : { value: '', label: tx('form.dataAccessPlaceholder') }
                                }
                                setSelected={(opt) => setEditForm((p) => ({ ...p, dataAccess: opt?.value ?? '' }))}
                                options={[{ value: '', label: tx('form.dataAccessPlaceholder') }, ...DATA_ACCESS_OPTIONS_L]}
                                matchTriggerWidth
                            />
                        </div>
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{tx('detail.inherentRisk')}</label>
                            {/* Deliberately READ-ONLY. `inherentRisk` is assessment-derived:
                                every review writeback overwrites it with the assessment's
                                riskRating (applyAssessmentRiskWriteback). Exposing an editor
                                would let a user set a value that the next review silently
                                discards — worse than not offering the control at all.
                                Change it by reviewing an assessment, not by typing. */}
                            <p className="text-sm text-content-default py-2">
                                {vendor.inherentRisk ? tx('criticalityLabel.' + vendor.inherentRisk) : '—'}
                            </p>
                            <p className="text-xs text-content-muted">{tx('detail.inherentRiskReadOnly')}</p>
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm text-content-muted mb-1">{tx('detail.description')}</label>
                        <textarea className="input w-full h-20" value={editForm.description} onChange={e => setEditForm((p) => ({ ...p, description: e.target.value }))} />
                    </div>
                    <div className="flex gap-compact">
                        <Button variant="primary" onClick={saveEdit} id="save-vendor-btn">{tx('detail.save')}</Button>
                        <Button variant="secondary" onClick={() => setEditing(false)}>{tx('detail.cancel')}</Button>
                    </div>
                </div>
            )}

            {/* DOCUMENTS */}
            {tab === 'documents' && (
                <div className="space-y-default">
                    {/* B4 — Documents filter placement consistency.
                        Pre-B4 the docs tab had only the primary
                        action button on the right; list pages
                        elsewhere in the product carry search + filter
                        controls on the LEFT and the action button on
                        the right. The compact filter row below
                        mirrors that pattern: search input + type
                        filter on the left, "Add document" button on
                        the right. */}
                    <div className="flex flex-wrap items-center gap-compact justify-between">
                        <div className="flex flex-wrap items-center gap-compact min-w-0">
                            <input
                                type="search"
                                className="input w-64 max-w-full"
                                placeholder={tx('detail.searchDocs')}
                                value={docSearch}
                                onChange={(e) => setDocSearch(e.target.value)}
                                id="doc-search-input"
                                aria-label={tx('detail.searchDocsAria')}
                            />
                            <Combobox
                                hideSearch
                                id="doc-type-filter"
                                selected={DOC_TYPE_FILTER_OPTIONS.find((o) => o.value === docTypeFilter) ?? null}
                                setSelected={(opt) => setDocTypeFilter(opt?.value ?? '')}
                                options={DOC_TYPE_FILTER_OPTIONS}
                                placeholder={tx('detail.allTypes')}
                            />
                            {/* B8 — Folder filter. Options are derived
                                from the loaded docs (each unique
                                non-empty `folder` value) plus a
                                "no folder" bucket if any unfoldered
                                doc exists. Hidden entirely when no
                                folder has ever been assigned. */}
                            {(() => {
                                const folderSet = new Set<string>();
                                let hasUnfoldered = false;
                                for (const d of docs as Array<{ folder?: string | null }>) {
                                    const f = (d.folder || '').trim();
                                    if (f) folderSet.add(f);
                                    else hasUnfoldered = true;
                                }
                                if (folderSet.size === 0 && !hasUnfoldered) return null;
                                const folderOptions = [
                                    { value: '', label: tx('detail.allFolders') },
                                    ...(hasUnfoldered ? [{ value: '__none__', label: tx('detail.folderNone') }] : []),
                                    ...Array.from(folderSet).sort().map((f) => ({ value: f, label: f })),
                                ];
                                return (
                                    <Combobox
                                        hideSearch
                                        id="doc-folder-filter"
                                        data-testid="doc-folder-filter"
                                        selected={folderOptions.find((o) => o.value === docFolderFilter) ?? folderOptions[0]}
                                        setSelected={(opt) => setDocFolderFilter(opt?.value ?? '')}
                                        options={folderOptions}
                                        placeholder={tx('detail.allFolders')}
                                    />
                                );
                            })()}
                        </div>
                        {canWrite && (
                            <Button
                                variant="primary"
                                icon={showDocForm ? undefined : <Plus />}
                                onClick={() => setShowDocForm(!showDocForm)}
                                id="add-doc-btn"
                            >
                                {showDocForm ? tx('detail.cancel') : tx('detail.addDocument')}
                            </Button>
                        )}
                    </div>
                    {showDocForm && canWrite && (
                        <form onSubmit={addDoc} className={cn(cardVariants({ density: 'compact' }), 'space-y-compact')}>
                            <div className="grid grid-cols-2 gap-compact">
                                <div>
                                    <label className="block text-sm text-content-muted mb-1">{tx('detail.type')}</label>
                                    <Combobox hideSearch id="doc-type-select" selected={DOC_TYPE_CB_OPTIONS.find(o => o.value === docForm.type) ?? null} setSelected={(opt) => setDocForm(p => ({ ...p, type: opt?.value ?? p.type }))} options={DOC_TYPE_CB_OPTIONS} matchTriggerWidth />
                                </div>
                                <div>
                                    <label className="block text-sm text-content-muted mb-1">{tx('detail.title')}</label>
                                    <input className="input w-full" value={docForm.title} onChange={e => setDocForm(p => ({ ...p, title: e.target.value }))} id="doc-title-input" />
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{tx('detail.externalUrl')}</label>
                                <input className="input w-full" type="url" value={docForm.externalUrl} onChange={e => setDocForm(p => ({ ...p, externalUrl: e.target.value }))} placeholder="https://..." id="doc-url-input" />
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{tx('detail.notes')}</label>
                                <input className="input w-full" value={docForm.notes} onChange={e => setDocForm(p => ({ ...p, notes: e.target.value }))} id="doc-notes-input" />
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1" htmlFor="doc-folder-input">
                                    {tx('detail.folder')} <span className="text-content-subtle font-normal">{tx('detail.optional')}</span>
                                </label>
                                <input
                                    className="input w-full"
                                    id="doc-folder-input"
                                    placeholder={tx('detail.folderPlaceholder')}
                                    list="doc-folder-suggestions"
                                    value={docForm.folder}
                                    onChange={(e) => setDocForm((p) => ({ ...p, folder: e.target.value }))}
                                />
                                {/* B8 — datalist seeds the folder
                                    input with the values already in
                                    use on this vendor's docs so the
                                    user can pick "Contracts/2026"
                                    again without re-typing. */}
                                <datalist id="doc-folder-suggestions">
                                    {Array.from(
                                        new Set(
                                            (docs as Array<{ folder?: string | null }>)
                                                .map((d) => (d.folder || '').trim())
                                                .filter(Boolean),
                                        ),
                                    )
                                        .sort()
                                        .map((f) => (
                                            <option key={f} value={f} />
                                        ))}
                                </datalist>
                            </div>
                            <Button type="submit" variant="primary" icon={<Plus className="-ml-0.5 -mr-2.5" />} id="submit-doc-btn">{tx('detail.addDocument')}</Button>
                        </form>
                    )}
                    {/* B4 — apply the search + type filters in-memory.
                        Docs are pre-loaded in a single GET; client-side
                        filter is the right shape for a tab with at
                        most a few dozen rows per vendor. */}
                    <VendorDocsTable
                        docs={docs.filter((d) => {
                            if (docTypeFilter && d.type !== docTypeFilter) return false;
                            // B8 — folder filter. `''` keeps every
                            // doc; `'__none__'` keeps only unfoldered;
                            // any other value matches exactly.
                            if (docFolderFilter) {
                                const folder = (d.folder || '').trim();
                                if (docFolderFilter === '__none__') {
                                    if (folder) return false;
                                } else if (folder !== docFolderFilter) {
                                    return false;
                                }
                            }
                            if (docSearch.trim()) {
                                const q = docSearch.trim().toLowerCase();
                                const haystack = `${d.title || ''} ${d.notes || ''} ${d.folder || ''} ${DOC_TYPE_LABELS[d.type] || ''}`.toLowerCase();
                                if (!haystack.includes(q)) return false;
                            }
                            return true;
                        })}
                        canWrite={canWrite}
                        onRemove={removeDoc}
                    />
                </div>
            )}

            {/* ASSESSMENTS */}
            {tab === 'assessments' && (
                <div className="space-y-default">
                    {canWrite && (
                        <div className="flex items-center gap-compact justify-end">
                            {/* Epic G-3 — the single assessment-creation path:
                                pick a published VendorAssessmentTemplate and
                                email it to the vendor's respondent. The legacy
                                in-app "Start" flow (a separate QuestionnaireTemplate
                                model that never surfaced the tenant's own
                                questionnaire templates) was retired in favour of
                                this unified flow. */}
                            <Button
                                variant="primary"
                                onClick={() => {
                                    setSendError(null);
                                    setShowSendModal(true);
                                }}
                                id="send-assessment-btn"
                            >
                                {tx('detail.sendAssessment')}
                            </Button>
                        </div>
                    )}
                    {/* Epic G-3 — reveal the raw access link after a send
                        so the admin can share it manually (e.g. the
                        invite email bounced). Shown until dismissed. */}
                    {sendLink && (
                        <div className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')} id="send-assessment-link">
                            <div className="flex items-center justify-between gap-compact">
                                <Heading level={3}>{tx('detail.assessmentLink')}</Heading>
                                <button
                                    className="text-content-muted text-xs hover:underline"
                                    onClick={() => setConfirmDismissLink(true)}
                                >
                                    {tx('detail.dismiss')}
                                </button>
                            </div>
                            {/* The hint used to assert the invitation WAS
                                emailed. It is only true when the outbox
                                actually queued it — otherwise the link exists
                                and nobody has been told, which makes copying
                                it the operator's job, not an afterthought. */}
                            <p className={cn('text-xs', sendLinkEmailed ? 'text-content-muted' : 'text-content-warning')}>
                                {sendLinkEmailed
                                    ? tx('detail.linkShareHint')
                                    : tx('detail.linkNotEmailedHint')}
                            </p>
                            {sendLinkExpiresAt && (
                                <p className="text-xs text-content-muted">
                                    {tx('detail.linkExpiresOn', {
                                        date: formatDate(sendLinkExpiresAt),
                                    })}
                                </p>
                            )}
                            {/* This is the ONLY time this token is ever
                                visible — only its SHA-256 is stored. Say so,
                                and make copying the primary affordance. */}
                            <p className="text-xs text-content-muted">
                                {tx('detail.linkOneTimeWarning')}
                            </p>
                            <CopyText value={sendLink} label={tx('detail.copyLink')} truncate className="text-xs">
                                {sendLink}
                            </CopyText>
                        </div>
                    )}
                    {/* PR-S — Outstanding / awaiting-response: SENT + IN_PROGRESS
                        assessments the review queue excludes. Each carries a
                        resend action (fresh link) + the sent date, so an admin can
                        see what's outstanding and chase it. */}
                    {(() => {
                        const outstanding = assessments.filter(
                            (a) => a.status === 'SENT' || a.status === 'IN_PROGRESS',
                        );
                        if (outstanding.length === 0) return null;
                        return (
                            <div className={cn(cardVariants({ density: 'compact' }), 'space-y-default')} id="outstanding-assessments">
                                <Heading level={3}>{tx('detail.outstandingTitle')}</Heading>
                                <div className="space-y-tight">
                                    {outstanding.map((a) => (
                                        <div key={a.id} className="flex flex-wrap items-center justify-between gap-compact border-b border-border-subtle pb-2 last:border-0 last:pb-0">
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium truncate">{a.templateName || '—'}</p>
                                                <p className="text-xs text-content-muted truncate">
                                                    {a.respondentEmail || '—'}
                                                    {' · '}
                                                    {tx('detail.sentOn', { date: a.sentAt ? formatDate(a.sentAt) : '—' })}
                                                    {a.inviteExpiresAt && (
                                                        <>
                                                            {' · '}
                                                            {tx('detail.linkExpiresOn', {
                                                                date: formatDate(a.inviteExpiresAt),
                                                            })}
                                                        </>
                                                    )}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-tight">
                                                {/* A dead invite is the one thing this row must not hide.
                                                    "Awaiting response" is misleading when the respondent
                                                    has had no working link for weeks — the wait is on us
                                                    to resend, not on them to reply. */}
                                                {(() => {
                                                    const state = inviteState(a, hydratedNow);
                                                    if (state === 'live') return null;
                                                    return (
                                                        <StatusBadge variant="warning">
                                                            {state === 'revoked'
                                                                ? tx('detail.inviteRevoked')
                                                                : tx('detail.inviteExpired')}
                                                        </StatusBadge>
                                                    );
                                                })()}
                                                {/* Quiet status text (not a loud badge) — the section header
                                                    already says these are awaiting a response; the main table
                                                    below carries the one loud status badge per assessment. */}
                                                <span className="text-xs text-content-subtle">
                                                    {tx(vendorAssessmentStatusLabelKey(a.status))}
                                                </span>
                                                <Button variant="secondary" size="xs" onClick={() => handleResend(a.id)} id={`resend-assessment-${a.id}`}>
                                                    {tx('detail.resendInvite')}
                                                </Button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })()}
                    <VendorAssessmentsTable
                        assessments={assessments}
                        vendorId={params.vendorId}
                        tenantHref={tenantHref}
                    />
                    {/* Epic G-3 — send modal */}
                    <Modal
                        showModal={showSendModal}
                        setShowModal={setShowSendModal}
                        title={tx('detail.sendAssessment')}
                        description={tx('detail.sendModalDesc')}
                    >
                        <Modal.Header
                            title={tx('detail.sendAssessment')}
                            description={tx('detail.sendModalDesc')}
                        />
                        <Modal.Body>
                            <div className="space-y-default">
                                <FormField label={tx('detail.template')}>
                                    <Combobox
                                        id="send-template-select"
                                        selected={
                                            sendTemplates
                                                .map((t) => ({
                                                    value: t.id,
                                                    label: tx('detail.templateOption', { name: t.name, count: t._count?.questions || 0 }) + (t.isGlobal ? tx('detail.globalSuffix') : ''),
                                                }))
                                                .find((o) => o.value === sendForm.templateVersionId) ?? null
                                        }
                                        setSelected={(opt) =>
                                            setSendForm((p) => ({ ...p, templateVersionId: opt?.value ?? '' }))
                                        }
                                        options={sendTemplates.map((t) => ({
                                            value: t.id,
                                            label: tx('detail.templateOption', { name: t.name, count: t._count?.questions || 0 }) + (t.isGlobal ? tx('detail.globalSuffix') : ''),
                                        }))}
                                        placeholder={
                                            sendTemplates.length === 0
                                                ? tx('detail.templatesNonePublished')
                                                : tx('detail.selectTemplate')
                                        }
                                        matchTriggerWidth
                                    />
                                </FormField>
                                {sendTemplates.length === 0 && (
                                    <p className="text-xs text-content-muted -mt-1">
                                        {tx('detail.templatesNoneHint')}{' '}
                                        <Link
                                            href={tenantHref('/admin/vendor-templates')}
                                            className="text-content-info hover:underline"
                                            id="send-modal-builder-link"
                                        >
                                            {tx('detail.templatesBuilderLink')}
                                        </Link>
                                    </p>
                                )}
                                <FormField label={tx('detail.respondentEmail')} required>
                                    <Input
                                        id="send-respondent-email"
                                        type="email"
                                        value={sendForm.respondentEmail}
                                        onChange={(e) =>
                                            setSendForm((p) => ({ ...p, respondentEmail: e.target.value }))
                                        }
                                        placeholder={tx('detail.respondentEmailPlaceholder')}
                                    />
                                </FormField>
                                <FormField label={tx('detail.respondentName')}>
                                    <Input
                                        id="send-respondent-name"
                                        value={sendForm.respondentName}
                                        onChange={(e) =>
                                            setSendForm((p) => ({ ...p, respondentName: e.target.value }))
                                        }
                                        placeholder={tx('detail.optionalPlaceholder')}
                                    />
                                </FormField>
                                <FormField label={tx('detail.expiresInDays')}>
                                    <NumberStepper
                                        id="send-expires-days"
                                        value={sendForm.expiresInDays}
                                        onChange={(v) => setSendForm((p) => ({ ...p, expiresInDays: v }))}
                                        min={1}
                                        max={90}
                                    />
                                </FormField>
                                {sendError && (
                                    <p className="text-sm text-content-error" id="send-assessment-error">
                                        {sendError}
                                    </p>
                                )}
                            </div>
                        </Modal.Body>
                        <Modal.Footer>
                            <Modal.Actions>
                                <Button
                                    variant="secondary"
                                    onClick={() => setShowSendModal(false)}
                                >
                                    {tx('detail.cancel')}
                                </Button>
                                <Button
                                    variant="primary"
                                    onClick={sendAssessmentToVendor}
                                    disabled={
                                        sending ||
                                        !sendForm.templateVersionId ||
                                        !sendForm.respondentEmail.trim()
                                    }
                                    id="confirm-send-assessment"
                                >
                                    {sending ? tx('detail.sending') : tx('detail.sendAssessment')}
                                </Button>
                            </Modal.Actions>
                        </Modal.Footer>
                    </Modal>
                </div>
            )}

            {/* MONITORING — continuous posture (breach / attestation / TLS) */}
            {tab === 'monitoring' && (
                <VendorMonitoringPanel
                    tenantSlug={params.tenantSlug}
                    vendorId={params.vendorId}
                    canWrite={!!canWrite}
                    onChange={fetchVendor}
                />
            )}

            {/* LINKS / TRACEABILITY */}
            {tab === 'links' && (
                <div className="space-y-default">
                    {canWrite && (
                        <div className="flex justify-end">
                            <Button variant="primary" onClick={() => setShowLinkForm(!showLinkForm)} id="add-link-btn">
                                {showLinkForm ? tx('detail.cancel') : tx('detail.linkEntity')}
                            </Button>
                        </div>
                    )}
                    {showLinkForm && canWrite && (
                        <div className={cn(cardVariants({ density: 'compact' }), 'flex items-end gap-compact')}>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{tx('detail.type')}</label>
                                <Combobox hideSearch id="link-type" selected={VENDOR_LINK_TYPE_OPTIONS.find(o => o.value === linkForm.entityType) ?? null} setSelected={(opt) => setLinkForm(p => ({ ...p, entityType: opt?.value ?? p.entityType }))} options={VENDOR_LINK_TYPE_OPTIONS} matchTriggerWidth />
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{tx('detail.entity')}</label>
                                {/* PR-D — entity picker replaces the
                                    legacy "Paste ID" input. The
                                    `Type` Combobox above drives the
                                    candidate set; selecting writes
                                    the cuid into linkForm.entityId
                                    so the existing submit handler is
                                    unchanged. */}
                                <EntityPicker
                                    tenantSlug={params.tenantSlug}
                                    entityType={linkForm.entityType as EntityPickerKind}
                                    value={linkForm.entityId}
                                    onChange={(id) => setLinkForm((p) => ({ ...p, entityId: id }))}
                                    id="link-entity-id"
                                    testId="vendor-link-entity-picker"
                                    placeholder={tx('detail.selectEntity')}
                                    className="w-48"
                                />
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{tx('detail.relation')}</label>
                                <Combobox hideSearch id="link-relation" selected={VENDOR_LINK_RELATION_OPTIONS.find(o => o.value === linkForm.relation) ?? null} setSelected={(opt) => setLinkForm(p => ({ ...p, relation: opt?.value ?? p.relation }))} options={VENDOR_LINK_RELATION_OPTIONS} matchTriggerWidth />
                            </div>
                            <Button variant="primary" id="submit-link-btn" onClick={async () => {
                                // The write is now checked before the form is
                                // torn down. Previously a 400 (unresolvable
                                // target) or 403 closed the form and cleared
                                // the input exactly like a success, leaving
                                // the missing link as the only clue.
                                const res = await fetch(apiUrl(`/vendors/${params.vendorId}/links`), {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(linkForm),
                                });
                                if (!res.ok) { toast.error(tx('detail.addLinkFailed')); return; }
                                toast.success(tx('detail.addLinkToast'));
                                setShowLinkForm(false); setLinkForm({ entityType: 'ASSET', entityId: '', relation: 'RELATED' }); fetchLinks();
                            }}>{tx('detail.add')}</Button>
                        </div>
                    )}
                    {['ASSET', 'RISK', 'ISSUE', 'CONTROL'].map(type => {
                        const typeLinks = links.filter((l) => l.entityType === type);
                        if (typeLinks.length === 0) return null;
                        return (
                            <div key={type} className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')}>
                                {/* Was tx('detail.linkGroup', { type }) against the
                                    message '{type}s ({count})', which rendered the raw
                                    enum plus an English plural — "ASSETs (2)". The
                                    linkType.* keys the ADD form uses are right there. */}
                                <Heading level={3}>
                                    {tx('detail.linkGroupNamed', {
                                        type: tx(`linkType.${type}`),
                                        count: typeLinks.length,
                                    })}
                                </Heading>
                                {typeLinks.map((l) => {
                                    const buildHref = LINK_ENTITY_HREF[l.entityType];
                                    // `entityName` IS resolved server-side (listVendorLinks
                                    // batch-loads names per entityType). It stays nullable
                                    // for links whose target no longer resolves — deleted or
                                    // soft-deleted rows — so keep the raw-id fallback: a
                                    // dangling link should still render and link out rather
                                    // than collapse to an empty row.
                                    const label = l.entityName ?? (
                                        <code className="text-xs">{l.entityId}</code>
                                    );
                                    return (
                                        <div key={l.id} className="flex items-center justify-between text-sm border-b border-border-subtle py-1">
                                            <span>
                                                {buildHref ? (
                                                    <Link href={tenantHref(buildHref(l.entityId))} className="text-content-info hover:underline">
                                                        {label}
                                                    </Link>
                                                ) : (
                                                    <code className="text-xs text-content-info">{l.entityId}</code>
                                                )}
                                                <StatusBadge variant="neutral" className="ml-1">
                                                    {tx(`linkRelation.${l.relation}`)}
                                                </StatusBadge>
                                            </span>
                                            {canWrite && (
                                                <button
                                                    className="text-content-error text-xs"
                                                    onClick={() => removeLink(l.id)}
                                                >
                                                    {tx('detail.remove')}
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })}
                    {links.length === 0 && (
                        <InlineEmptyState
                            title={tx('detail.linksEmptyTitle')}
                            description={tx('detail.linksEmptyDesc')}
                        />
                    )}
                </div>
            )}

            {/* EVIDENCE BUNDLES */}
            {tab === 'bundles' && (
                <div className="space-y-default">
                    {canWrite && (
                        <div className="flex items-center gap-tight justify-end">
                            <input className="input w-48" placeholder={tx('detail.bundleNamePlaceholder')} value={bundleName}
                                onChange={e => setBundleName(e.target.value)} id="bundle-name-input" />
                            <Button variant="primary" disabled={!bundleName} id="create-bundle-btn" onClick={async () => {
                                await fetch(apiUrl(`/vendors/${params.vendorId}/bundles`), {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ name: bundleName }),
                                });
                                setBundleName(''); fetchBundles();
                            }}>{tx('detail.createBundle')}</Button>
                        </div>
                    )}
                    {bundles.map((b) => {
                        const expanded = expandedBundleId === b.id;
                        const detail = expanded ? bundleDetail : null;
                        const itemCount = detail ? detail.items.length : (b._count?.items || 0);
                        return (
                        <div key={b.id} className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')}>
                            <div className="flex items-center justify-between">
                                <button
                                    type="button"
                                    className="flex items-center gap-tight text-left hover:underline"
                                    aria-expanded={expanded}
                                    onClick={() => toggleBundle(b.id)}
                                    id={`toggle-bundle-${b.id}`}
                                >
                                    <ChevronRight className={cn('size-3.5 text-content-muted transition-transform', expanded && 'rotate-90')} />
                                    <span className="font-medium">{b.name}</span>
                                    <span className="text-xs text-content-muted">{tx('detail.bundleItems', { count: itemCount })}</span>
                                    {b.frozenAt && <StatusBadge variant="success">{tx('detail.frozen')}</StatusBadge>}
                                </button>
                                {canWrite && !b.frozenAt && (
                                    <Button
                                        variant="secondary"
                                        size="xs"
                                        id={`freeze-bundle-${b.id}`}
                                        disabled={itemCount === 0}
                                        onClick={() => freezeBundle(b.id)}
                                    >{tx('detail.freeze')}</Button>
                                )}
                            </div>
                            <div className="text-xs text-content-muted">{tx('detail.bundleCreatedBy', { name: b.createdBy?.name || '—', date: formatDate(b.createdAt) })}</div>
                            {/* P3.3 — bundle-detail: items + add/remove. */}
                            {expanded && (
                                <div className="border-t border-border-subtle pt-2 mt-1 space-y-tight">
                                    {!detail && <p className="text-xs text-content-muted">{tCommon('ui.loading')}</p>}
                                    {detail && detail.items.length === 0 && (
                                        <p className="text-xs text-content-muted">{tx('detail.bundleNoItems')}</p>
                                    )}
                                    {detail?.items.map((it) => {
                                        // Hydrate the frozen snapshot's display name (VENDOR_DOCUMENT
                                        // freezes `title`); fall back to the raw id when no snapshot
                                        // name is available. Hyperlink only entity types with a real
                                        // tenant detail route (CONTROL via LINK_ENTITY_HREF).
                                        const snap = it.snapshotJson as { title?: string; name?: string } | undefined;
                                        const snapName = snap?.title ?? snap?.name ?? null;
                                        const buildItemHref = LINK_ENTITY_HREF[it.entityType];
                                        return (
                                        <div key={it.id} className="flex items-center justify-between text-sm border-b border-border-subtle py-1">
                                            <span className="flex items-center gap-tight min-w-0">
                                                <StatusBadge variant="neutral">{tx('detail.bundleItemTypes.' + it.entityType)}</StatusBadge>
                                                {buildItemHref ? (
                                                    <Link href={tenantHref(buildItemHref(it.entityId))} className="text-content-info hover:underline truncate">
                                                        {snapName ?? it.entityId}
                                                    </Link>
                                                ) : snapName ? (
                                                    <span className="truncate">{snapName}</span>
                                                ) : (
                                                    <code className="text-xs text-content-muted truncate">{it.entityId}</code>
                                                )}
                                            </span>
                                            {canWrite && !detail.frozenAt && (
                                                <button
                                                    className="text-content-error text-xs"
                                                    onClick={() => removeBundleItem(b.id, it.id)}
                                                    id={`remove-bundle-item-${it.id}`}
                                                >{tx('detail.remove')}</button>
                                            )}
                                        </div>
                                        );
                                    })}
                                    {/* Add-item control — hidden once frozen. */}
                                    {canWrite && detail && !detail.frozenAt && (
                                        <div className="flex flex-wrap items-end gap-compact pt-1">
                                            <div>
                                                <label className="block text-sm text-content-muted mb-1">{tx('detail.type')}</label>
                                                <Combobox
                                                    hideSearch
                                                    id={`bundle-item-type-${b.id}`}
                                                    selected={BUNDLE_ITEM_TYPE_OPTIONS.find((o) => o.value === bundleItemType) ?? null}
                                                    setSelected={(opt) => onBundleItemTypeChange((opt?.value ?? 'EVIDENCE') as BundleItemType)}
                                                    options={BUNDLE_ITEM_TYPE_OPTIONS}
                                                    matchTriggerWidth
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-sm text-content-muted mb-1">{tx('detail.bundleItemEntity')}</label>
                                                {bundleItemType === 'EVIDENCE' || bundleItemType === 'CONTROL' ? (
                                                    <EntityPicker
                                                        tenantSlug={params.tenantSlug}
                                                        entityType={bundleItemType as EntityPickerKind}
                                                        value={bundleItemId}
                                                        onChange={setBundleItemId}
                                                        id={`bundle-item-entity-${b.id}`}
                                                        testId="vendor-bundle-item-picker"
                                                        placeholder={tx('detail.selectEntity')}
                                                        className="w-56"
                                                    />
                                                ) : (
                                                    <Combobox
                                                        id={`bundle-item-entity-${b.id}`}
                                                        options={
                                                            bundleItemType === 'VENDOR_DOCUMENT'
                                                                ? docs.map((d) => ({ value: d.id, label: d.title || DOC_TYPE_LABELS[d.type] || d.type }))
                                                                : assessments.map((a) => ({ value: a.id, label: a.templateName || a.id }))
                                                        }
                                                        selected={(bundleItemType === 'VENDOR_DOCUMENT'
                                                            ? docs.map((d) => ({ value: d.id, label: d.title || DOC_TYPE_LABELS[d.type] || d.type }))
                                                            : assessments.map((a) => ({ value: a.id, label: a.templateName || a.id }))
                                                        ).find((o) => o.value === bundleItemId) ?? null}
                                                        setSelected={(opt) => setBundleItemId(opt?.value ?? '')}
                                                        placeholder={tx('detail.selectEntity')}
                                                        matchTriggerWidth
                                                    />
                                                )}
                                            </div>
                                            <Button
                                                variant="secondary"
                                                disabled={!bundleItemId}
                                                onClick={() => addBundleItem(b.id)}
                                                id={`add-bundle-item-${b.id}`}
                                            >{tx('detail.add')}</Button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        );
                    })}
                    {bundles.length === 0 && (
                        <InlineEmptyState
                            title={tx('detail.bundlesEmptyTitle')}
                            description={tx('detail.bundlesEmptyDesc')}
                        />
                    )}
                </div>
            )}

            {/* SUBPROCESSORS */}
            {tab === 'subprocessors' && (
                <div className="space-y-default">
                    {canWrite && (
                        <div className={cn(cardVariants({ density: 'compact' }), 'flex items-end gap-compact')}>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{tx('detail.subprocessorLabel')}</label>
                                {/* PR-D — vendor picker replaces the
                                    legacy "Paste vendor ID" input.
                                    Fetches the tenant's vendor list
                                    so users see vendor names, not
                                    cuids. */}
                                <EntityPicker
                                    tenantSlug={params.tenantSlug}
                                    entityType="VENDOR"
                                    value={subForm.subprocessorVendorId}
                                    onChange={(id) =>
                                        setSubForm((p) => ({ ...p, subprocessorVendorId: id }))
                                    }
                                    id="sub-vendor-id"
                                    testId="vendor-subprocessor-picker"
                                    placeholder={tx('detail.selectVendor')}
                                    className="w-48"
                                />
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{tx('detail.purpose')}</label>
                                <input className="input w-48" value={subForm.purpose}
                                    onChange={e => setSubForm(p => ({ ...p, purpose: e.target.value }))} id="sub-purpose" placeholder={tx('detail.purposePlaceholder')} />
                            </div>
                            {/* PR-T — 4th-party data-residency fields. */}
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{tx('detail.subDataTypes')}</label>
                                <input className="input w-48" value={subForm.dataTypes}
                                    onChange={e => setSubForm(p => ({ ...p, dataTypes: e.target.value }))} id="sub-data-types" placeholder={tx('detail.subDataTypesPlaceholder')} />
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{tx('detail.subCountry')}</label>
                                <input className="input w-48" value={subForm.country}
                                    onChange={e => setSubForm(p => ({ ...p, country: e.target.value }))} id="sub-country" placeholder={tx('detail.subCountryPlaceholder')} />
                            </div>
                            <Button variant="primary" disabled={!subForm.subprocessorVendorId} id="add-subprocessor-btn" onClick={async () => {
                                await fetch(apiUrl(`/vendors/${params.vendorId}/subprocessors`), {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(subForm),
                                });
                                setSubForm({ subprocessorVendorId: '', purpose: '', dataTypes: '', country: '' }); fetchSubs();
                            }}>{tx('detail.add')}</Button>
                        </div>
                    )}
                    <VendorSubprocessorsTable
                        subs={subs}
                        canWrite={canWrite}
                        onRemove={removeSubprocessor}
                    />
                    {/* P3.7b — transitive (nth-party) chain view. Rendered
                        below the flat one-hop table; shows the full
                        subprocessor tree the backend resolves. */}
                    {chain && chain.subprocessors.length > 0 && (
                        <div className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')}>
                            <div className="flex items-center gap-tight">
                                <Heading level={3}>{tx('detail.subChainTitle')}</Heading>
                                <InfoTooltip content={tx('detail.subChainHint')} aria-label={tx('detail.subChainHint')} />
                            </div>
                            <div>
                                {chain.subprocessors.map((node) => (
                                    <SubprocessorChainNodeRow key={node.vendorId} node={node} />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
            {tab === 'tasks' && (
                <div className={cardVariants()}>
                    <LinkedTasksPanel
                        apiBase={apiUrl('')}
                        entityType="VENDOR"
                        entityId={params.vendorId}
                        tenantHref={tenantHref}
                        canWrite={!!canWrite}
                    />
                </div>
            )}
                    <ConfirmDialog
                showModal={confirmDismissLink}
                setShowModal={setConfirmDismissLink}
                tone="warning"
                title={tx('detail.dismissLink.title')}
                description={tx('detail.dismissLink.description')}
                confirmLabel={tx('detail.dismissLink.confirm')}
                cancelLabel={tx('detail.dismissLink.cancel')}
                onConfirm={() => {
                    setSendLink(null);
                    setSendLinkExpiresAt(null);
                }}
            />
</EntityDetailLayout>
    );
}

// R11-PR7 — vendor documents sub-table routed through DataTable.
// Inline columns derive from the same fields the prior raw <table>
// rendered; canWrite gates the Remove action column.
interface VendorDocRow {
    id: string;
    type: string;
    title?: string | null;
    /** B8 — optional folder label. Empty/null = "no folder". */
    folder?: string | null;
    validTo?: string | null;
    uploadedBy?: { name?: string | null } | null;
    externalUrl?: string | null;
    notes?: string | null;
}

function VendorDocsTable({
    docs,
    canWrite,
    onRemove,
}: {
    docs: VendorDocRow[];
    canWrite: boolean;
    onRemove: (id: string) => void;
}) {
    const tx = useTranslations('vendors');
    const DOC_TYPE_LABELS = buildDocTypeLabels(tx);
    const columns = useMemo(
        () =>
            createColumns<VendorDocRow>([
                {
                    id: 'type',
                    header: tx('detail.type'),
                    cell: ({ row }) => (
                        <StatusBadge variant="info">
                            {DOC_TYPE_LABELS[row.original.type] || row.original.type}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'title',
                    header: tx('detail.title'),
                    cell: ({ row }) => (
                        <span>{row.original.title || '—'}</span>
                    ),
                },
                {
                    id: 'folder',
                    header: tx('detail.folder'),
                    cell: ({ row }) =>
                        row.original.folder ? (
                            <span className="text-xs text-content-muted">{row.original.folder}</span>
                        ) : (
                            <span className="text-content-subtle">—</span>
                        ),
                },
                {
                    id: 'validTo',
                    header: tx('detail.validTo'),
                    cell: ({ row }) =>
                        row.original.validTo ? formatDate(row.original.validTo) : '—',
                },
                {
                    id: 'uploadedBy',
                    header: tx('detail.uploadedBy'),
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {row.original.uploadedBy?.name || '—'}
                        </span>
                    ),
                },
                {
                    id: 'link',
                    header: tx('detail.linkCol'),
                    cell: ({ row }) => {
                        const href = normaliseHref(row.original.externalUrl);
                        return href ? (
                            <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-content-info underline text-xs"
                            >
                                {tx('detail.openLink')}
                            </a>
                        ) : (
                            <span>—</span>
                        );
                    },
                },
                ...(canWrite
                    ? [
                          {
                              id: 'actions',
                              header: '',
                              cell: ({ row }) => (
                                  <button
                                      className="text-content-error text-xs hover:underline"
                                      onClick={() => onRemove(row.original.id)}
                                  >
                                      {tx('detail.remove')}
                                  </button>
                              ),
                          } as Parameters<typeof createColumns<VendorDocRow>>[0][number],
                      ]
                    : []),
            ]),
        [canWrite, onRemove, tx],
    );
    return (
        <DataTable
            data={docs}
            columns={columns}
            getRowId={(d) => d.id}
            emptyState={tx('detail.docsEmpty')}
            resourceName={(p) => (p ? tx('detail.docResourcePlural') : tx('detail.docResource'))}
            data-testid="vendor-docs-table"
        />
    );
}

// ─── Assessments sub-table (R10-PR3 follow-up) ──────────────────────
// Inline assessment list: Template / Status / Score / Risk / Started
// + open-link action. The "Open →" cell stays a plain Link (no
// per-row write affordance), so this is the cleanest of the four
// migrations — purely a primitive swap, no behaviour change.
// AssessmentRepository.listByVendor — VendorAssessment scalars + template.
interface VendorAssessmentRow {
    id: string;
    status: string;
    score: number | null;
    riskRating: string | null;
    // PR-S — server-resolved template name (prefers the G-3 templateVersion),
    // plus the lifecycle timestamps + respondent the tab/outstanding view need.
    templateName: string | null;
    startedAt: string | null;
    sentAt: string | null;
    submittedAt: string | null;
    reviewedAt: string | null;
    closedAt: string | null;
    respondentEmail: string | null;
    // Invite lifecycle — see the DTO note in vendor-assessment-review.ts.
    inviteExpiresAt: string | null;
    inviteRevokedAt: string | null;
}

/**
 * Is this invite still usable by the respondent?
 *
 * Mirrors the server gate in `verifyAccessToken`: expired OR revoked means
 * the link is dead, whatever the assessment status says. The status alone is
 * not enough — an assessment sits in SENT indefinitely, so a dead invite and
 * a fresh one are the same row without this.
 */
function inviteState(
    row: Pick<VendorAssessmentRow, 'inviteExpiresAt' | 'inviteRevokedAt'>,
    now: Date | null,
): 'live' | 'expired' | 'revoked' {
    // Revocation is a stored fact, so it is safe to read during SSR.
    if (row.inviteRevokedAt) return 'revoked';
    // Expiry is a comparison against the clock, and `new Date()` during
    // render differs between the server pass and hydration — an invite that
    // crosses its expiry between the two renders a different badge on each
    // side and trips React #418. `useHydratedNow` returns null until the
    // client has painted once; until then this reports 'live' so the SSR
    // HTML and the first client render agree exactly.
    if (
        now &&
        row.inviteExpiresAt &&
        new Date(row.inviteExpiresAt).getTime() < now.getTime()
    ) {
        return 'expired';
    }
    return 'live';
}

function VendorAssessmentsTable({ assessments, vendorId, tenantHref }: { assessments: VendorAssessmentRow[]; vendorId: string; tenantHref: (path: string) => string }) {
    const tx = useTranslations('vendors');
    const perms = usePermissions();
    const columns = useMemo(
        () =>
            createColumns<VendorAssessmentRow>([
                {
                    id: 'template',
                    header: tx('detail.template'),
                    cell: ({ row }) => row.original.templateName || '—',
                },
                {
                    id: 'status',
                    header: tx('detail.status'),
                    cell: ({ row }) => (
                        <StatusBadge variant={ASSESSMENT_STATUS_BADGE[row.original.status] ?? 'neutral'}>
                            {tx(vendorAssessmentStatusLabelKey(row.original.status))}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'score',
                    header: tx('detail.score'),
                    cell: ({ row }) =>
                        row.original.score != null ? row.original.score.toFixed(1) : '—',
                },
                {
                    id: 'risk',
                    header: tx('detail.riskRating'),
                    cell: ({ row }) =>
                        row.original.riskRating ? (
                            <StatusBadge variant={CRIT_BADGE[row.original.riskRating]}>
                                {tx('criticalityLabel.' + row.original.riskRating)}
                            </StatusBadge>
                        ) : (
                            '—'
                        ),
                },
                {
                    id: 'started',
                    header: tx('detail.started'),
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {row.original.startedAt ? formatDate(row.original.startedAt) : '—'}
                        </span>
                    ),
                },
                {
                    id: 'action',
                    header: tx('detail.action'),
                    // PR-S — reviewable rows (SUBMITTED/REVIEWED/CLOSED) open the
                    // review surface; in-flight rows (SENT/IN_PROGRESS) are actioned
                    // from the Outstanding section above, so here they show a muted
                    // "Awaiting response" marker rather than routing to a review page
                    // that has nothing to review yet. Legacy World-A rows
                    // (DRAFT/IN_REVIEW/…) have no responder — non-actionable marker.
                    cell: ({ row }) => {
                        const status = row.original.status;
                        if (!isG3AssessmentStatus(status)) {
                            return (
                                <span className="text-content-subtle text-xs">
                                    {tx('detail.legacyAssessment')}
                                </span>
                            );
                        }
                        if (status === 'SENT' || status === 'IN_PROGRESS') {
                            return (
                                <span className="text-content-subtle text-xs">
                                    {tx('detail.awaitingResponse')}
                                </span>
                            );
                        }
                        // The review surface lives under /admin, which the
                        // edge middleware and the admin layout both gate on
                        // admin authority. Send/resend is a canWrite action,
                        // so an EDITOR can put an assessment into SUBMITTED
                        // and then be shown a "Review →" affordance that
                        // dead-ends on a Forbidden page. Don't offer it.
                        if (!perms.admin.view) {
                            return (
                                <span className="text-content-subtle text-xs">
                                    {tx('detail.awaitingReview')}
                                </span>
                            );
                        }
                        return (
                            <Link
                                href={tenantHref(`/admin/vendor-assessment-reviews/${row.original.id}`)}
                                className="text-content-info hover:underline text-xs"
                                id={`open-assessment-${row.original.id}`}
                            >
                                {status === 'SUBMITTED' ? tx('detail.reviewArrow') : tx('detail.openArrow')}
                            </Link>
                        );
                    },
                },
            ]),
        [vendorId, tenantHref, tx, perms],
    );
    return (
        <DataTable
            data={assessments}
            getRowId={(a) => a.id}
            columns={columns}
            selectionEnabled={false}
            emptyState={
                <InlineEmptyState
                    title={tx('detail.assessEmptyTitle')}
                    description={tx('detail.assessEmptyDesc')}
                />
            }
        />
    );
}

// ─── Subprocessor chain (P3.7b) ─────────────────────────────────────
// Recursive disclosure tree for the transitive (nth-party)
// subprocessor graph. Each nesting level indents behind a left rule;
// criticality + inherent-risk badges reuse the CRIT_BADGE variant map
// with localized labels. Cycle-safety + depth bounding are the
// server's job — this render simply walks whatever tree it receives.
function SubprocessorChainNodeRow({ node }: { node: SubprocessorChainNode }) {
    const tx = useTranslations('vendors');
    return (
        <div className="ml-2 border-l border-border-subtle pl-3">
            <div className="flex flex-wrap items-center gap-tight text-sm py-1">
                <span className="font-medium">{node.name}</span>
                <StatusBadge variant={CRIT_BADGE[node.criticality] || 'neutral'}>
                    {tx('criticalityLabel.' + node.criticality)}
                </StatusBadge>
                {node.inherentRisk && (
                    <StatusBadge variant={CRIT_BADGE[node.inherentRisk]}>
                        {tx('criticalityLabel.' + node.inherentRisk)}
                    </StatusBadge>
                )}
                <span className="text-xs text-content-subtle">{tx('detail.chainDepth', { depth: node.depth })}</span>
            </div>
            {node.subprocessors.map((child) => (
                <SubprocessorChainNodeRow key={child.vendorId} node={child} />
            ))}
        </div>
    );
}

// ─── Subprocessors sub-table (R10-PR3 follow-up) ────────────────────
// Tracks the vendor's nested subprocessors with per-row Remove
// (canWrite-gated). Same shape as the R11-PR8 task-links template:
// listSubprocessors — VendorRelationship + nested subprocessor Vendor select.
interface VendorSubprocessorRow {
    id: string;
    subprocessorVendorId: string;
    purpose: string | null;
    country: string | null;
    subprocessor: {
        name: string;
        country: string | null;
        criticality: string;
        inherentRisk: string | null;
    };
}
// Actions column produced via the gated-spread idiom.
function VendorSubprocessorsTable({ subs, canWrite, onRemove }: { subs: VendorSubprocessorRow[]; canWrite: boolean; onRemove: (relationId: string) => void | Promise<void> }) {
    const tx = useTranslations('vendors');
    const columns = useMemo(
        () =>
            createColumns<VendorSubprocessorRow>([
                {
                    id: 'name',
                    header: tx('detail.subprocessorLabel'),
                    cell: ({ row }) => (
                        <span className="font-medium">
                            {row.original.subprocessor?.name || row.original.subprocessorVendorId}
                        </span>
                    ),
                },
                {
                    id: 'country',
                    header: tx('detail.country'),
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {row.original.subprocessor?.country || row.original.country || '—'}
                        </span>
                    ),
                },
                {
                    id: 'crit',
                    header: tx('detail.criticality'),
                    cell: ({ row }) => (
                        <StatusBadge
                            variant={
                                CRIT_BADGE[row.original.subprocessor?.criticality] || 'neutral'
                            }
                        >
                            {row.original.subprocessor?.criticality
                                ? tx('criticalityLabel.' + row.original.subprocessor.criticality)
                                : '—'}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'risk',
                    header: tx('detail.risk'),
                    cell: ({ row }) =>
                        row.original.subprocessor?.inherentRisk ? (
                            <StatusBadge variant={CRIT_BADGE[row.original.subprocessor.inherentRisk]}>
                                {tx('criticalityLabel.' + row.original.subprocessor.inherentRisk)}
                            </StatusBadge>
                        ) : (
                            '—'
                        ),
                },
                {
                    id: 'purpose',
                    header: tx('detail.purpose'),
                    cell: ({ row }) => (
                        <span className="text-content-muted text-xs">
                            {row.original.purpose || '—'}
                        </span>
                    ),
                },
                ...(canWrite
                    ? [
                          {
                              id: 'actions',
                              header: '',
                              cell: ({ row }: { row: { original: VendorSubprocessorRow } }) => (
                                  <button
                                      className="text-content-error text-xs"
                                      onClick={() => onRemove(row.original.id)}
                                  >
                                      {tx('detail.remove')}
                                  </button>
                              ),
                          },
                      ]
                    : []),
            ]),
        [canWrite, onRemove, tx],
    );
    return (
        <DataTable
            data={subs}
            getRowId={(s) => s.id}
            columns={columns}
            selectionEnabled={false}
            emptyState={
                <InlineEmptyState
                    title={tx('detail.subsEmptyTitle')}
                    description={tx('detail.subsEmptyDesc')}
                />
            }
        />
    );
}
