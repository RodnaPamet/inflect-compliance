'use client';

/**
 * The shared `<DatePicker>`, loaded when a form that holds one first renders.
 *
 * The date picker brings `react-day-picker` and `date-fns`, about 29 KB of
 * First Load JS. Imported statically by the initiatives pages, whose only
 * date field sits in a dialog that is closed when the page loads, it took
 * both pages past the `root` bundle budget (#4851). Loaded here, the dialog
 * still opens at once with every other field ready; the date field shows a
 * placeholder of the same size until the picker arrives.
 */
import dynamic from 'next/dynamic';
import { SkeletonInput } from '@/components/ui/skeleton';

export const LazyDatePicker = dynamic(
    () => import('@/components/ui/date-picker/date-picker').then((m) => m.DatePicker),
    { ssr: false, loading: () => <SkeletonInput className="w-full" /> },
);
