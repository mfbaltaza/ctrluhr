# 04 — Web Setup (TanStack Start + React 19)

Goal: a React app on `:5173` that:

- Boots via TanStack Start (file-based router) + Nitro SSR
- Serves `/login` with a magic-link form
- Auth-gates every `_auth` route — unauthenticated visitors are redirected to `/login`
- Shows `/dashboard` as the day's activity: an ECharts stacked bar + a "min tracked" total
- Lists Devices on `/devices`, creates one, and shows its Enrollment Token for the daemon

**State of this phase:** the web app is built and committed (commit
`21975fe feat(web): tanstack start app, magic-link auth, dashboard + devices`).
This file is written as the built truth: each step's **Do** is the work you'd
do, each **Reference** is the end state that exists in the repo today, and
every **Verify** is an idempotent state check that doubles as the step's
entry check. Code wins for built phases (ADR-0007): if a step and the repo
disagree, the repo is right and this file is corrected to match.

> **Blocked integration, be clear about it:** the web app points at
> `http://localhost:3000` and assumes the API will serve `/devices`,
> `/analytics/day`, and better-auth's session endpoints with
> `credentials: true` CORS. Those API routes are **not built yet** — they are
> 03 §6–8 (and the CORS/port bootstrap in 03 §4), which is the *next* phase
> of work. So the web app compiles and boots, but live login/device/dashboard
> flows cannot complete until 03 §4–8 land. Steps 4–7 here verify the web
> side's state, not the end-to-end flow.

## Before you start

### Assumes (whole file)

1. **01 is done** — the monorepo exists, and `apps/web` was scaffolded
   (01 Step 2a: `pnpm dlx @tanstack/cli@latest create`, Vite-based Start
   template). 01 Step 5 retrofitted the package name to `@ctrluhr/web`.
2. **02 is done** — Neon DB, Drizzle schema, and migrations exist.
3. **03 §0–3 is done** — API deps, `apps/api/src/lib/db.ts`, the
   `@ctrluhr/schema` package, and `apps/api/src/auth.ts` (better-auth +
   magic link + Resend) exist. The web's auth client in Step 2 depends on
   that server config: `BETTER_AUTH_URL=http://localhost:3000` (03 §3.3).
4. `apps/web` is reachable from the repo root via `pnpm --filter @ctrluhr/web ...`.

Run these from the repo root; all must pass before you start any step:

```sh
git -C . rev-parse --short HEAD && test -f apps/web/package.json && echo PASS
test -f apps/web/src/router.tsx && echo PASS
```

### Mental model — the four moving pieces

TanStack Start is four layers stacked together. Knowing the division up front
saves hours of confusion:

| Piece | Owns | You write |
|---|---|---|
| **Vite + Nitro** | Dev server, bundler, SSR server runtime | `vite.config.ts` |
| **TanStack Router** | Routing (file-based), typed params/loaders | `src/routes/**` |
| **TanStack Query** | Async data fetching, caching, mutations | hooks in components |
| **TanStack Start** | SSR, server functions, `getEvent` context | (phase 0: almost nothing) |

Rule of thumb: **route loaders do server-side fetches for first render;
TanStack Query handles client-side fetch, mutation, and revalidation.** We do
not use Start server functions in phase 0 — our API is a separate service on
`:3000`, so the browser calls the Hono API directly via React Query. Server
functions are for when React and server are a single app; we may revisit at
phase 5 (Vercel deploy), not on the phase 0 path.

## 1. Toolchain and dependencies

What makes the app boot and resolve imports the way it does.

### Assumes

1. **01 is done** — `apps/web` exists with the TanStack Start scaffold and the
   `@ctrluhr/web` package name (01 Step 2a/5), and the three toolchain files
   this step rewires are present: `package.json`, `vite.config.ts`,
   `tsr.config.json`.
2. **The file-level Assumes hold** — 02 (DB) and 03 §0–3 (API bootstrap) are
   done, and `apps/web` is reachable via `pnpm --filter @ctrluhr/web` from the
   repo root.

### 1.1 Read first

1. **TanStack Start — Quick Start** —
   https://tanstack.com/start/latest/docs/framework/react/quick-start
   The project shape: where routes live, how the dev server boots. We diverge
   from the scaffold's defaults (hand-assembled Vite plugins, `#/*` alias,
   committed `routeTree.gen.ts`); the docs explain the pieces those sit on.
2. **Vite — `resolve.tsconfigPaths`** —
   https://vite.dev/config/shared-options#resolve-tsconfigpaths
   Why `vite.config.ts` resolves `tsconfig.json` path aliases with no extra
   plugin. A frequent rabbit hole; skip it.
3. **TanStack Router — file-based routing** —
   https://tanstack.com/router/latest/docs/framework/react/routing/file-based-routing
   How `src/routes/**` maps to URLs, including pathless layout routes (`_auth`).

### 1.2 Do — the scripts, the Vite config, the aliases

