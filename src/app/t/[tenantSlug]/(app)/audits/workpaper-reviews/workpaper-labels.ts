'use client';
/**
 * Words for the codes a workpaper carries (#4930): its procedure, conclusion
 * and basis, each unit's outcome and code, and its parameters. The reviewer
 * re-performs a workpaper from these, so it reads them as words, not codes.
 *
 * Every lookup falls back to the stored value: a code added to the library
 * before its label shows as itself rather than disappearing.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

/** A procedure id is dotted (`iam.leaver_timeliness`); a message key cannot be. */
const procedureKey = (id: string) => id.replace(/\./g, '_');

export interface WorkpaperLabels {
    procedure(id: string): string;
    conclusion(conclusion: string, basis: string): string;
    outcome(outcome: string): string;
    code(code: string): string;
    parameters(params: Record<string, unknown> | null): string;
}

export function useWorkpaperLabels(): WorkpaperLabels {
    const t = useTranslations('audits');
    return useMemo(() => {
        const W = 'workpaperReviews';
        const known = (key: string) => (t.has ? t.has(key) : false);
        const word = (key: string, fallback: string) =>
            known(key) ? t(key as Parameters<typeof t>[0]) : fallback;
        return {
            procedure: (id) => word(`${W}.procedureName.${procedureKey(id)}`, id),
            conclusion: (conclusion, basis) =>
                t(`${W}.conclusionValue`, {
                    conclusion: word(`${W}.conclusionLabel.${conclusion}`, conclusion),
                    basis: word(`${W}.basisLabel.${basis}`, basis),
                }),
            outcome: (outcome) => word(`${W}.outcomeLabel.${outcome}`, outcome),
            code: (code) => word(`${W}.unitCode.${code}`, code),
            parameters: (params) =>
                params && Object.keys(params).length > 0
                    ? Object.entries(params)
                          .map(([k, v]) =>
                              t(`${W}.parameterValue`, {
                                  name: word(`${W}.parameterName.${k}`, k),
                                  value: String(v),
                              }),
                          )
                          .join(', ')
                    : '—',
        };
    }, [t]);
}
