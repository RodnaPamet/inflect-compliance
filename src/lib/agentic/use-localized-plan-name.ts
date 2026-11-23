'use client';
/**
 * Test-plan and audit-procedure names in the reader's language — the stock
 * names the agent assurance setup and the audit pilot write are translated,
 * every other name is shown as written. See `localizedPlanName` and
 * `localizedProcedureName`.
 */
import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import { localizedPlanName, localizedProcedureName } from './agentic-check-titles';

export function useLocalizedPlanName(): (name: string) => string {
    const tChecks = useTranslations('agentChecks');
    const tProcedures = useTranslations('audits.workpaperReviews.procedureName');
    return useCallback((name: string) => localizedPlanName(name, tChecks, tProcedures), [tChecks, tProcedures]);
}

/** An audit procedure's name in the reader's language, else its stored title. */
export function useLocalizedProcedureName(): (procedureId: string, storedTitle: string) => string {
    const tNames = useTranslations('audits.workpaperReviews.procedureName');
    return useCallback(
        (procedureId: string, storedTitle: string) => localizedProcedureName(procedureId, storedTitle, tNames),
        [tNames],
    );
}