The scaffold's `package.json` scripts were normalized to repo-wide names
(01 Step 5a) and the config was hand-assembled. Three files carry the tooling:

- `package.json` — `"dev": "vite dev --port 5173"` (not `tanstack dev`), plus
  `generate-routes: tsr generate`, `build`, `typecheck`, `lint`. The
  `imports` field (`"#/*": "./src/*"`) is what makes `#/lib/...` resolve in
  the bundler — Node-style subpath imports that Vite understands natively.
- `vite.config.ts` — the plugin stack, in order: `devtools()`
  (`@tanstack/devtools-vite`), `nitro()` (`nitro/vite`, the SSR runtime),
  `tailwindcss()` (`@tailwindcss/vite`, Tailwind v4), `tanstackStart()`
  (`@tanstack/react-start/plugin/vite`), `viteReact()`. Plus
  `resolve: { tsconfigPaths: true }`.
- `tsr.config.json` — `{ "target": "react" }`, consumed by the `tsr generate`
  script (`@tanstack/router-cli`). The `tanstackStart()` plugin also
  regenerates `routeTree.gen.ts` on dev/build (see Step 8).

Two alias mechanisms exist and both are declared in `tsconfig.json` `paths`
(`#/*` and `@/*` → `./src/*`, plus `@ctrluhr/schema` → the schema package
source). In practice the code uses **`#/*`** (in `__root.tsx` and `_auth.tsx`)
and plain relative imports (`../lib/...`, `../../lib/...`) everywhere else;
`@/*` is declared but unused.

Dependencies (what is actually in `apps/web/package.json`, not a shopping
list): `better-auth` (React client), `@tanstack/react-query`,
`@tanstack/react-router`, `@tanstack/react-start`, `@tanstack/react-query-devtools`,
`@tanstack/react-router-devtools`, `@tanstack/react-router-ssr-query`,
`@tanstack/router-plugin`, `nitro` (aliased to `nitro-nightly`), `react`/`react-dom`
19, `echarts`, `tailwindcss` 4 + `@tailwindcss/vite`, `@ctrluhr/schema`
(workspace). Three are installed but **not imported by any web source file** —
leave them out if you're rebuilding: `echarts-for-react`, `lucide-react`,
`@tanstack/react-query-devtools`. The `@ctrluhr/schema` workspace dep is
present and path-mapped but unused by web code; the event schemas serve the
daemon↔API contract (03 §2), not the browser.

Why the extra unimported deps are still there: they were installed while
figuring out the chart and devtools setup and never pruned. Harmless; Biome
and `tsc` don't complain about unused dependencies.

#### Reference — the toolchain end state (REFERENCE ONLY)

```ts
// apps/web/vite.config.ts
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [devtools(), nitro(), tailwindcss(), tanstackStart(), viteReact()],
});

export default config;
```

```json
// apps/web/tsr.config.json
{
  "target": "react"
}
```

```json
// apps/web/package.json (scripts + imports + key deps)
{
  "name": "@ctrluhr/web",
  "imports": { "#/*": "./src/*" },
  "scripts": {
    "dev": "vite dev --port 5173",
    "generate-routes": "tsr generate",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src"
  },
  "dependencies": {
    "@ctrluhr/schema": "workspace:*",
    "@tailwindcss/vite": "^4.1.18",
    "@tanstack/react-query": "^5.101.2",
    "@tanstack/react-router": "latest",
    "@tanstack/react-start": "latest",
    "@tanstack/router-plugin": "^1.132.0",
    "better-auth": "^1.6.23",
    "echarts": "^6.1.0",
    "nitro": "npm:nitro-nightly@latest",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "tailwindcss": "^4.1.18"
  }
}
```

### Verify

From `apps/web/`:

```sh
rg -q 'tsconfigPaths: true' vite.config.ts && \
rg -q 'tanstackStart' vite.config.ts && \
rg -q '"target": "react"' tsr.config.json && \
rg -q 'vite dev --port 5173' package.json && \
rg -q '"#/\*": "./src/\*"' package.json && \
echo PASS
```

```sh
pnpm typecheck
```

Both must pass (typecheck exits 0).

### Produces

The toolchain: a `vite dev` dev server on `:5173`, a production `vite build`,
path aliases (`#/*` via `package.json` `imports` + `tsconfig` `paths`), and
the route-tree generator.

## 2. Auth + API clients

Two thin modules give the browser its only two doors to the API: a typed
better-auth client and a raw fetch helper. Both hard-code the API origin
`http://localhost:3000` in dev — that is the same host `BETTER_AUTH_URL`
names on the API side (03 §3.3), which is what makes the session cookie work
cross-origin.

### Assumes

1. **Step 1's Produces** — the toolchain is in place: `vite dev` scripts, the
   `#/*` imports alias, and a typechecking config, so the two new modules
   resolve and compile.
2. **03 §3 is done** — the API's better-auth server exists at
   `BETTER_AUTH_URL=http://localhost:3000` (03 §3.3), which is the origin
   Step 2's client and fetch wrapper point at.

