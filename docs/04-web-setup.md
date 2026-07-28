# 04 — Web Setup (TanStack Start + React 19)

Goal: a React app on `:5173` that:
- Boots via TanStack Start (file-based router)
- Serves `/login` with magic-link form
- Auth gate redirects to `/login` when no session
- `/dashboard` shows the day's activity as ECharts stacked bar + totals
- `/devices` lists devices + creates one + copies the enrollment token

By end of this file you can log in with your email, see a basic dashboard,
create a device, and copy the token for the daemon.

> Assumes `03-api-setup.md` is done and the API boots on `:3000`.
>
> **Doc convention:** this file follows the docs-as-source-of-truth pattern
> from `docs/README.md` and `00-plan-overview.md` §0. For every library
> used (TanStack Start, TanStack Router, TanStack Query, better-auth React
> client, ECharts) the doc points you at the official docs and shows a
> reference of the end-state shape. For our own business logic (auth
> gate flow, devices page layout, dashboard chart shape) the doc goes
> heavier on code + "why".

## 0. Background — TanStack Start mental model

TanStack Start builds on four moving pieces. Knowing the division up front
saves hours of confusion:

| Piece | Owns | You write |
|---|---|---|
| **Vite + Nitro** | Dev server + bundler + SSR server runtime | `vite.config.ts` |
| **TanStack Router** | Routing (file-based), type-safe params/loaders | `src/routes/**` |
| **TanStack Query** | Async data fetching/caching/mutations | queries hooked in components |
| **TanStack Start** | Server functions, SSR, streaming, getEvent context | `createServerFn` etc. |

Rule of thumb: **Route loaders do server-side fetches for initial page
render; TanStack Query handles cross-route mutations and revalidation.**
Don't reach for Query inside loaders; do client-side mutation + invalidate
from a component. The TanStack Router docs have a "Data Loading" guide —
read that before writing the dashboard:
https://tanstack.com/router/latest/docs/framework/react/guide/data-loading

## 1. Verify the scaffold and add the workspace deps

`apps/web` was already scaffolded by the TanStack CLI in `01-monorepo-setup.md`
Step 2a, so it already has `vite.config.ts`, `tsconfig.json`, `src/router.tsx`,
`src/routes/__root.tsx`, and `package.json` with vite/nitro-based scripts. This
file just **layers on** the ctrluhr-specific wiring.

### 1.1 Read these in order

1. **TanStack Start — Quick Start** — https://tanstack.com/start/latest/docs/framework/react/quick-start
   The full project shape: where routes live, how the dev server boots,
   what the CLI scaffolded. Skim if you didn't just scaffold; deep read
   if you did.
