import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/dashboard")({
	component: DashboardPage,
});

function DashboardPage() {
	return (
		<div className="p-8">
			<h1 className="text-xl">Dashboard</h1>
		</div>
	);
}
