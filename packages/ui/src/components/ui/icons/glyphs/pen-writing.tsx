import { PenLine as LucidePenLine } from "lucide-react";
import type { SVGProps } from "react";

/** `PenWriting` — lucide-react `PenLine`, at the set's 18px default size. */
export function PenWriting(props: SVGProps<SVGSVGElement>) {
  return <LucidePenLine size={18} {...props} />;
}
