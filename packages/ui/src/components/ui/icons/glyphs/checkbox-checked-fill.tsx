import { SquareCheck as LucideSquareCheck } from "lucide-react";
import type { SVGProps } from "react";

/** `CheckboxCheckedFill` — lucide-react `SquareCheck`, at the set's 18px default size. */
export function CheckboxCheckedFill(props: SVGProps<SVGSVGElement>) {
  return <LucideSquareCheck size={18} {...props} />;
}
