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

    const [fields, setFields] = useState<NewPolicyFormFields>({
        title: '',
        description: '',
        category: '',
        content: '',
        contentType: 'MARKDOWN',
        templateId: '',
    });
    const [templates, setTemplates] = useState<PolicyTemplate[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDirty, setIsDirty] = useState(false);

    useEffect(() => {
        if (!isTemplateMode) return;
        let cancelled = false;
        fetch(apiUrl('/policies/templates'))
            .then((r) => (r.ok ? r.json() : []))
            .then((data) => {
                if (!cancelled) setTemplates(data);
            })
            .catch(() => {
                /* swallow — empty list is the right fallback */
            });
        return () => {
            cancelled = true;
        };
    }, [isTemplateMode, apiUrl]);

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
                throw new Error(apiErrorMessage(data, 'Failed to create policy'));
            }

            const policy = await res.json();
            telemetry.trackSuccess({ policyId: policy.id });
            // Clear dirty so the modal's unsaved-changes warning
            // doesn't fire on the post-success close.
            setIsDirty(false);
            onSuccess(policy);
        } catch (err) {
            telemetry.trackError(err);
            setError(err instanceof Error ? err.message : 'Failed to create policy');
        } finally {
            setSubmitting(false);
        }
    };

    return {
        fields,
        setField,
        templates,
        selectTemplate,
        isTemplateMode,
        submitting,
        error,
        canSubmit,
        submit,
        isDirty,
    };
}
