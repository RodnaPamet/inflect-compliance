import { CircleCheck as LucideCircleCheck } from "lucide-react";
import type { SVGProps } from "react";

/** `CircleCheckFill` — lucide-react `CircleCheck`, at the set's 18px default size. */
export function CircleCheckFill(props: SVGProps<SVGSVGElement>) {
  return <LucideCircleCheck size={18} {...props} />;
}
