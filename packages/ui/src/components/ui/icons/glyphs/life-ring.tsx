import { LifeBuoy as LucideLifeBuoy } from "lucide-react";
import type { SVGProps } from "react";

/** `LifeRing` — lucide-react `LifeBuoy`, at the set's 18px default size. */
export function LifeRing(props: SVGProps<SVGSVGElement>) {
  return <LucideLifeBuoy size={18} {...props} />;
}