2. **TanStack Router — file-based routing** — https://tanstack.com/router/latest/docs/framework/react/routing/file-based-routing
   How the file tree under `src/routes/` maps to URLs. We use the
   "pathless layout" pattern (`_auth.tsx` as a group with no URL prefix)
   for the auth-gated routes — see also
   [Pathless Layout Routes](https://tanstack.com/router/latest/docs/routing/routing-concepts#pathless-layout-routes)
   and [Pathless Route Group Directories](https://tanstack.com/router/latest/docs/routing/routing-concepts#pathless-route-group-directories).
3. **Vite — `resolve.tsconfigPaths`** — https://vite.dev/config/shared-options#resolve-tsconfigpaths
   Why the CLI-generated `vite.config.ts` already has path-alias support
   without needing the `vite-tsconfig-paths` plugin. (This is a frequent
   Stack Overflow rabbit hole — skip it.)

### 1.2 Path aliases and workspace dep

The CLI's `tsconfig.json` doesn't know about our workspace `@ctrluhr/schema`
package or our `@/*` alias. Edit it to extend the repo base and add the
aliases. The `paths` block is what both TS and Vite (via
`resolve.tsconfigPaths`) read.

Add the workspace dep in `package.json`:

```json
"dependencies": {
  "@ctrluhr/schema": "workspace:*",
  ...
}
```

### 1.3 Install the runtime deps

The CLI scaffolded the React/Vite bits. We add what the rest of this file
uses:

```sh
pnpm --filter @ctrluhr/web add echarts echarts-for-react \
  @tanstack/react-query @tanstack/react-query-devtools better-auth
```

Re-run `pnpm install` from the root if you edited `package.json` by hand.

`echarts-for-react` is a thin React wrapper. You can drop it later and use
`echarts.init()` directly from a `useEffect` (which is what we do in §6
anyway). Pick whichever you prefer — both are documented.

## 2. Auth client + API helper

better-auth exposes a typed client for browsers. We use it instead of raw
fetch — it handles cross-origin CORS and cookie management for us.

### 2.1 Read these in order

1. **better-auth — Create Client Instance (React tab)** —
   https://www.better-auth.com/docs/installation#create-client-instance
   `createAuthClient` from `better-auth/react`. Pass the `baseURL` of
   your API (`http://localhost:3000` in dev).
2. **better-auth — Magic Link plugin client** —
   https://www.better-auth.com/docs/plugins/magic-link#add-the-client-plugin
   The `magicLinkClient` plugin is what gives you the `signIn.magicLink`
   method we use in §4.
3. **`fetch` with `credentials: 'include'`** — https://developer.mozilla.org/en-US/docs/Web/API/RequestInit#credentials
   For the raw fetch helper in `lib/api.ts`. We need this for our non-auth
   calls to `:3000` (devices, analytics) because the session cookie is on
   that origin.

### 2.2 Write `apps/web/src/lib/auth-client.ts`

A single import + `createAuthClient` call. We export two things:

1. The full `auth` client — used where hooks don't apply (e.g. `auth.getSession()` in `_auth.tsx`'s `beforeLoad`).
2. Destructured `signIn`, `signUp`, `useSession` — the pieces the
   login route and React components actually use.

Per the better-auth docs, the magic link client plugin is added
separately in the client config — we do this because we know we'll use
`signIn.magicLink` in §4.

#### Reference — what the end file should look like

```ts
// apps/web/src/lib/auth-client.ts — REFERENCE ONLY
// Write by following the better-auth React client docs, then compare.

import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const auth = createAuthClient({
  plugins: [magicLinkClient()],
  /** The base URL of the server (optional if you're using the same domain) */
  baseURL: 'http://localhost:3000',
});

export const { signIn, signUp, useSession } = auth;
```

### 2.3 Write `apps/web/src/lib/api.ts`

A thin wrapper that adds `credentials: 'include'` (so the session cookie
rides along) and JSON content-type. The MDN doc above covers the why.

In phase 5 you'll swap this for a generated Hono RPC client
(`hc<...>(...)`) that gives you end-to-end types. For now hand-typed
keeps things explicit and lets you read every byte of the call.

#### Reference — what the end file should look like

```ts
// apps/web/src/lib/api.ts — REFERENCE ONLY

async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(`http://localhost:3000${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function getDay(date: string) {
  return req(`/analytics/day?date=${date}`);
}
export async function listDevices() {
  return req('/devices');
}
export async function createDevice(input: { name: string; os: string }) {
  return req('/devices', { method: 'POST', body: JSON.stringify(input) });
}
```

## 3. Router setup (root route, auth context, providers)

Two files wire TanStack Router + TanStack Query together, plus a shared
singleton: `__root.tsx` declares the root route with a typed context,
`router.tsx` passes the QueryClient via that context, and
`query-client.ts` holds the singleton instance to avoid circular deps.

### 3.1 Read these in order

1. **TanStack Router — `createRootRouteWithContext`** —
   https://tanstack.com/router/latest/docs/framework/react/api/router/createRootRouteWithContextFunction
   The `createRootRouteWithContext` generic is what lets you type the
   `queryClient` injected by the router. Read the "Root Route" section.
2. **TanStack Router — router context** —
   https://tanstack.com/router/latest/docs/framework/react/guide/router-context
   Specifically how `RouterContext` declared on the root route is
   available in every child route's `beforeLoad` and `loader`.
3. **TanStack Query — `QueryClientProvider`** —
   https://tanstack.com/query/latest/docs/framework/react/quick-start
   The provider wires the client to React. In our TanStack Start SSR
   scaffold there is no `main.tsx` — the provider goes in the root
   route's `shellComponent` instead.

### 3.2 Write the files

The CLI scaffold already created `__root.tsx` and `router.tsx`. We modify
both and add one helper.

#### `apps/web/src/lib/query-client.ts` — shared singleton

A separate module avoids a circular import: `router.tsx` needs the client
for `context`, and `__root.tsx` needs the type and the import for
`<QueryClientProvider>`. A third module breaks the loop.

```ts
// apps/web/src/lib/query-client.ts

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient();
```

#### `apps/web/src/routes/__root.tsx` — typed context + provider

Keep the existing SSR shell (`RootDocument`, `head()`, `Scripts`,
`shellComponent`). Two changes:

1. Replace `createRootRoute` with `createRootRouteWithContext<RouterContext>()`
   and export the `RouterContext` interface.
2. Import `<QueryClientProvider>` and wrap `{children}` inside
   `RootDocument` — this makes TanStack Query available on every page.

Reference — the end state:

```tsx
// apps/web/src/routes/__root.tsx — REFERENCE ONLY

