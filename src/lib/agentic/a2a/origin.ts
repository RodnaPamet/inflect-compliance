/**
 * The origin Inflect's A2A identity is built on (#3742): `APP_URL`, which must
 * be a bare https origin. `null` otherwise, and every A2A path then refuses
 * with `NO_PUBLIC_ORIGIN`: the identity is signed into every receipt, so it is
 * never derived from a request, which a proxy or a caller could distort.
 */
import { env } from '@/env';

import { a2aOriginFrom } from './own-card';

export function inflectA2aOrigin(): string | null {
    return a2aOriginFrom(env.APP_URL);
}
