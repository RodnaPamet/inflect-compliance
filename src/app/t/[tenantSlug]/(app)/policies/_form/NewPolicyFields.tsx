'use client';

/**
 * Controlled field markup for the policy-create form. Reads its state
 * from a `useNewPolicyForm()` instance — does not own any state itself.
 *
 * See `docs/implementation-notes/2026-05-24-modal-form-architecture.md`
 * for the design context. Both the legacy `/policies/new` page wrapper
 * and the future `<NewPolicyModal>` (P2) render this component
 * unchanged; the wrapper supplies its own submit button + chrome.
 */
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';
import type { RichTextContentType } from '@/components/ui/RichTextEditor';
import type { NewPolicyFormReturn } from './useNewPolicyForm';

// Prompt-3.3 — the SAME Tiptap editor used for later versions (lazy, no SSR).
const RichTextEditor = dynamic(
    () => import('@/components/ui/RichTextEditor').then((m) => m.RichTextEditor),
    { ssr: false },
);

const POLICY_CATEGORIES: ComboboxOption[] = [
    'Information Security',
    'Access Control',
    'HR',
    'Physical',
    'Compliance',
    'Operations',
    'Risk Management',
    'Business Continuity',
    'Supplier',
    'Other',
].map((c) => ({ value: c, label: c }));

export function NewPolicyFields({ form }: { form: NewPolicyFormReturn }) {
    const t = useTranslations('policies');
    return (
        <>
            {/* Template picker — only in template mode. */}
            {form.isTemplateMode && (
                <div
                    className={cn(
                        cardVariants({ density: 'compact' }),
                        'space-y-compact',
                    )}
                >
                    <Heading level={3}>{t('new.chooseTemplate')}</Heading>
                    {form.templates.length === 0 ? (
                        <p className="text-sm text-content-subtle">
                            {t('new.templatesEmpty')}
                        </p>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-tight max-h-60 overflow-y-auto">
                            {form.templates.map((tpl) => (
                                <button
                                    key={tpl.id}
                                    type="button"
                                    onClick={() => form.selectTemplate(tpl)}
                                    className={`text-left p-3 rounded-lg border transition text-sm ${
                                        form.fields.templateId === tpl.id
                                            ? 'border-[var(--brand-default)] bg-[var(--brand-subtle)] text-content-emphasis'
                                            : 'border-border-default bg-bg-default/50 text-content-default hover:bg-bg-muted/50'
                                    }`}
                                >
                                    <p className="font-medium">{tpl.title}</p>
                                    {tpl.category && (
                                        <p className="text-xs text-content-subtle mt-0.5">
                                            {tpl.category}
                                        </p>
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                    {/* ciso-toolkit attribution (licensing obligation) — the
                      * template library credit moved here from the retired
                      * /policies/templates page. Rendered once below the grid
                      * (the template tiles are buttons, so a link can't nest
                      * inside them). */}
                    {form.templates.some((tpl) => tpl.source === 'ciso-toolkit') && (
                        <p className="text-[10px] text-content-subtle italic" data-testid="template-source-credit">
                            {t.rich('templates.adaptedFrom', {
                                link: (c) => (
                                    <a
                                        href="https://github.com/D4d0/ciso-toolkit"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="underline hover:text-content-muted"
                                    >
                                        {c}
                                    </a>
                                ),
                            })}
                        </p>
                    )}
                </div>
            )}

            {/* Form fields */}
            <FormField
                label={t('new.fieldTitle')}
                required
                error={
                    form.fields.title.length > 0 && !form.fields.title.trim()
                        ? t('new.titleEmpty')
                        : undefined
                }
            >
                <Input
                    id="policy-title-input"
                    required
                    value={form.fields.title}
                    onChange={(e) => form.setField('title', e.target.value)}
                    placeholder={t('new.titlePlaceholder')}
                />
            </FormField>
            <FormField label={t('new.fieldDescription')}>
                <Input
                    value={form.fields.description}
                    onChange={(e) => form.setField('description', e.target.value)}
                    placeholder={t('new.descriptionPlaceholder')}
                />
            </FormField>
            <FormField label={t('new.fieldCategory')}>
                <Combobox
                    id="policy-category-select"
                    name="category"
                    options={POLICY_CATEGORIES}
                    selected={
                        POLICY_CATEGORIES.find(
                            (o) => o.value === form.fields.category,
                        ) ?? null
                    }
                    setSelected={(o) => form.setField('category', o?.value ?? '')}
                    placeholder={t('new.categoryPlaceholder')}
                    searchPlaceholder={t('new.categorySearch')}
                    matchTriggerWidth
                    buttonProps={{ className: 'w-full' }}
                    caret
                />
            </FormField>

            {/* Initial content for blank mode only — the same rich editor as
                later versions (Tiptap), so first-version authoring is consistent. */}
            {!form.isTemplateMode && (
                <FormField label={t('new.fieldContent')}>
                    <RichTextEditor
                        value={form.fields.content}
                        contentType={form.fields.contentType}
                        onChange={(value: string, contentType: RichTextContentType) => {
                            form.setField('content', value);
                            if (contentType === 'MARKDOWN' || contentType === 'HTML') {
                                form.setField('contentType', contentType);
                            }
                        }}
                        placeholder={t('new.contentPlaceholder')}
                    />
                </FormField>
            )}
        </>
    );
}