import { TanStackDevtools } from '@tanstack/react-devtools';
import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import type { QueryClient } from '@tanstack/react-query';

import { queryClient } from '../lib/query-client';
import appCss from '../styles.css?url';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'ctrluhr' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
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
          config={{ position: 'bottom-right' }}
          plugins={[
            {
              name: 'Tanstack Router',
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

#### `apps/web/src/router.tsx` — pass queryClient in context

Import the shared singleton and add `context: { queryClient }` to the
router options. The `getRouter()` export stays — that's what TanStack
Start SSR calls internally.

```ts
// apps/web/src/router.tsx — REFERENCE ONLY

import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { queryClient } from './lib/query-client';

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
```

> **Why no `main.tsx`?** TanStack Start (SSR) manages client and server
> entry points via its `tanstackStart()` Vite plugin. There is no manual
> `ReactDOM.createRoot()` call — the framework handles it. The
> `<QueryClientProvider>` lives in the `shellComponent` above instead.

## 4. Login route

A form that calls `signIn.magicLink({ email })`, then renders a
"check your inbox" state. The actual click-to-verify happens on the API
host (`:3000/auth/callback/...`); the API redirects to your web app's
`callbackURL` after the session cookie is set.

### 4.1 Read these in order

1. **better-auth Magic Link — Sign In with Magic Link (Client tab)** —
   https://www.better-auth.com/docs/plugins/magic-link#sign-in-with-magic-link
   The `authClient.signIn.magicLink({ email, callbackURL })` shape.
   The `callbackURL` is where the user lands after clicking the link
   in their email.
2. **TanStack Router — file-based route declaration** —
   https://tanstack.com/router/latest/docs/framework/react/routing/file-based-routing
   How `src/routes/login.tsx` becomes `/login` with no extra config.

### 4.2 Write `apps/web/src/routes/login.tsx`

A standard React form: state for `email`, state for "sent" vs "form",
state for error. The `signIn.magicLink` call returns `{ data, error }`
— check the error branch.

**Where the user lands after clicking the email link** is controlled by
two things: the `callbackURL` you pass to `signIn.magicLink`, and the
`BETTER_AUTH_URL` env var on the API. If the user lands on the wrong URL
(404 or the wrong port), the issue is one of those two — re-read §3.3
of `03-api-setup.md` and the better-auth Magic Link plugin docs.

#### Reference — what the end file should look like

```tsx
// apps/web/src/routes/login.tsx — REFERENCE ONLY

import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { signIn } from '../lib/auth-client';

export const Route = createFileRoute('/login')({ component: LoginPage });

function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const { error } = await signIn.magicLink({
      email,
      callbackURL: '/dashboard',
    });
    if (error) setErr(error.message ?? 'Unknown error');
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

## 5. Auth gate — `_auth` layout route

We use a **pathless layout route** to apply the "must be logged in" check
once, to every route under `_auth/`. The check lives in `beforeLoad`,
which runs before the route's component renders.

### 5.1 Read these in order

1. **TanStack Router — `beforeLoad` for auth gates** —
   https://tanstack.com/router/latest/docs/framework/react/guide/authenticated-routes
   The "Authenticated Routes" example is exactly our pattern. Read the
   "Redirecting" subsection for the `throw redirect({ to: '/login', search: { redirect: ... } })`
   shape.
2. **TanStack Router — pathless route groups** —
   https://tanstack.com/router/latest/docs/framework/react/routing/file-based-routing
   The `_auth.tsx` file (note the leading underscore) is a pathless
   layout. URLs under `_auth/dashboard.tsx` become `/dashboard`, not
   `/_auth/dashboard`. See
   [Pathless Layout Routes](https://tanstack.com/router/latest/docs/routing/routing-concepts#pathless-layout-routes)
   for the full pattern (prefix-`_` layout file, `<Outlet />` in the
   component, no URL segment contributed).

### 5.2 Write `apps/web/src/routes/_auth.tsx`

The layout route. The URL prefix is empty because the filename starts with
`_` — the `_auth` group is inferred from the file path by the Vite plugin.

`beforeLoad` checks the session via `auth.getSession()` (per the
better-auth React client docs). If no session, throw a redirect to
`/login` with the current location as the `redirect` search param —
the login route can pick that up and send the user back after they
authenticate.

#### Reference — what the end file should look like

```tsx
// apps/web/src/routes/_auth.tsx — REFERENCE ONLY

import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { auth } from '../lib/auth-client';

export const Route = createFileRoute('/_auth')({
  beforeLoad: async ({ location }) => {
    const { data: session } = await auth.getSession();
    if (!session) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: () => <Outlet />,
});
```

`_auth/dashboard.tsx` and `_auth/devices.tsx` are placed in the `_auth/`
directory and require no extra parent wiring — the Vite plugin reads the
directory structure and auto-generates the parent-child relationship in
`routeTree.gen.ts`.

## 6. Devices route

A list + create form. Mostly our own UI; the only library surface is
TanStack Query's `useQuery` / `useMutation` / `useQueryClient` (for
invalidation) and our `lib/api.ts` helper.

### 6.1 Read these in order

1. **TanStack Query — Queries + Mutations** —
   https://tanstack.com/query/latest/docs/framework/react/guides/queries
   and https://tanstack.com/query/latest/docs/framework/react/guides/mutations
   The two hooks you'll use 90% of the time. The "Query Invalidation"
   guide (linked from the Quick Start) covers `queryClient.invalidateQueries`
   for the create-mutation-then-refresh-list pattern.
2. **React 19 — `useActionState` (optional)** —
   https://react.dev/reference/react/useActionState
   If you want form-submit-as-action semantics instead of `onSubmit`,
   read this. Phase 0 keeps it simple with `onSubmit` + `useState`.

### 6.2 Write `apps/web/src/routes/_auth/devices.tsx`

The shape: `useQuery` for the list, `useMutation` for create, and
`onSuccess` invalidates the query so the list refetches. The enrollment
token returned by the API is shown in a copyable box.

#### Reference — what the end file should look like

```tsx
// apps/web/src/routes/_auth/devices.tsx — REFERENCE ONLY

import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listDevices, createDevice } from '../../lib/api';

export const Route = createFileRoute('/devices')({ component: DevicesPage });

function DevicesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['devices'], queryFn: listDevices });
  const [name, setName] = useState('my-laptop');
  const [os, setOs] = useState('linux');
  const [token, setToken] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => createDevice({ name, os }),
    onSuccess: (data) => {
      setToken(data.enrollment_token);
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  return (
    <div className="p-8 max-w-xl space-y-6">
      <h1 className="text-xl">Devices</h1>

      <ul className="space-y-2">
        {isLoading && <li>Loading…</li>}
        {data?.devices?.map((d) => (
          <li key={d.id} className="flex justify-between border-b border-zinc-800 py-2">
            <span>{d.name} <span className="text-zinc-500">({d.os})</span></span>
            <span className="text-zinc-500">{d.last_seen_at ?? 'never seen'}</span>
          </li>
        ))}
      </ul>

      <form
        onSubmit={(e) => { e.preventDefault(); mut.mutate(); }}
        className="space-y-2"
      >
        <input value={name} onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-700" />
        <select value={os} onChange={(e) => setOs(e.target.value)}
          className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-700">
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
          <p className="text-sm mb-2">Enrollment token (one-time, expires in 30m):</p>
          <code className="block break-all text-emerald-400">{token}</code>
          <p className="text-xs text-zinc-500 mt-2">
            On the daemon machine run: <code>ctrluhr auth enroll &lt;token&gt;</code>
          </p>
        </div>
      )}
    </div>
  );
}
```

## 7. Dashboard with ECharts

The dashboard queries `getDay(today)` on a 15s interval, and renders an
ECharts stacked bar of hours 0..23. The chart is a `useEffect` that
calls `echarts.init(container)` on mount, `setOption({...})` on data
change, and `dispose()` on unmount. Read the ECharts handbook entry for
the import pattern; everything else is plain React.

### 7.1 Read these in order

1. **ECharts — Import (NPM Package)** — https://echarts.apache.org/handbook/en/basics/import
   The `import * as echarts from 'echarts'` + `echarts.init(el)` +
   `chart.setOption({...})` + `chart.dispose()` pattern. We use the
   "full" import for phase 0; the tree-shakable import is a phase 5+
   bundle-size optimization.
2. **ECharts — Stacked Bar** —
   https://echarts.apache.org/handbook/en/how-to/chart-types/bar/stacked-bar
   The `series: [{ stack: 'total', ... }]` pattern that makes three bars
   stack into one. The dashboard uses this for productive / neutral /
   distracting.

### 7.2 Write `apps/web/src/lib/charts/dayTimeline.tsx`

A small wrapper component. It receives a 24-element array (one bucket
per hour) and renders the ECharts stacked bar. The
`useEffect` → `setOption` → `dispose` pattern is standard; copy it
from the ECharts handbook.

#### Reference — what the end file should look like

```tsx
// apps/web/src/lib/charts/dayTimeline.tsx — REFERENCE ONLY

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export interface DayTimelinePoint {
  hour: number;        // 0..23
  productive: number;  // minutes
  neutral: number;
  distracting: number;
}