### 2.1 Read first

1. **better-auth — Create Client Instance (React)** —
   https://www.better-auth.com/docs/installation#create-client-instance
   `createAuthClient` from `better-auth/react`, with the `baseURL` of the API
   (`http://localhost:3000`). This is the React variant — it also exposes the
   `useSession` hook.
2. **better-auth — Magic Link plugin (client)** —
   https://www.better-auth.com/docs/plugins/magic-link
   The `magicLinkClient()` plugin, added separately in the client config,
   gives us `signIn.magicLink({ email, callbackURL })`.
3. **`fetch` `credentials` option (MDN)** —
   https://developer.mozilla.org/en-US/docs/Web/API/RequestInit#credentials
   Why `lib/api.ts` sends `credentials: 'include'`: the session cookie is set
   by the API on `:3000`, and the browser must attach it on every cross-origin
   call to that origin.

### 2.2 Do — `src/lib/auth-client.ts`

A single `createAuthClient` call. We export two things: the full `auth`
client (used where hooks don't apply — `auth.getSession()` in `_auth.tsx`'s
`beforeLoad`), and destructured `signIn`, `signUp`, `useSession` for the
login route and components. `signUp` and `useSession` are exported but unused
today — the magic-link flow signs users up implicitly.

#### Reference (REFERENCE ONLY)

```ts
// apps/web/src/lib/auth-client.ts
import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const auth = createAuthClient({
	plugins: [magicLinkClient()],
	/** The base URL of the server (optional if you're using the same domain) */
	baseURL: "http://localhost:3000",
});

export const { signIn, signUp, useSession } = auth;
```

### 2.3 Do — `src/lib/api.ts`

A raw fetch wrapper for the non-auth calls (Devices, analytics). It adds
`credentials: 'include'` (so the session cookie rides along) and a JSON
content type, and throws on non-OK responses. In phase 5 this is replaced by
a generated Hono RPC client (`hc<...>`) for end-to-end types; for now
hand-typed keeps every byte of the call explicit. The three endpoints match
03's documented routes: `GET /devices` and `POST /devices` (03 §6.2), and
`GET /analytics/day?date=` (03 §8).

#### Reference (REFERENCE ONLY)

```ts
// apps/web/src/lib/api.ts
async function req(path: string, init: RequestInit = {}) {
	const res = await fetch(`http://localhost:3000${path}`, {
		...init,
		credentials: "include",
		headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
	if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
	return res.json();
}

export async function getDay(date: string) {
	return req(`/analytics/day?date=${date}`);
}
export async function listDevices() {
	return req("/devices");
}
export async function createDevice(input: { name: string; os: string }) {
	return req("/devices", { method: "POST", body: JSON.stringify(input) });
}
```

### Verify

From `apps/web/`:

```sh
test -f src/lib/auth-client.ts && \
rg -q 'createAuthClient' src/lib/auth-client.ts && \
rg -q 'magicLinkClient' src/lib/auth-client.ts && \
rg -q 'http://localhost:3000' src/lib/auth-client.ts && \
rg -q 'export const \{ signIn' src/lib/auth-client.ts && \
echo PASS
```

```sh
test -f src/lib/api.ts && \
rg -q "fetch\(\`http://localhost:3000" src/lib/api.ts && \
rg -q "credentials: \"include\"" src/lib/api.ts && \
rg -q '/analytics/day\?date=' src/lib/api.ts && \
rg -q 'createDevice' src/lib/api.ts && \
echo PASS
```

### Produces

`src/lib/auth-client.ts` (typed better-auth client, magic-link plugin,
`:3000` base) and `src/lib/api.ts` (fetch wrapper with session cookie) — the
two import surfaces every page uses.

## 3. Router plumbing: query client, root route, providers

Three files wire TanStack Router + TanStack Query together:
`__root.tsx` declares the root route with a typed context,
`router.tsx` passes the shared `QueryClient` through that context, and
`query-client.ts` holds the singleton instance (a separate module breaks the
circular import between `router.tsx` and `__root.tsx`).

### Assumes

1. **Steps 1–2's Produces** — the toolchain and the two API-client modules
   (`auth-client.ts`, `api.ts`) exist, and the `#/*` alias resolves, so the
   root route can import `#/lib/query-client`.
2. **The route-tree file exists** — `src/routeTree.gen.ts` comes from the
   scaffold (regenerated on dev/build, committed in Step 8); `router.tsx`
   imports it.

### 3.1 Read first

1. **TanStack Router — `createRootRouteWithContext`** —
   https://tanstack.com/router/latest/docs/framework/react/api/router/createRootRouteWithContextFunction
   The generic that types the `queryClient` injected by the router. Read the
   "Root Route" section.
2. **TanStack Router — router context** —
   https://tanstack.com/router/latest/docs/framework/react/guide/router-context
   How the `RouterContext` declared on the root route is available in every
   child route's `beforeLoad`/`loader`.
