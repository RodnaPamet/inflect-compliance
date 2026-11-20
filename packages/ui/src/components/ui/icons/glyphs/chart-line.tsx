import { ChartLine as LucideChartLine } from "lucide-react";
import type { SVGProps } from "react";

/** `ChartLine` — lucide-react `ChartLine`, at the set's 18px default size. */
export function ChartLine(props: SVGProps<SVGSVGElement>) {
  return <LucideChartLine size={18} {...props} />;
}