export function DayTimelineChart({ data }: { data: DayTimelinePoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['Productive', 'Neutral', 'Distracting'] },
      xAxis: { type: 'category', data: data.map((d) => `${d.hour}:00`) },
      yAxis: { type: 'value', name: 'minutes' },
      series: [
        { name: 'Productive', type: 'bar', stack: 'total', data: data.map((d) => d.productive), itemStyle: { color: '#22c55e' } },
        { name: 'Neutral',    type: 'bar', stack: 'total', data: data.map((d) => d.neutral),    itemStyle: { color: '#6b7280' } },
        { name: 'Distracting',type: 'bar', stack: 'total', data: data.map((d) => d.distracting),itemStyle: { color: '#ef4444' } },
      ],
    });
    return () => chart.dispose();
  }, [data]);
  return <div ref={ref} style={{ width: '100%', height: 320 }} />;
}
```

> ECharts via `echarts/core` keeps the bundle smaller than the full
> `echarts` import. For phase 0 the full import is fine; optimize
> later.

### 7.3 Write `apps/web/src/routes/_auth/dashboard.tsx`

A `useQuery` that polls `getDay(today)` every 15s, then transforms the
buckets into the 24-element array the chart wants. **For phase 0, the
API returns day totals, not hourly breakdown** — so we put all minutes
into the "current hour" bucket. The chart still renders, and phase 1
fixes the API to return hourly data (this is exactly what
`07-future-phases.md` §Phase 1 documents).

#### Reference — what the end file should look like

```tsx
// apps/web/src/routes/_auth/dashboard.tsx — REFERENCE ONLY

