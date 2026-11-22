import { Eye as LucideEye } from "lucide-react";
import type { SVGProps } from "react";

/** `Eye` — lucide-react `Eye`, at the set's 18px default size. */
export function Eye(props: SVGProps<SVGSVGElement>) {
  return <LucideEye size={18} {...props} />;
}
