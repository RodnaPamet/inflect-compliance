import { X as LucideX } from "lucide-react";
import type { SVGProps } from "react";

/** `Xmark` — lucide-react `X`, at the set's 18px default size. */
export function Xmark(props: SVGProps<SVGSVGElement>) {
  return <LucideX size={18} {...props} />;
}
