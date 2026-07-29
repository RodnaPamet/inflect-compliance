'use client';

/**
 * Template library (Automation Epic 8).
 *
 * A grid of pre-built rule templates, filterable by tag. "Use template"
 * imports the template as a DRAFT rule (POST /automation/templates) and
 * revalidates the rule list. Mirrors Archer's out-of-the-box workflow packs,
 * dropping time-to-value for common GRC automation.
 */
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useSWRConfig } from 'swr';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/ui/hooks';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';

interface Template {
    id: string;
    name: string;
    description: string;
    trigger: string;
    actionType: string;
    tags: string[];
}

/**
 * Filter-chip vocabulary. The `value` is the immutable tag id used
 * for filtering (`template.tags.includes(value)`); the `label` is
 * the translated display string.
 */
function buildAllTags(t: (key: string) => string): { value: string; label: string }[] {
    return [
        { value: 'risk', label: t('tagRisk') },
        { value: 'control', label: t('tagControl') },
        { value: 'task', label: t('tagTask') },
        { value: 'issue', label: t('tagIssue') },
        { value: 'notify', label: t('tagNotify') },
        { value: 'webhook', label: t('tagWebhook') },
    ];
}

export interface TemplateLibraryModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
}

export function TemplateLibraryModal({ open, setOpen }: TemplateLibraryModalProps) {
    const t = useTranslations('automation.templates');
    const toast = useToast();
    const apiUrl = useTenantApiUrl();
    const { mutate } = useSWRConfig();
    const { data: templates } = useTenantSWR<Template[]>(CACHE_KEYS.automation.templates());
    const [tag, setTag] = useState<string | null>(null);
    const [usingId, setUsingId] = useState<string | null>(null);

    const allTags = useMemo(() => buildAllTags(t), [t]);

    const visible = useMemo(
        () => (templates ?? []).filter((tpl) => !tag || tpl.tags.includes(tag)),
        [templates, tag],
    );

    async function useTemplate(id: string) {
        setUsingId(id);
        try {
            const res = await fetch(apiUrl(CACHE_KEYS.automation.templates()), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ templateId: id }),
            });
            // `if (res.ok)` with no else: a failed import closed nothing, said
            // nothing, and left the spinner to stop on its own — the user was
            // left looking at the library wondering whether the rule was
            // created. It was not.
            if (!res.ok) {
                toast.error(t('importFailed'));
                return;
            }
            await mutate(apiUrl(CACHE_KEYS.automation.rules.list()));
            setOpen(false);
            toast.success(t('importDone'));
        } finally {
            setUsingId(null);
        }
    }

    return (
        <Modal showModal={open} setShowModal={setOpen} title={t('title')} size="xl">
            <Modal.Header title={t('title')} description={t('description')} />
            <Modal.Body>
                <div className="mb-default flex flex-wrap gap-tight">
                    <button
                        type="button"
                        onClick={() => setTag(null)}
                        className={`rounded-full px-2.5 py-0.5 text-xs ${tag === null ? 'bg-bg-inverted text-content-inverted' : 'bg-bg-muted text-content-muted'}`}
                    >
                        {t('all')}
                    </button>
                    {allTags.map((chip) => (
                        <button
                            key={chip.value}
                            type="button"
                            onClick={() => setTag(chip.value)}
                            className={`rounded-full px-2.5 py-0.5 text-xs ${tag === chip.value ? 'bg-bg-inverted text-content-inverted' : 'bg-bg-muted text-content-muted'}`}
                        >
                            {chip.label}
                        </button>
                    ))}
                </div>
                <div className="grid grid-cols-1 gap-default md:grid-cols-2" data-testid="template-grid">
                    {visible.map((tpl) => (
                        <div
                            key={tpl.id}
                            className="surface-popup-texture flex flex-col gap-tight rounded-lg p-3"
                        >
                            <p className="text-sm font-medium text-content-emphasis">{tpl.name}</p>
                            <p className="text-xs text-content-muted">{tpl.description}</p>
                            <div className="flex flex-wrap gap-tight">
                                {tpl.tags.map((tg) => (
                                    <StatusBadge key={tg} variant="neutral">
                                        {tg}
                                    </StatusBadge>
                                ))}
                            </div>
                            <div className="mt-auto pt-tight">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    loading={usingId === tpl.id}
                                    disabled={usingId !== null}
                                    onClick={() => useTemplate(tpl.id)}
                                >
                                    {t('useTemplate')}
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            </Modal.Body>
            <Modal.Actions align="right">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                    {t('close')}
                </Button>
            </Modal.Actions>
        </Modal>
    );
}
