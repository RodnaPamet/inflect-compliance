import { Gauge as LucideGauge } from "lucide-react";
import type { SVGProps } from "react";

/** `Gauge6` — lucide-react `Gauge`, at the set's 18px default size. */
export function Gauge6(props: SVGProps<SVGSVGElement>) {
  return <LucideGauge size={18} {...props} />;
}
