import { selectDateRangePresets } from '@/components/ui/date-picker/presets-catalogue';

// Epic 58 — audit periods are reporting windows. The curated preset
// subset favours periods auditors actually request ("the most recent
// completed quarter", "this fiscal year so far") over day-level
// presets like "Today" that don't map to an audit scope. Shared by the
// create dialog on the cycles list and the edit dialog on a cycle (#4727).
export const AUDIT_PERIOD_PRESETS = selectDateRangePresets([
    'quarter-to-date',
    'year-to-date',
    'last-quarter',
    'last-year',
    'last-90-days',
    'last-30-days',
]);
