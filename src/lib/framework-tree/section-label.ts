/**
 * Display label for a framework-tree section.
 *
 * A section is named by what its requirements are grouped on (`build.ts`):
 * an explicit section, an ISO 27001 THEME, a category or a code prefix. The
 * ISO themes are stored as the catalog's constants (`ORGANIZATIONAL`, …) and
 * were rendered as they are stored, so the framework page read
 * "ORGANIZATIONAL / PEOPLE / PHYSICAL / TECHNOLOGICAL" in every language
 * (#5828). A theme constant reads `frameworkThemes.<THEME>` from the catalog;
 * every other label is the framework's own text and passes through as stored.
 * Only the LABEL changes — the section's key, order and search stay on the
 * stored value.
 */
import { isControlCategoryTheme } from '@/lib/controls/control-categories';

/** A root-level translator (`useTranslations()` with no namespace). */
type T = (key: string) => string;

export function frameworkSectionLabel(label: string, t: T): string {
    return isControlCategoryTheme(label) ? t(`frameworkThemes.${label}`) : label;
}
