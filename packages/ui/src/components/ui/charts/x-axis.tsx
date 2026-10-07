import { AxisBottom } from "@visx/axis";
import { Group } from "@visx/group";
import { Line } from "@visx/shape";
import { useMemo } from "react";

import { useChartContext, useChartTooltipContext } from "./chart-context";
import {
    AXIS_LABEL_FONT_SIZE,
    formatShortDate,
    pickXAxisTickCount,
    pickXAxisTickValues,
} from "./layout";

export type XAxisProps = {
    /** Maximum number of ticks to generate. Falls back to a width-aware default. */
    maxTicks?: number;

    /** Whether to render dashed grid lines across the chart area. */
    showGridLines?: boolean;

    /** Whether to render a line for the axis. */
    showAxisLine?: boolean;

    /** Whether to highlight the latest tick label when no other area is hovered. */
    highlightLast?: boolean;

    /** Custom formatting function for tick labels. */
    tickFormat?: (date: Date) => string;
};

/**
 * Token-backed x-axis. Colours resolve against the design-system
 * tokens (`--border-default`, `--content-muted`, `--content-emphasis`)
 * so the axis reads correctly under both dark and light themes. Tick
 * density is picked by the shared layout helpers so every chart
 * shares the same responsive curve.
 */
export function XAxis({
    maxTicks: maxTicksProp,
    showGridLines = false,
    highlightLast = true,
    showAxisLine = true,
    tickFormat = formatShortDate,
}: XAxisProps) {
    const { data, margin, width, height, xScale, startDate, endDate } =
        useChartContext();

    const { tooltipData } = useChartTooltipContext();

    const tickValues = useMemo(() => {
        const maxTicks = maxTicksProp ?? pickXAxisTickCount(width);
        return pickXAxisTickValues(data, maxTicks);
    }, [width, maxTicksProp, data]);

    return (
        <>
            <AxisBottom
                left={margin.left}
                top={margin.top + height}
                scale={xScale}
                tickValues={tickValues}
                hideTicks
                hideAxisLine={!showAxisLine}
                stroke="var(--border-default)"
                tickFormat={(date) => tickFormat(date as Date)}
                tickLabelProps={(date, idx, { length }) => ({
                    className: "transition-colors",
                    textAnchor:
                        idx === 0 ? "start" : idx === length - 1 ? "end" : "middle",
                    fontSize: AXIS_LABEL_FONT_SIZE,
                    fill: (
                        tooltipData
                            ? tooltipData.date === date
                            : highlightLast && idx === length - 1
                    )
                        ? "var(--content-emphasis)"
                        : "var(--content-muted)",
                })}
            />
            {showGridLines && (
                <Group left={margin.left} top={margin.top}>
                    {tickValues.length > 0 &&
                        tickValues.map((date) => (
                            <Line
                                key={date.toString()}
                                x1={xScale(date)}
                                x2={xScale(date)}
                                y1={height}
                                y2={0}
                                stroke={
                                    date === tooltipData?.date
                                        ? "transparent"
                                        : "var(--border-subtle)"
                                }
                                strokeWidth={1}
                                strokeDasharray={
                                    [startDate, endDate].includes(date) ? 0 : 5
                                }
                            />
                        ))}
                </Group>
            )}
        </>
    );
}
