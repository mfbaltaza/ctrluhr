import * as echarts from "echarts";
import { useEffect, useRef } from "react";

export interface DayTimelinePoint {
	hour: number;
	productive: number;
	neutral: number;
	distracting: number;
}

export function DayTimelineChart({ data }: { data: DayTimelinePoint[] }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!ref.current) return;
		const chart = echarts.init(ref.current);
		chart.setOption({
			tooltip: { trigger: "axis" },
			legend: { data: ["Productive", "Neutral", "Distracting"] },
			xAxis: { type: "category", data: data.map((d) => `${d.hour}:00`) },
			yAxis: { type: "value", name: "minutes" },
			series: [
				{
					name: "Productive",
					type: "bar",
					stack: "total",
					data: data.map((d) => d.productive),
					itemStyle: { color: "#22c55e" },
				},
				{
					name: "Neutral",
					type: "bar",
					stack: "total",
					data: data.map((d) => d.neutral),
					itemStyle: { color: "#6b7280" },
				},
				{
					name: "Distracting",
					type: "bar",
					stack: "total",
					data: data.map((d) => d.distracting),
					itemStyle: { color: "#ef4444" },
				},
			],
		});
		return () => chart.dispose();
	}, [data]);
	return <div ref={ref} style={{ width: "100%", height: 320 }} />;
}
