import { Lock as LucideLock } from "lucide-react";
import type { SVGProps } from "react";

/** `Lock` — lucide-react `Lock`, at the set's 18px default size. */
export function Lock(props: SVGProps<SVGSVGElement>) {
  return <LucideLock size={18} {...props} />;
}
