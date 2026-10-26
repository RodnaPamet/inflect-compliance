'use client';

/**
 * Policy-create form hook — owns state, validation, telemetry, and the
 * POST request. The companion `<NewPolicyFields>` component reads from
 * this hook to render the form fields.
 *
 * P1 of the modal-form roadmap (see
 * `docs/implementation-notes/2026-05-24-modal-form-architecture.md`).
 * The legacy `/policies/new` page consumes this hook to keep its full-
 * page behaviour intact; P2 will mount a `<NewPolicyModal>` that
 * consumes the same hook + fields.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';
import type { SuggestionResultDTO } from '../templates/TemplateControlSuggestModal';

export interface PolicyTemplate {
    id: string;
    title: string;
    category?: string | null;
    [key: string]: unknown;
}

export interface NewPolicyFormFields {
    title: string;
    description: string;
    category: string;
    content: string;
    /** Editor mode for the initial version (Prompt-3.3) — same Tiptap editor as edit. */
    contentType: 'MARKDOWN' | 'HTML';
    templateId: string;
}

export interface NewPolicyFormReturn {
    fields: NewPolicyFormFields;
    setField: <K extends keyof NewPolicyFormFields>(
        key: K,
        value: NewPolicyFormFields[K],
    ) => void;
    /** Templates loaded when `isTemplateMode` is true. Empty otherwise. */
    templates: PolicyTemplate[];
    /**
     * Where the template fetch stands. An empty `templates` alone cannot say
     * "none exist" — it is also what loading and a failed load look like.
     */
    templatesStatus: 'loading' | 'ready' | 'error';
    /** Why the template fetch failed (the server's reason when it gave one). */
    templatesError: string | null;
    /** Selects a template — assigns templateId and pre-fills title/category. */
    selectTemplate: (tpl: PolicyTemplate) => void;
    isTemplateMode: boolean;
    submitting: boolean;
    error: string | null;
    canSubmit: boolean;
    submit: () => Promise<void>;
    /**
     * True once the user has interacted with any field (set via
     * `setField` or `selectTemplate`). Cleared on submit-success.
     * Used by the modal wrapper to gate the unsaved-changes warning.
     */
    isDirty: boolean;
}

export interface UseNewPolicyFormOptions {
    /** When true, the form is in template-picker mode. */
    isTemplateMode?: boolean;
    /**
     * Called after a successful POST with the created policy row. For a
     * template create the response also carries `title` and
     * `suggestedControlLinks` (framework-aware control suggestions).
     */
    onSuccess: (policy: {
        id: string;
        title?: string;
        suggestedControlLinks?: SuggestionResultDTO | null;
    }) => void;
}

export function useNewPolicyForm({
    isTemplateMode = false,
    onSuccess,
}: UseNewPolicyFormOptions): NewPolicyFormReturn {
    const apiUrl = useTenantApiUrl();
    const telemetry = useFormTelemetry('NewPolicyPage');
    const t = useTranslations('policies');

    const [fields, setFields] = useState<NewPolicyFormFields>({
        title: '',
        description: '',
        category: '',
        content: '',
        contentType: 'MARKDOWN',
        templateId: '',
    });
    // null until the first answer arrives — that IS the loading state, so the
    // effect below never sets state synchronously.
    const [templatesLoad, setTemplatesLoad] = useState<
        | { status: 'ready'; templates: PolicyTemplate[] }
        | { status: 'error'; message: string | null }
        | null
    >(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDirty, setIsDirty] = useState(false);

    useEffect(() => {
        if (!isTemplateMode) return;
        let cancelled = false;
        // A refused or failed load used to map to `[]`, and the picker then
        // said "No templates available." — a claim about the library, made
        // when nothing was known about it.
        fetch(apiUrl('/policies/templates'))
            .then(async (r) => {
                if (!r.ok) {
                    // The server's reason when it gave one; null → our own.
                    const body = await r.json().catch(() => null);
                    return { status: 'error' as const, message: apiErrorMessage(body, '') || null };
                }
                const data: unknown = await r.json();
                return {
                    status: 'ready' as const,
                    templates: Array.isArray(data) ? (data as PolicyTemplate[]) : [],
                };
            })
            .then((result) => {
                if (!cancelled) setTemplatesLoad(result);
            })
            .catch(() => {
                // Network failure or an unreadable body — the browser's own
                // message is untranslated, so say it in ours.
                if (!cancelled) setTemplatesLoad({ status: 'error', message: null });
            });
        return () => {
            cancelled = true;
        };
    }, [isTemplateMode, apiUrl]);
    const templates = templatesLoad?.status === 'ready' ? templatesLoad.templates : [];
    const templatesStatus = templatesLoad?.status ?? 'loading';
    const templatesError =
        templatesLoad?.status === 'error'
            ? templatesLoad.message ?? t('new.templatesLoadFailed')
            : null;

    const setField = <K extends keyof NewPolicyFormFields>(
        key: K,
        value: NewPolicyFormFields[K],
    ) => {
        setFields((f) => ({ ...f, [key]: value }));
        setIsDirty(true);
    };

    const selectTemplate = (tpl: PolicyTemplate) => {
        setFields((f) => ({
            ...f,
            templateId: tpl.id,
            title: f.title || tpl.title,
            category: tpl.category || '',
        }));
        setIsDirty(true);
    };

    const canSubmit = fields.title.trim().length > 0 && !submitting;

    const submit = async (): Promise<void> => {
        if (!fields.title.trim()) return;
        setSubmitting(true);
        setError(null);
        telemetry.trackSubmit({
            fromTemplate: Boolean(isTemplateMode && fields.templateId),
            hasCategory: Boolean(fields.category),
            contentLength: fields.content?.length ?? 0,
        });

        try {
            const body: { title: string; description: string | null; category: string | null; templateId?: string; content?: string | null; contentType?: 'MARKDOWN' | 'HTML' } = {
                title: fields.title,
                description: fields.description || null,
                category: fields.category || null,
            };
            if (isTemplateMode && fields.templateId) {
                body.templateId = fields.templateId;
            } else {
                body.content = fields.content || null;
                body.contentType = fields.contentType;
            }

            const res = await fetch(apiUrl('/policies'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                // The server's own message — this used to fall back to
                // `JSON.stringify(data.error)`, so the canonical
                // `{ error: { code, message } }` envelope showed as raw JSON.
                throw new Error(apiErrorMessage(data, t('new.createFailed')));
            }

            const policy = await res.json();
            telemetry.trackSuccess({ policyId: policy.id });
            // Clear dirty so the modal's unsaved-changes warning
            // doesn't fire on the post-success close.
            setIsDirty(false);
            onSuccess(policy);
        } catch (err) {
            telemetry.trackError(err);
            setError(err instanceof Error && err.message ? err.message : t('new.createFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    return {
        fields,
        setField,
        templates,
        templatesStatus,
        templatesError,
        selectTemplate,
        isTemplateMode,
        submitting,
        error,
        canSubmit,
        submit,
        isDirty,
    };
}
