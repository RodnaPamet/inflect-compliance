/**
 * Epic 64 — `<ProgressiveBlur>`.
 *
 * Edge fade/blur affordance for scrollable surfaces (sheets, modal
 * bodies, chart legends, dense tables). Stacks N `backdrop-filter`
 * layers under linear-gradient masks so the blur strength tapers off
 * smoothly toward the centre.
 *
 *   <div className="relative overflow-y-auto h-64">
 *     <Content />
 *     <ProgressiveBlur side="top" />
 *     <ProgressiveBlur side="bottom" />
 *   </div>
 *
 *   // Convenience: top + bottom in one call
 *   <ProgressiveBlur side="both" />
 *
 * Implementation: the well-known layered-backdrop-blur technique — a
 * stack of `backdrop-filter` planes, each revealed by a linear-gradient
 * mask band, with geometrically-decreasing blur strength so the
 * strongest blur sits at the edge and fades inward. (Same technique as
 * the MIT `AndrewPrifer/progressive-blur`.) First-party implementation.
 *
 * Token integration: the blur is a `backdrop-filter` with no fill, so
 * the component is theme-neutral by construction — it softens whatever
 * sits behind the scroll container.
 *
 * Composition rule: place inside a `position: relative` container that
 * has `overflow: auto/scroll/hidden`. The component pins to the
 * container's edge via `absolute`; pointer-events are disabled so
 * clicks pass through to the underlying scroller.
 */
import { cn } from '@inflect/ui/lib/cn';
import * as React from 'react';

type SingleSide = 'top' | 'right' | 'bottom' | 'left';
export type ProgressiveBlurSide = SingleSide | 'both';

const oppositeSide: Record<SingleSide, SingleSide> = {
    top: 'bottom',
    bottom: 'top',
    left: 'right',
    right: 'left',
};

export interface ProgressiveBlurProps
    extends React.HTMLAttributes<HTMLDivElement> {
    /** Which edge of the container should carry the strongest blur. Defaults to `top`. */
    side?: ProgressiveBlurSide;
    /** Strongest blur strength in px. Defaults to 32. */
    strength?: number;
    /** Number of blur layers — more layers = smoother taper, more cost. Defaults to 4. */
    steps?: number;
    /** Pixel height (or width, for left/right) of the blurred band. Defaults to `5rem`. */
    size?: string;
}

/**
 * Convenience wrapper — `side="both"` mounts a top + bottom pair so a
 * vertically-scrolling container can be wrapped with one tag.
 */
export function ProgressiveBlur({
    side = 'top',
    strength = 32,
    steps = 4,
    size,
    className,
    style,
    ...rest
}: ProgressiveBlurProps) {
    if (side === 'both') {
        return (
            <>
                <ProgressiveBlur
                    side="top"
                    strength={strength}
                    steps={steps}
                    size={size}
                    className={className}
                    style={style}
                    {...rest}
                />
                <ProgressiveBlur
                    side="bottom"
                    strength={strength}
                    steps={steps}
                    size={size}
                    className={className}
                    style={style}
                    {...rest}
                />
            </>
        );
    }

    return (
        <SingleProgressiveBlur
            side={side}
            strength={strength}
            steps={steps}
            size={size}
            className={className}
            style={style}
            {...rest}
        />
    );
}

interface SingleProgressiveBlurProps
    extends React.HTMLAttributes<HTMLDivElement> {
    side: SingleSide;
    strength: number;
    steps: number;
    size?: string;
}

const MIN_BLUR_PX = 0.5;

/**
 * Per-layer blur in px, indexed from the edge inward (0 = strongest).
 * Geometric ramp from `strength` down to `MIN_BLUR_PX` across `steps`
 * layers. With the defaults (strength 32, 4 steps) this yields
 * 32 / 8 / 2 / 0.5 — each layer a quarter of the previous.
 */
function blurRamp(strength: number, steps: number): number[] {
    if (steps <= 1) return [strength];
    const ratio = (MIN_BLUR_PX / strength) ** (1 / (steps - 1));
    return Array.from({ length: steps }, (_, i) => strength * ratio ** i);
}

/**
 * Mask band for layer `i` (edge-relative). Layer 0 is opaque at the
 * very edge and fades by one step; each subsequent layer's opaque band
 * slides one step further inward, so weaker blurs cover the region
 * deeper from the edge. Direction `opp` points away from the blurred
 * edge.
 */
function maskFor(i: number, step: number, opp: SingleSide): string {
    const black = 'rgba(0, 0, 0, 1)';
    const clear = 'rgba(0, 0, 0, 0)';
    const pct = (n: number) => `${n * step}%`;
    let stops: string;
    if (i === 0) {
        stops = `${black} 0%, ${clear} ${pct(1)}`;
    } else if (i === 1) {
        stops = `${black} 0%, ${black} ${pct(1)}, ${clear} ${pct(2)}`;
    } else {
        stops =
            `${clear} ${pct(i - 2)}, ${black} ${pct(i - 1)}, ` +
            `${black} ${pct(i)}, ${clear} ${pct(i + 1)}`;
    }
    return `linear-gradient(to ${opp}, ${stops})`;
}

function SingleProgressiveBlur({
    side,
    strength,
    steps,
    size,
    className,
    style,
    ...rest
}: SingleProgressiveBlurProps) {
    const step = 100 / steps;
    const opp = oppositeSide[side];
    const blurs = blurRamp(strength, steps);

    // Horizontal sides (left/right) constrain WIDTH; vertical sides
    // (top/bottom) constrain HEIGHT. The perpendicular axis spans the
    // full container edge.
    const isHorizontal = side === 'left' || side === 'right';
    const sizeStyle: React.CSSProperties = isHorizontal
        ? { width: size ?? '5rem' }
        : { height: size ?? '5rem' };
    const positionClass = {
        top: 'top-0 left-0 right-0',
        bottom: 'bottom-0 left-0 right-0',
        left: 'top-0 bottom-0 left-0',
        right: 'top-0 bottom-0 right-0',
    }[side];

    return (
        <div
            data-progressive-blur={side}
            className={cn('pointer-events-none absolute', positionClass, className)}
            style={{ ...sizeStyle, ...style }}
            {...rest}
        >
            <div className="relative size-full">
                {blurs.map((px, i) => {
                    const mask = maskFor(i, step, opp);
                    const filter = `blur(${px}px)`;
                    return (
                        <div
                            key={i}
                            className="absolute inset-0"
                            style={{
                                zIndex: i + 1,
                                WebkitMask: mask,
                                mask,
                                backdropFilter: filter,
                                WebkitBackdropFilter: filter,
                            }}
                        />
                    );
                })}
            </div>
        </div>
    );
}

export default ProgressiveBlur;