3. **TanStack Query — `QueryClientProvider`** —
   https://tanstack.com/query/latest/docs/framework/react/quick-start
   The provider that wires the client to React.

### 3.2 Do — the three files

There is no `main.tsx` in a TanStack Start app — the `tanstackStart()` Vite
plugin manages the client/server entry points itself. So the
`QueryClientProvider` lives in the root route's `shellComponent` instead.
Three behaviors matter beyond the provider:

- The **`errorComponent`** on `__root.tsx` catches unhandled errors during
  render/load. If the error mentions `fetch`, `Unauthorized`, `401`, or
  `403`, it `Navigate`s to `/login` — this is the client-side fallback when a
  page's API call fails (e.g. session expired). Anything else renders a plain
  "Something went wrong" page.
- `router.tsx` sets `scrollRestoration: true`, `defaultPreload: 'intent'`,
  and `defaultPreloadStaleTime: 0` — route links preload on hover/intent.
- `__root.tsx` imports the client via the `#/lib/query-client` alias; this is
  one of the two files that exercises the `#/*` alias from Step 1.

#### Reference (REFERENCE ONLY)

```ts
// apps/web/src/lib/query-client.ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient();
```

```tsx
// apps/web/src/routes/__root.tsx
import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Navigate,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { queryClient } from "#/lib/query-client";
import appCss from "../styles.css?url";

export interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "ctrluhr" },
		],
		links: [{ rel: "stylesheet", href: appCss }],
	}),
	errorComponent: ({ error }) => {
		if (
			error instanceof Error &&
			(error.message.includes("fetch") ||
				error.message.includes("Unauthorized") ||
				error.message.includes("401") ||
				error.message.includes("403"))
		) {
			return <Navigate to="/login" />;
		}
		return (
			<html lang="en">
				<head>
					<meta charSet="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>Error - ctrluhr</title>
				</head>
				<body>
					<div style={{ padding: "2rem", fontFamily: "system-ui" }}>
						<h1>Something went wrong</h1>
						<pre style={{ color: "red" }}>{error.message}</pre>
					</div>
				</body>
			</html>
		);
	},
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<QueryClientProvider client={queryClient}>
					{children}
				</QueryClientProvider>
				<TanStackDevtools
					config={{ position: "bottom-right" }}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}
```

```ts
// apps/web/src/router.tsx
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { queryClient } from "./lib/query-client";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const router = createTanStackRouter({
		routeTree,
		context: { queryClient },
		scrollRestoration: true,
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
	});

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
```

### Verify

From `apps/web/`:

```sh
test -f src/lib/query-client.ts && \
rg -q 'new QueryClient' src/lib/query-client.ts && \
rg -q 'createRootRouteWithContext<RouterContext>' src/routes/__root.tsx && \
rg -q 'QueryClientProvider client=\{queryClient\}' src/routes/__root.tsx && \
rg -q 'errorComponent' src/routes/__root.tsx && \
rg -q 'Navigate to="/login"' src/routes/__root.tsx && \
rg -q 'context: \{ queryClient \}' src/router.tsx && \
rg -q 'defaultPreload: "intent"' src/router.tsx && \
echo PASS
```

### Produces

`src/lib/query-client.ts`, `src/routes/__root.tsx`, `src/router.tsx` — the
root route with typed context, the Query provider + devtools + error
component, and the router instance Start SSR calls.

## 4. Login route

A form that calls `signIn.magicLink({ email, callbackURL })`, then swaps to a
"check your inbox" state. The click-to-verify happens on the API host
(`:3000/auth/magic-link/verify`); better-auth then redirects the browser to
`callbackURL` after setting the session cookie.

### Assumes

1. **Step 2's Produces** — `signIn` is exported from `src/lib/auth-client.ts`
   (the better-auth React client with the magic-link plugin).
2. **Steps 1–3's Produces** — the toolchain and the query/router plumbing
   (`QueryClientProvider`, typed root route) are in place, so the route
   renders and typechecks.

### 4.1 Read first

1. **better-auth — Magic Link, Sign In (client)** —
   https://www.better-auth.com/docs/plugins/magic-link#sign-in-with-magic-link
   The `signIn.magicLink({ email, callbackURL })` shape and its `{ data,
   error }` return. `callbackURL` is where the user lands after clicking the
   email link; without `newUserCallbackURL`/`errorCallbackURL`, failures land
   on `callbackURL` with an `?error=` query param.
2. **TanStack Router — file-based route declaration** —
   https://tanstack.com/router/latest/docs/framework/react/routing/file-based-routing
   `src/routes/login.tsx` becomes `/login` with no extra config.

### 4.2 Do — `src/routes/login.tsx`

Plain React: state for `email`, a `sent`/`form` switch, and an `err` string.
Submit checks the `error` branch of `signIn.magicLink`. The `callbackURL` is
`/dashboard` — where the user lands after authenticating. If a user ends up
on the wrong URL (404 or wrong port) after clicking the link, the two suspects
are this `callbackURL` and the API's `BETTER_AUTH_URL` (03 §3.3) — re-read
both.

