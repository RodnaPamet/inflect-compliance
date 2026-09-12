/** BISECT PROBE B — not for merge. Export route stubbed so neither
 *  `agent-governance-pack-export.ts` nor `pack-document.ts` is reachable from
 *  any build entry point. */
import { NextRequest } from 'next/server';

import { jsonResponse } from '@/lib/api-response';

export async function POST(_req: NextRequest) {
    return jsonResponse({ stubbed: true }, { status: 501 });
}
