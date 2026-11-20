import { DollarSign as LucideDollarSign } from "lucide-react";
import type { SVGProps } from "react";

/** `CurrencyDollar` — lucide-react `DollarSign`, at the set's 18px default size. */
export function CurrencyDollar(props: SVGProps<SVGSVGElement>) {
  return <LucideDollarSign size={18} {...props} />;
}
