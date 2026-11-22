import { ClockFading as LucideClockFading } from "lucide-react";
import type { SVGProps } from "react";

/** `CircleHalfDottedClock` — lucide-react `ClockFading`, at the set's 18px default size. */
export function CircleHalfDottedClock(props: SVGProps<SVGSVGElement>) {
  return <LucideClockFading size={18} {...props} />;
}
