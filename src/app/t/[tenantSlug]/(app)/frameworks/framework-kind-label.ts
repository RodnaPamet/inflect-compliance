import type { FrameworkKind } from '@prisma/client';

/**
 * A framework's kind as a label, never the stored enum value with its
 * underscore turned into a space ("ISO STANDARD") — #4459 on the list,
 * #4694 on the detail page. `t = useTranslations('frameworks')`.
 */
const KIND_KEYS: Record<FrameworkKind, string> = {
    ISO_STANDARD: 'kinds.isoStandard',
    NIST_FRAMEWORK: 'kinds.nistFramework',
    SOC_CRITERIA: 'kinds.socCriteria',
    EU_DIRECTIVE: 'kinds.euDirective',
    REGULATION: 'kinds.regulation',
    INDUSTRY_STANDARD: 'kinds.industryStandard',
    CUSTOM: 'kinds.custom',
};

export function frameworkKindLabel(t: (key: string) => string, kind?: string | null): string | undefined {
    return kind && Object.prototype.hasOwnProperty.call(KIND_KEYS, kind)
        ? t(KIND_KEYS[kind as FrameworkKind])
        : undefined;
}
