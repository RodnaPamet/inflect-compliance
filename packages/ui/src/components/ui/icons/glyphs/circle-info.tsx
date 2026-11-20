import { Info as LucideInfo } from "lucide-react";
import type { SVGProps } from "react";

/** `CircleInfo` — lucide-react `Info`, at the set's 18px default size. */
export function CircleInfo(props: SVGProps<SVGSVGElement>) {
  return <LucideInfo size={18} {...props} />;
}
