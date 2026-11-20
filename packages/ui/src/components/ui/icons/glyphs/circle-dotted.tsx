import { CircleDashed as LucideCircleDashed } from "lucide-react";
import type { SVGProps } from "react";

/** `CircleDotted` — lucide-react `CircleDashed`, at the set's 18px default size. */
export function CircleDotted(props: SVGProps<SVGSVGElement>) {
  return <LucideCircleDashed size={18} {...props} />;
}
