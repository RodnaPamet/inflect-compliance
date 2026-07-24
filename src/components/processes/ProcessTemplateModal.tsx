'use client';

/**
 * Process-map starter-template picker (DOCUMENT canvas).
 *
 * Lists the built-in starter maps from `process-map-templates.ts` and clones
 * the chosen one into a fresh DOCUMENT map. This is DISTINCT from the
 * automation `TemplateLibraryModal` (which imports pre-built automation
 * RULES): this seeds a whole process map's nodes + edges. The cloning
 * round-trip (create map → save graph) is owned by the caller via `onUse`,
 * mirroring the canvas Duplicate flow.
 */
import { useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { PROCESS_MAP_TEMPLATES } from './process-map-templates';

export interface ProcessTemplateModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /** Clone the chosen starter into a new map. Resolves when done. */
    onUse: (templateId: string) => Promise<void>;
}

export function ProcessTemplateModal({ open, setOpen, onUse }: ProcessTemplateModalProps) {
    const t = useTranslations('processes.templates');
    const [usingId, setUsingId] = useState<string | null>(null);

    async function use(id: string) {
        setUsingId(id);
        try {
            await onUse(id);
            setOpen(false);
        } finally {
            setUsingId(null);
        }
    }

    return (
        <Modal showModal={open} setShowModal={setOpen} title={t('title')} size="xl">
            <Modal.Header title={t('title')} description={t('description')} />
            <Modal.Body>
                <div
                    className="grid grid-cols-1 gap-default md:grid-cols-2"
                    data-testid="process-template-grid"
                >
                    {PROCESS_MAP_TEMPLATES.map((tpl) => (
                        <div
                            key={tpl.id}
                            className="surface-popup-texture flex flex-col gap-tight rounded-lg p-3"
                            data-template-id={tpl.id}
                        >
                            <p className="text-sm font-medium text-content-emphasis">
                                {t(`items.${tpl.nameKey}`)}
                            </p>
                            <p className="text-xs text-content-muted">
                                {t(`items.${tpl.summaryKey}`)}
                            </p>
                            <p className="text-[11px] text-content-subtle tabular-nums">
                                {t('shape', {
                                    steps: tpl.nodes.length,
                                    links: tpl.edges.length,
                                })}
                            </p>
                            <div className="mt-auto pt-tight">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    loading={usingId === tpl.id}
                                    disabled={usingId !== null}
                                    onClick={() => use(tpl.id)}
                                >
                                    {t('use')}
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
