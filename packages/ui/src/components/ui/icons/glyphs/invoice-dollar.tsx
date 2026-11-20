import { Receipt as LucideReceipt } from "lucide-react";
import type { SVGProps } from "react";

/** `InvoiceDollar` — lucide-react `Receipt`, at the set's 18px default size. */
export function InvoiceDollar(props: SVGProps<SVGSVGElement>) {
  return <LucideReceipt size={18} {...props} />;
}
