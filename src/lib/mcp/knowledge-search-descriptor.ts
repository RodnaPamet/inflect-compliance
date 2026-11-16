/**
 * `search_knowledge`'s name and permission keys, in a LEAF module.
 *
 * The tool (`tools/knowledge-tools.ts`) and its mount gate's list
 * (`mount-gated-tools.ts`) both read them from here. The gate list is asked by
 * the engines' offer on every run, so it must not import the tool, whose
 * usecase pulls in the database layer; and a second spelling of the keys would
 * let the gate and the tool disagree about who would have been offered it.
 */
import type { PermissionKey } from '@/lib/security/permission-key';

export const SEARCH_KNOWLEDGE_TOOL = 'search_knowledge';

/** What the funnel asks of the acting context: today's only source is policy text. */
export const SEARCH_KNOWLEDGE_KEYS: readonly PermissionKey[] = ['policies.view'];
