import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { signIn } from "../lib/auth-client";

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
	const [email, setEmail] = useState("");
	const [sent, setSent] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setErr(null);
		const { error } = await signIn.magicLink({
			email,
			callbackURL: "/dashboard",
		});
		if (error) setErr(error.message ?? "Unknown error");
		else setSent(true);
	}

	if (sent) {
		return (
			<div className="p-8">
				<h1 className="text-xl mb-2">Check your inbox</h1>
				<p className="text-zinc-400">We sent a sign-in link to {email}.</p>
			</div>
		);
	}

	return (
		<form onSubmit={submit} className="p-8 max-w-sm space-y-4">
			<h1 className="text-xl">Sign in to ctrluhr</h1>
			<input
				type="email"
				required
				placeholder="you@example.com"
				value={email}
				onChange={(e) => setEmail(e.target.value)}
				className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-700"
			/>
			<button
				type="submit"
				className="w-full px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500"
			>
				Send magic link
			</button>
			{err && <p className="text-red-400 text-sm">{err}</p>}
		</form>
	);
}
