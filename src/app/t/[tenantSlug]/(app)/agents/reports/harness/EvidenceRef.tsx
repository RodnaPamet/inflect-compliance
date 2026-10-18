'use client';

/**
 * One verdict's evidence pointer, rendered as what it is.
 *
 * The pointer is a scanner string of up to 512 characters. It becomes a LINK
 * only when `evidenceHrefOf` accepts it — an absolute http(s) URL, parsed with
 * no base — and then it opens in a new tab with the canonical noopener attrs.
 * Anything else (`kv://…`, `inflect-register:…`, a path, a query) is copyable
 * TEXT: a scanner-chosen relative path must not render as a link into this
 * product, and `javascript:` must not render as a link at all.
 *
 * A pointer that embedded credentials in a URL (`https://user:pass@host/…`)
 * is never a link and never printed as received: its userinfo is replaced by
 * `***` (`redactPointerCredentials`) in the text AND in the copied value, and a
 * note says so. Rows stored before the ingest refused that shape still exist,
 * so this is not left to the ingest alone.
 *
 * A cell with no pointer says so. Silence would read as "the evidence is
 * somewhere".
 */
import { useTranslations } from 'next-intl';

import { CopyText } from '@/components/ui/copy-text';
import { Tooltip } from '@/components/ui/tooltip';
import { evidenceHrefOf, redactPointerCredentials } from '@/lib/agentic/harness-read-model';
import { EXTERNAL_LINK_ATTRS } from '@/lib/security/safe-url';

export function EvidenceRef({ pointer }: { pointer: string | null }) {
    const t = useTranslations('agents');
    const trimmed = pointer?.trim() ?? '';

    if (trimmed === '') {
        return (
            <span className="text-xs text-content-muted" data-testid="harness-evidence-none">
                {t('harness.cellNoEvidence')}
            </span>
        );
    }

    // Before the link check, and on the whole string: a pointer that parses as
    // a clean URL can still carry another URL's credentials further along.
    const redaction = redactPointerCredentials(trimmed);
    if (redaction.redacted) {
        return (
            <span className="inline-flex flex-col gap-tight" data-testid="harness-evidence-text">
                <CopyText value={redaction.text} label={t('harness.evidenceCopy')} truncate>
                    {redaction.text}
                </CopyText>
                <span className="text-xs text-content-muted" data-testid="harness-evidence-redacted">
                    {t('harness.evidenceRedacted')}
                </span>
            </span>
        );
    }

    const href = evidenceHrefOf(trimmed);
    if (href !== null) {
        return (
            <Tooltip content={trimmed}>
                <a
                    href={href}
                    {...EXTERNAL_LINK_ATTRS}
                    className="inline-block max-w-trunc-default truncate text-xs underline"
                    data-testid="harness-evidence-link"
                >
                    {trimmed}
                </a>
            </Tooltip>
        );
    }

    return (
        <span data-testid="harness-evidence-text">
            <CopyText value={trimmed} label={t('harness.evidenceCopy')} truncate>
                {trimmed}
            </CopyText>
        </span>
    );
}
