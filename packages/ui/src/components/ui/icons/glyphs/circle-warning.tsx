import { CircleExclamationPoint as LucideCircleExclamationPoint } from "lucide-react";
import type { SVGProps } from "react";

/** `CircleWarning` — lucide-react `CircleExclamationPoint`, at the set's 18px default size. */
export function CircleWarning(props: SVGProps<SVGSVGElement>) {
  return <LucideCircleExclamationPoint size={18} {...props} />;
}