import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getDay } from '../../lib/api';
import { DayTimelineChart, type DayTimelinePoint } from '../../lib/charts/dayTimeline';

export const Route = createFileRoute('/dashboard')({ component: DashboardPage });

function DashboardPage() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, isLoading } = useQuery({
    queryKey: ['day', today],
    queryFn: () => getDay(today),
    refetchInterval: 15_000, // auto-refresh every 15s while daemon emits
  });

  // Initialize 24 zero-buckets. Phase 0 puts everything into the current
  // hour; phase 1 makes the API return hourly and we drop the fake.
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
      if (b.productive === 1) chartData[hour].productive += minutes;
      else if (b.productive === -1) chartData[hour].distracting += minutes;
      else chartData[hour].neutral += minutes;
    }
  }

  const totalSeconds = data?.buckets?.reduce((sum: number, b) => sum + (b.total_seconds ?? 0), 0) ?? 0;

  return (
    <div className="p-8 max-w-3xl space-y-6">
      <div className="flex justify-between items-end">
        <h1 className="text-xl">Today</h1>
        <p className="text-zinc-500">{Math.round(totalSeconds / 60)} min tracked</p>
      </div>
      {isLoading && <p>Loading…</p>}
      <DayTimelineChart data={chartData} />
    </div>
  );
}
```

## 8. Verify

From `apps/web/`:

```sh
pnpm dev
```

In your browser: `http://localhost:5173/login`. Enter your Resend-account
email → check inbox → click link → land on `/dashboard` (empty). Navigate to
`/devices` → create a device → see token. Token won't be usable until the
daemon exists (next file).

