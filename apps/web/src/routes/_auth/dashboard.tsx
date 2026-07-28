import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { getDay } from "../../lib/api";
import {
	DayTimelineChart,
	type DayTimelinePoint,
} from "../../lib/charts/dayTimeline";

export const Route = createFileRoute("/_auth/dashboard")({
	component: DashboardPage,
});

function DashboardPage() {
	const today = new Date().toISOString().slice(0, 10);
	const { data, isLoading } = useQuery({
		queryKey: ["day", today],
		queryFn: () => getDay(today),
		refetchInterval: 15_000,
	});

	const chartData: DayTimelinePoint[] = Array.from({ length: 24 }, (_, h) => ({
		hour: h,
		productive: 0,
		neutral: 0,
		distracting: 0,
	}));

	if (data?.buckets) {
		for (const b of data.buckets) {
			const hour = new Date().getHours();
			const minutes = Math.round((b.total_seconds ?? 0) / 60);
			const point = chartData[hour]!;
			if (b.productive === 1) point.productive += minutes;
			else if (b.productive === -1) point.distracting += minutes;
			else point.neutral += minutes;
		}
	}

	const totalSeconds =
		data?.buckets?.reduce(
			(sum: number, b: { total_seconds?: number }) =>
				sum + (b.total_seconds ?? 0),
			0,
		) ?? 0;

	return (
		<div className="p-8 max-w-3xl space-y-6">
			<div className="flex justify-between items-end">
				<h1 className="text-xl">Today</h1>
				<p className="text-zinc-500">
					{Math.round(totalSeconds / 60)} min tracked
				</p>
			</div>
			{isLoading && <p>Loading…</p>}
			<DayTimelineChart data={chartData} />
		</div>
	);
}
