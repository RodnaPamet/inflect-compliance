'use client';

/**
 * Roadmap-21 PR-E — SSR-safe dynamic-import helper for `<Chart3D>`.
 *
 * Three.js + react-three-fiber + drei together weigh ~180KB
 * gzipped and touch the DOM (canvas + WebGL) at module load.
 * Importing them on a server render breaks. This helper wraps
 * `<Chart3D>` in `next/dynamic({ ssr: false })` so the bundle cost
 * only lands on routes that ACTUALLY mount a 3D chart — and the
 * server renders a clean placeholder until the client hydrates.
 *
 * Usage:
 *
 *   // Page or chart consumer:
 *   import { dynamicChart3D } from '@inflect/ui/components/ui/charts/chart-3d-dynamic';
 *   const Chart3D = dynamicChart3D();
 *
 *   <Chart3D ariaLabel="..." FallbackComponent={Static2D}>
 *     <mesh>...</mesh>
 *   </Chart3D>
 *
 * The factory call (`dynamicChart3D()`) returns a unique component
 * instance per call site, so the dynamic-import cache works per
 * page — exactly one 3D chunk is shared across all consumers on a
 * single page; routes without any consumer never load the chunk.
 */

import dynamic from 'next/dynamic';
import type { ComponentType, ReactNode } from 'react';

import type { Chart3DProps } from './chart-3d';

/**
 * Returns a dynamically-imported `<Chart3D>` component instance.
 * The optional `loading` render-prop renders on the server + during
 * the import. Defaults to a clean null placeholder.
 */
export function dynamicChart3D(
    options?: { loading?: () => ReactNode },
): ComponentType<Chart3DProps> {
    return dynamic(
        () => import('./chart-3d').then((m) => m.Chart3D),
        {
            ssr: false,
            loading: options?.loading,
        },
    ) as ComponentType<Chart3DProps>;
}
