import { Gift as LucideGift } from "lucide-react";
import type { SVGProps } from "react";

/** `Gift` — lucide-react `Gift`, at the set's 18px default size. */
export function Gift(props: SVGProps<SVGSVGElement>) {
  return <LucideGift size={18} {...props} />;
}