## 9. Commit `[commit]`

```sh
git add -A
git commit -m "feat(web): tanstack start app, magic-link auth, dashboard + devices"
```

## Common pitfalls

### TanStack Router dev-tools crash on first load
Sometimes the devtools need `pnpm add @tanstack/react-router-devtools`. If
import fails, install them. For prod builds drop the devtools.

### `auth.getSession()` doesn't return session even after login
better-auth's session cookie is set for the API domain (`:3000`), not the
web domain (`:5173`). The `createAuthClient` from §2.2 sends
`credentials: 'include'` on every call, so the browser attaches the
cookie on cross-origin requests. If the cookie doesn't reach the API,
check two things in order:
1. The API's CORS config in `03-api-setup.md` §4 has
   `credentials: true` (we set this).
2. DevTools → Application → Cookies → `http://localhost:3000` shows the
   `better-auth.session_token` cookie after a successful login.

If both are true and `getSession` still returns null, the better-auth
docs have a CORS / cookies section under Integrations — read it.

### SSR session check fails: cookie not forwarded to API

> **CAUTION — deferred.** The `_auth.tsx` `beforeLoad` calls
> `auth.getSession()` which hits `:3000`. During SSR, the Nitro server
> runs this check — but the browser's session cookie lives on `:3000`,
> not `:5173`, so the SSR context has no cookie to send. Result:
> `beforeLoad` sees no session and redirects to `/login` even for users
> who are already logged in. On hydration the client re-checks, discovers
> the session, and re-renders the dashboard — causing a flash of the
> login page.
>
> **When this matters:** when the API is running and a logged-in user
> hits an auth-gated route directly (hard reload or first visit).
>
> **Proper fixes (pick one):**
>
> 1. **Forward cookies in `beforeLoad`** — use `getEvent()` from
>    `@tanstack/react-start` to read the incoming request's `Cookie`
>    header and forward it to the API call. SSR has the session.
> 2. **Proxy `/api/*` through Nitro** — add a Nitro server handler that
>    forwards API calls. The browser talks to `:5173` only; cookies stay
>    same-origin.
>
> For phase 0 this is deferred. The `errorComponent` on `__root.tsx`
> catches unhandled fetch errors and redirects to `/login` as a fallback.

### ECharts renders blank
ECharts needs an explicit height on its container. We set
`style={{ height: 320 }}` on the container — that's the requirement.
Don't use `100%` height on the chart container unless the parent has a
fixed height.

### TanStack Start server functions vs loaders
For phase 0 we don't need server functions — our API is a separate
service. Use React Query from the browser; let the browser call the
Hono API directly. TanStack Start "server functions" are for SSR data
where the React and the server share a *single* app — not our
architecture. We may revisit this in phase 5 (Vercel deploy) but it's
not on the phase 0 path.

### TanStack Router route generation
File-based routing generates `routeTree.gen.ts` via its Vite plugin. If
you see "Cannot find module './routeTree.gen'", run `pnpm dev` once —
the plugin generates the file on first run. Commit it after regen.

### `@ctrluhr/schema` or `@/*` imports don't resolve
The CLI-generated `vite.config.ts` uses Vite's built-in
`resolve: { tsconfigPaths: true }` (reads `tsconfig.json` `paths`), not
the `vite-tsconfig-paths` plugin. So just make sure
`apps/web/tsconfig.json` has the `paths` block from §1.2 and
`vite.config.ts` has `resolve: { tsconfigPaths: true }` — no extra dep
needed.

## Done criteria

- [X] TanStack Start dev server boots on `:5173`
- [ ] `/login` form sends magic link email (visible in Resend logs)
- [ ] Clicking link sets session cookie; browser lands on `/dashboard`
- [ ] `/dashboard` shows ECharts stacked bar, auto-refreshing every 15s
- [ ] `/devices` lists devices, allows creating one (returns enrollment token)
- [X] Auth gate redirects unauthed users from `_auth` routes to `/login`
- [X] `pnpm typecheck` passes
- [X] One commit: "feat(web): tanstack start app, magic-link auth, dashboard + devices"

- [ ] Optional: fix SSR session cookie forwarding (see "SSR session check fails" in Common pitfalls)