#### Reference (REFERENCE ONLY)

```tsx
// apps/web/src/routes/login.tsx
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
```

### Verify

From `apps/web/`:

```sh
test -f src/routes/login.tsx && \
rg -q "signIn.magicLink" src/routes/login.tsx && \
rg -q 'callbackURL: "/dashboard"' src/routes/login.tsx && \
rg -q 'createFileRoute\("/login"\)' src/routes/login.tsx && \
echo PASS
```

### Produces

`src/routes/login.tsx` — the magic-link entry form.

## 5. Auth gate — `_auth` layout route + `/` redirect

A **pathless layout route** applies the "must be logged in" check once, to
every route under `_auth/`. The check runs in `beforeLoad`, before the route
component renders. Separately, the index route `/` redirects to `/dashboard`.

### Assumes

1. **Step 2's Produces** — the full `auth` client (the `createAuthClient`
   export) provides `auth.getSession()` for `beforeLoad`.
2. **Step 4's Produces** — `src/routes/login.tsx` exists; the gate redirects
   there, and `/` needs a target, so `index.tsx` redirects to `/dashboard`.

### 5.1 Read first

1. **TanStack Router — authenticated routes** —
   https://tanstack.com/router/latest/docs/framework/react/guide/authenticated-routes
   Exactly our pattern; read the "Redirecting" subsection for the
   `throw redirect({ to, search })` shape.
2. **TanStack Router — pathless route groups** —
   https://tanstack.com/router/latest/docs/framework/react/routing/file-based-routing
   The `_auth.tsx` file (leading underscore) is a pathless layout: it
   contributes no URL segment, so `_auth/dashboard.tsx` is `/dashboard` and
   `_auth/devices.tsx` is `/devices`. The Vite plugin reads the directory
   structure and auto-generates the parent–child relationship in
   `routeTree.gen.ts` (see Step 8).

### 5.2 Do — `src/routes/_auth.tsx` and `src/routes/index.tsx`

