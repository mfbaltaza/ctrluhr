import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { createDevice, listDevices } from "../../lib/api";

export const Route = createFileRoute("/_auth/devices")({
	component: DevicesPage,
});

function DevicesPage() {
	const qc = useQueryClient();
	const { data, isLoading } = useQuery({
		queryKey: ["devices"],
		queryFn: listDevices,
	});
	const [name, setName] = useState("my-laptop");
	const [os, setOs] = useState("linux");
	const [token, setToken] = useState<string | null>(null);

	const mut = useMutation({
		mutationFn: () => createDevice({ name, os }),
		onSuccess: (data) => {
			setToken(data.enrollment_token);
			qc.invalidateQueries({ queryKey: ["devices"] });
		},
	});

	return (
		<div className="p-8 max-w-xl space-y-6">
			<h1 className="text-xl">Devices</h1>

			<ul className="space-y-2">
				{isLoading && <li>Loading…</li>}
				{data?.devices?.map(
					(d: {
						id: string;
						name: string;
						os: string;
						last_seen_at?: string;
					}) => (
						<li
							key={d.id}
							className="flex justify-between border-b border-zinc-800 py-2"
						>
							<span>
								{d.name} <span className="text-zinc-500">({d.os})</span>
							</span>
							<span className="text-zinc-500">
								{d.last_seen_at ?? "never seen"}
							</span>
						</li>
					),
				)}
			</ul>

			<form
				onSubmit={(e) => {
					e.preventDefault();
					mut.mutate();
				}}
				className="space-y-2"
			>
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-700"
				/>
				<select
					value={os}
					onChange={(e) => setOs(e.target.value)}
					className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-700"
				>
					<option value="linux">Linux</option>
					<option value="windows">Windows</option>
					<option value="darwin">macOS</option>
				</select>
				<button className="px-4 py-2 rounded bg-emerald-600">
					Create device
				</button>
			</form>

			{token && (
				<div className="p-3 rounded bg-zinc-900 border border-zinc-700">
					<p className="text-sm mb-2">
						Enrollment token (one-time, expires in 30m):
					</p>
					<code className="block break-all text-emerald-400">{token}</code>
					<p className="text-xs text-zinc-500 mt-2">
						On the daemon machine run:{" "}
						<code>ctrluhr auth enroll &lt;token&gt;</code>
					</p>
				</div>
			)}
		</div>
	);
}