`beforeLoad` calls `auth.getSession()` (the full client from Step 2 — this is
where a hook can't apply) and throws a redirect to `/login` with the current
`location.href` as the `redirect` search param when there's no session, so the
login route can send the user back after they authenticate. (The login route
doesn't currently read `redirect` — the param is carried for that future use.)

`src/routes/index.tsx` throws a redirect to `/dashboard` in its loader, so a
bare `/` lands on the dashboard, which is behind the gate.

#### Reference (REFERENCE ONLY)

```tsx
// apps/web/src/routes/_auth.tsx
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { auth } from "#/lib/auth-client";

export const Route = createFileRoute("/_auth")({
	beforeLoad: async ({ location }) => {
		const { data: session } = await auth.getSession();
		if (!session) {
			throw redirect({ to: "/login", search: { redirect: location.href } });
		}
	},
	component: () => <Outlet />,
});
```

```tsx
// apps/web/src/routes/index.tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	loader: () => {
		throw redirect({ to: "/dashboard" });
	},
});
```

### Pitfalls

**SSR session check fails — the session cookie never leaves the browser.**
`beforeLoad` runs server-side during SSR (Nitro). `auth.getSession()` calls
`:3000`, but the browser's session cookie lives on `:3000`, not `:5173` — the
SSR context has no cookie to send, so the server sees "no session" and serves
a redirect even for a logged-in user. Observed behavior with the API down:
`GET /dashboard` returns **500**, not a redirect, because the `getSession`
fetch itself throws before the redirect is built. Deferred for phase 0 —
there is no cookie-forwarding or `/api` proxy yet (both are sketched as the
proper fixes; see `docs/07-future-phases.md`). The client-side
`errorComponent` (Step 3) is the current fallback for fetch failures.

### Verify

From `apps/web/`:

```sh
test -f src/routes/_auth.tsx && \
rg -q 'auth.getSession' src/routes/_auth.tsx && \
rg -q 'throw redirect\(\{ to: "/login", search: \{ redirect: location.href \}' src/routes/_auth.tsx && \
rg -q 'component: \(\) => <Outlet />' src/routes/_auth.tsx && \
test -f src/routes/index.tsx && \
rg -q 'throw redirect\(\{ to: "/dashboard" \}' src/routes/index.tsx && \
echo PASS
```

### Produces

`src/routes/_auth.tsx` (the auth gate) and `src/routes/index.tsx` (the `/`
redirect). From here, every route under `src/routes/_auth/` is protected.

## 6. Devices route

A list + create form for Devices (glossary: a machine running one daemon,
enrolled by a User). Mostly our own UI; the only library surface is TanStack
Query's `useQuery`/`useMutation`/`useQueryClient` and our `lib/api.ts`.

### Assumes

1. **Steps 1–2's Produces** — `listDevices`/`createDevice` exist in
   `src/lib/api.ts`, and the toolchain typechecks the new route.
2. **Step 5's Produces** — the `_auth` gate is in place, so the devices route
   is protected.
3. **03 §6.2's shape** — `GET/POST /devices` return `{ devices: [...] }` and
   `{ enrollment_token, expires_at }`. Those routes are **not built yet**
   (03 §4–8 is plan-first), so this step's live flow is blocked — verify the
   web side's state, not the round-trip (see the blocked-integration note).

### 6.1 Read first

1. **TanStack Query — Queries** —
   https://tanstack.com/query/latest/docs/framework/react/guides/queries
2. **TanStack Query — Mutations** —
   https://tanstack.com/query/latest/docs/framework/react/guides/mutations
   The two hooks used here. "Query Invalidation" (linked from the Query
   Quick Start) covers `queryClient.invalidateQueries` for the
   create-then-refresh pattern.
3. **React 19 — `useActionState` (optional)** —
   https://react.dev/reference/react/useActionState
   Only if you want form-submit-as-action semantics instead of `onSubmit`.
   Phase 0 keeps it simple with `onSubmit` + `useState`.

### 6.2 Do — `src/routes/_auth/devices.tsx`

`useQuery({ queryKey: ['devices'], queryFn: listDevices })` renders the list;
`useMutation` creates a Device and, in `onSuccess`, both stashes the returned
Enrollment Token into state (shown in a copyable box) and
`invalidateQueries({ queryKey: ['devices'] })` so the list refetches. The
token is one-time and short-lived (~30 minutes — the Enrollment Token
glossary term), so the box tells the user to run
`ctrluhr auth enroll <token>` on the daemon machine. The list shape comes from 03 §6.2: `{ devices: [{ id, name,
os, last_seen_at }] }`.

#### Reference (REFERENCE ONLY)

```tsx
// apps/web/src/routes/_auth/devices.tsx
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
```

### Verify

From `apps/web/`:

```sh
test -f src/routes/_auth/devices.tsx && \
rg -q 'createFileRoute\("/_auth/devices"\)' src/routes/_auth/devices.tsx && \
rg -q 'queryKey: \["devices"\]' src/routes/_auth/devices.tsx && \
rg -q 'useMutation' src/routes/_auth/devices.tsx && \
rg -q 'invalidateQueries\(\{ queryKey: \["devices"\] \}\)' src/routes/_auth/devices.tsx && \
rg -q 'enrollment_token' src/routes/_auth/devices.tsx && \
echo PASS
```

### Produces

`src/routes/_auth/devices.tsx` — Device list, create form, and the Enrollment
Token copy box the daemon's `auth enroll` command consumes (daemon is 05).

## 7. Dashboard with ECharts

The dashboard queries `getDay(today)` every 15s and renders a 24-bucket
ECharts stacked bar (productive / neutral / distracting). The chart wrapper
uses `echarts.init` directly from a `useEffect` — the `echarts-for-react`
wrapper is installed but unused.

### Assumes

1. **Step 2's Produces** — `getDay` exists in `src/lib/api.ts` (the
   `/analytics/day?date=` call), and `echarts` is installed (Step 1).
2. **Steps 3–5's Produces** — the router plumbing and the `_auth` gate are in
   place, so `/dashboard` is protected and server-renderable.
3. **03 §8's shape** — `GET /analytics/day` returns `{ date, buckets }`. Like
   Step 6, the route is unbuilt (03 §4–8 plan-first), so live data is blocked;
   the "current hour" dump is the phase-0 placeholder (Step 7.3).

### 7.1 Read first

1. **ECharts — Import (npm package)** —
   https://echarts.apache.org/handbook/en/basics/import
   `import * as echarts from 'echarts'`, `echarts.init(el)`,
   `chart.setOption({...})`, `chart.dispose()`. Phase 0 uses the full import;
   the tree-shakable `echarts/core` import is a phase 5+ bundle-size
   optimization.
2. **ECharts — Stacked Bar** —
   https://echarts.apache.org/handbook/en/how-to/chart-types/bar/stacked-bar
   The `series: [{ stack: 'total', ... }]` pattern that stacks the three bars
   into one.

### 7.2 Do — `src/lib/charts/dayTimeline.tsx`

A small wrapper: props are a 24-element array of `DayTimelinePoint`, and a
`useEffect` with `[data]` deps runs `echarts.init` → `setOption` → cleanup
`dispose()`. The container needs an explicit height (`height: 320`) — ECharts
renders nothing into a zero-height div. The `setOption` includes a `legend`,
axis tooltip, hour labels, and the three stacked series with their colors.

#### Reference (REFERENCE ONLY)

```tsx
// apps/web/src/lib/charts/dayTimeline.tsx
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
```

### 7.3 Do — `src/routes/_auth/dashboard.tsx`

A `useQuery` keyed on `['day', today]` with `refetchInterval: 15_000`, so the
page refreshes every 15s while a daemon emits. The query result is shaped by
03 §8 — `{ date, buckets: [{ productive: 1 | -1 | 0, total_seconds }] }` —
and is transformed into the chart's 24 zero-buckets: all of a bucket's minutes
land in the **current hour**, because in phase 0 the API returns day totals,
not an hourly breakdown. That "current hour" dump is a placeholder — phase 1
(07 §Phase 1, Web work item 1) fixes the API to return hourly data, and the
chart (already built for 24 buckets) will consume it directly. `productive`
maps to productive/distracting/neutral per the **Productivity** glossary term
(1 / −1 / 0).

#### Reference (REFERENCE ONLY)

```tsx
// apps/web/src/routes/_auth/dashboard.tsx
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
```

> **Known deviation — flagged, do not silently "fix".** ADR-0003 says the
> dashboard's "today" must be computed in the **User's** timezone, not UTC.
> The built code uses `new Date().toISOString().slice(0, 10)`, which is UTC
> (ISO strings are always UTC). For any User off UTC, the "today" bucket is
> wrong by up to a day's offset. The ADR's fix belongs in a code change (and
> the API's `analytics/day` date handling, 03 §8), not a doc edit — it is
> on the adjudication list for this file.

### Pitfalls

**ECharts renders blank.** ECharts needs an explicit height on its mount
container; a `100%` height resolves to 0 unless the parent has a fixed
height. We set `style={{ width: '100%', height: 320 }}` — that fixed 320 is
the requirement.

### Verify

From `apps/web/`:

```sh
test -f src/lib/charts/dayTimeline.tsx && \
rg -q "import \* as echarts from \"echarts\"" src/lib/charts/dayTimeline.tsx && \
rg -q 'echarts.init' src/lib/charts/dayTimeline.tsx && \
rg -q 'stack: "total"' src/lib/charts/dayTimeline.tsx && \
rg -q 'height: 320' src/lib/charts/dayTimeline.tsx && \
test -f src/routes/_auth/dashboard.tsx && \
rg -q 'refetchInterval: 15_000' src/routes/_auth/dashboard.tsx && \
rg -q 'toISOString\(\).slice\(0, 10\)' src/routes/_auth/dashboard.tsx && \
rg -q 'getDay' src/routes/_auth/dashboard.tsx && \
echo PASS
```

```sh
pnpm typecheck
```

### Produces

`src/lib/charts/dayTimeline.tsx` (ECharts stacked-bar wrapper, full import)
and `src/routes/_auth/dashboard.tsx` (15s-polling day view) — the dashboard
behind the auth gate.

## 8. Route tree generation

`src/routeTree.gen.ts` is generated from the file system by the
`tanstackStart()` plugin (on dev/build) or by the `tsr generate` script
(`@tanstack/router-cli`, driven by `tsr.config.json`). It is **committed** so
a fresh session never waits for first-run generation.

### Assumes

1. **Steps 1–7's Produces** — the route files under `src/routes/`
   (`__root.tsx`, `login.tsx`, `index.tsx`, `_auth.tsx`,
   `_auth/devices.tsx`, `_auth/dashboard.tsx`) exist, so `tsr generate` has a
   real file tree to build.
2. **The tree is committed** — `src/routeTree.gen.ts` is in git (from the
   scaffold); this step regenerates and re-commits it, it doesn't create it
   from scratch.

### Do

Add a route file under `src/routes/`, then regenerate and commit the tree.
The `_auth` pathless layout is visible in the generated file as a parent
group with no URL segment; `/dashboard` and `/devices` hang off it, and
`/login` and `/` hang off the root. The file also registers `ssr: true` with
`@tanstack/react-start`, which is what tells the Start plugin to run routes
on the server.

### Verify

From `apps/web/`:

```sh
test -f src/routeTree.gen.ts && \
git ls-files --error-unmatch src/routeTree.gen.ts >/dev/null && \
rg -q 'import.*routes/_auth' src/routeTree.gen.ts && \
rg -q "id: '/dashboard'" src/routeTree.gen.ts && \
rg -q "id: '/_auth'" src/routeTree.gen.ts && \
rg -q 'ssr: true' src/routeTree.gen.ts && \
echo PASS
```

### Pitfalls

**Regenerating produces a noisy but equivalent diff.** Running `vite build`
(or `tsr generate`) with the current `@tanstack/router-plugin` reorders the
generated file (imports and `Route.update` blocks) versus what is committed —
the 31/31-line churn is purely ordering, semantically identical. Don't fight
it: regenerate deliberately when you add a route, commit the new tree, and
don't commit half-applied regeneration.

### Produces

`src/routeTree.gen.ts`, regenerated from the current route files and
committed — the `_auth` pathless layout with `/dashboard` and `/devices`
hanging off it, plus `/login` and `/`.

## 9. Run and verify end-to-end

### Assumes

1. **Steps 1–8's Produces** — the toolchain, all routes, the committed route
   tree, and a passing `pnpm typecheck`/`pnpm build`.
2. **`pnpm install` from the repo root** — workspace deps are linked before
   the dev server boots.
3. **Blocked, be clear:** the end-to-end happy path needs the API (03 §4–8),
   which is unbuilt — this step verifies the web side only.

### Do — what works now vs. what is blocked

Boot the dev server and confirm the pieces that are **independent of the API**:

- `/login` renders (no API call on first paint).
- `/` 307-redirects to `/dashboard` (index loader).
- `/dashboard` is behind the gate. **Today the API is not serving auth or the
  route handlers (03 §4–8 unbuilt), so a hard request to `/dashboard` fails
  server-side — observed as HTTP 500** (the SSR `getSession` fetch can't reach
  `:3000`; see the Step 5 pitfall). This 500 is expected *right now* and is
  the sign that the web side is correctly depending on an API that hasn't
  landed. When 03 §4–8 ship, a logged-in request renders the dashboard and an
  anonymous one redirects to `/login`.

The full happy path — magic link email, click → session cookie → dashboard
with data — is **blocked on 03 §4–8** and cannot be verified in this file
yet.

### Verify

From `apps/web/`, terminal 1:

```sh
pnpm dev
```

Expected: `VITE v8.1.4 ready` and `Local: http://localhost:5173/`. Then, in a
second terminal:

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/login        # 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/             # 307 (redirects to /dashboard)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/dashboard    # 500 today (API not built)
```

And the static gates, from `apps/web/`:

```sh
pnpm typecheck
pnpm build
```

`typecheck` exits 0; `build` ends with `✓ built` and emits `.output/` (Nitro
output — gitignored).

### Produces

A booted dev server on `:5173` and a successful `pnpm build` → `.output/` —
the phase-0 web surface, verifiable for login, redirect, and gate. The live
login → dashboard flow stays blocked on 03 §4–8.

### Done criteria

Built and verifiable now:

- [x] Dev server boots on `:5173`; `/login` returns 200
- [x] `/` redirects to `/dashboard`
- [x] Auth gate redirects unauthenticated users from `_auth` routes
- [x] Dashboard + ECharts stacked bar exist and typecheck (15s refetch wired)
- [x] Devices route exists (list + create + Enrollment Token box)
- [x] `pnpm typecheck` and `pnpm build` pass
- [x] Committed as `feat(web): tanstack start app, magic-link auth, dashboard + devices`

Blocked on 03 §4–8 (API routes/CORS/port) — re-verify when those land:

- [ ] `/login` form sends a magic-link email (visible in Resend logs)
- [ ] Clicking the link sets the session cookie and lands on `/dashboard`
- [ ] `/dashboard` shows live day data (needs `/analytics/day`)
- [ ] `/devices` can actually create a Device and return an Enrollment Token

## 10. Commit `[commit]`

### Assumes

1. **Step 9's Verify passed** — `pnpm typecheck`, `pnpm build`, and the curl
   gates are green; the working tree holds the phase-0 web app.

```sh
git add -A
git commit -m "feat(web): tanstack start app, magic-link auth, dashboard + devices"
```

This phase is already committed in the repo; for a fresh rebuild this is the
checkpoint.

### Verify

```sh
git log --oneline --grep="feat(web): tanstack start app" | head -1
```

Expected: the commit line for `21975fe`.

### Produces

Commit `21975fe` (`feat(web): tanstack start app, magic-link auth, dashboard
+ devices`) — the phase-0 web app checkpoint.

## Adjudication list

One line per doc↔code disagreement, with a recommendation. These are your calls:

1. **Dashboard "today" is UTC, not user-local (ADR-0003 violation)** — the
   built `dashboard.tsx` computes today with
   `new Date().toISOString().slice(0, 10)`, which is always UTC; for any User
   off UTC the "today" bucket is wrong by up to a day (flagged in Step 7 as a
   known deviation). Recommendation: code-fix ticket — compute "today" in the
   User's timezone and align with the API's `analytics/day` date handling
   (03 §8, which reads `users.timezone`), not a doc edit.
2. **SSR `getSession` can't see the session cookie — `/dashboard` 500s while
   the API is down** (Step 5 pitfall). No cookie-forwarding or `/api` proxy
   exists in phase 0; the client-side `errorComponent` (Step 3) is the
   fallback. Both are sketched as the proper fixes in
   `07-future-phases.md`. Recommendation: defer — revisit once 03 §4–8 land.
3. **Unimported deps never pruned** — `echarts-for-react`, `lucide-react`,
   `@tanstack/react-query-devtools` (and `@ctrluhr/schema`) are installed but
   not imported by any web source file (Step 1). Recommendation: code-fix
   ticket to prune once the chart/devtools setup is settled; the doc already
   lists them as leave-out-if-rebuilding.
4. **Login route ignores the `redirect` param** — the auth gate (Step 5)
   sends `?redirect=<original url>` on the way to `/login`, but `login.tsx`
   doesn't read it, so after login the user always lands on `/dashboard`.
   Recommendation: code-fix ticket to read `redirect` in `login.tsx`.
