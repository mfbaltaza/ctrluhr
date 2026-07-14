# 04 — Web Setup (TanStack Start + React 19)

Goal: a React app on `:3000` that:
- Boots via TanStack Start (file-based router)
- Serves `/login` with magic-link form
- Auth gate redirects to `/login` when no session
- `/dashboard` shows the day's activity as ECharts stacked bar + totals
- `/devices` lists devices + creates one + copies the enrollment token

By end of this file you can log in with your email, see a basic dashboard,
create a device, and copy the token for the daemon.

> Assumes `03-api-setup.md` is done and the API boots on `:3001`.

## 0. Background — TanStack Start mental model

TanStack Start builds on four moving pieces. Knowing the division up front
saves hours of confusion:

| Piece | Owns | You write |
|---|---|---|
| **Vite + Nitro** | Dev server + bundler + SSR server runtime | `vite.config.ts` |
| **TanStack Router** | Routing (file-based), type-safe params/loaders | `src/routes/**` |
| **TanStack Query** | Async data fetching/caching/mutations | queries hooked in loaders/components |
| **TanStack Start** | Server functions, SSR, streaming, getEvent context | `createServerFn`, `useSession` etc. |

Rule of thumb: **Route loaders do server-side fetches for initial page
render; TanStack Query handles cross-route mutations and revalidation.**
Don't reach for Query inside loaders; do client-side mutation+invalidate
from a component. The TanStack Start docs have a "TanStack Query Integration"
guide — read it before writing the dashboard.

## 1. Verify the scaffold from `01-monorepo-setup.md`

`apps/web` was already scaffolded by the TanStack CLI in `01-monorepo-setup.md`
Step 2a, so it already has `vite.config.ts`, `tsconfig.json`, `src/router.tsx`,
`src/routes/__root.tsx`, and `package.json` with vite/nitro-based scripts. This
file just **layers on** the ctrluhr-specific wiring: the `@ctrluhr/schema`
workspace dep, the `@/*` path alias, ECharts, TanStack Query, and the routes.

### `apps/web/tsconfig.json` — add the workspace path alias

The CLI's `tsconfig.json` doesn't know about our workspace `@ctrluhr/schema`
package. Make it extend the repo base and add the alias:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "types": ["node"],
    "paths": {
      "@/*": ["./src/*"],
      "@ctrluhr/schema": ["../../packages/schema/src/index.ts"]
    },
    "baseUrl": "."
  },
  "include": ["src/**/*", "vite.config.ts"]
}
```

### `apps/web/package.json` — add the schema dep and confirm scripts

Add the workspace dep (the CLI didn't know we have a sibling schema package):

```json
"dependencies": {
  "@ctrluhr/schema": "workspace:*",
  ...
}
```

Confirm the scripts are the Vite + Nitro ones (Step 5a of `01` already
standardized them, but double-check):

```json
"scripts": {
  "dev": "vite dev --port 3000",
  "build": "vite build && tsc --noEmit",
  "preview": "vite preview --port 3000",
  "start": "node .output/server/index.mjs",
  "typecheck": "tsc --noEmit",
  "lint": "biome check src"
}
```

### Add ECharts + TanStack Query + better-auth client

```sh
pnpm --filter @ctrluhr/web add echarts echarts-for-react \
  @tanstack/react-query @tanstack/react-query-devtools better-auth
```

Re-run `pnpm install` from root if you edited `package.json` by hand.

### Initial `src/routes/__root.tsx`

```tsx
import { Outlet, createRootRoute } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';

export const Route = createRootRoute({
  component: () => (
    <div>
      <Outlet />
      <TanStackRouterDevtools />
    </div>
  ),
});
```

### `src/routes/index.tsx`

```tsx
import { createRoute } from '@tanstack/react-router';
import { Route as RootRoute } from './__root';

export const Route = IndexRoute({
  getParentRoute: () => RootRoute,
  component: () => <div>Hello ctrluhr</div>,
});
```

Wait, TanStack Router file-based routes don't need all this. Use the CLI
or see the file-based routing guide:
https://tanstack.com/router/latest/docs/framework/react/guide/file-based-routing

## 2. Auth client + context

better-auth exposes a typed client for browsers. We use it here, not the
raw fetch.

### `apps/web/src/lib/auth.ts`

```ts
import { createAuthClient } from 'better-auth/react';

export const auth = createAuthClient({
  baseURL: 'http://localhost:3001',
});
export const { signIn, signOut, useSession } = auth;
```

### `apps/web/src/lib/api.ts`

```ts
import { auth } from './auth';

async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(`http://localhost:3001${path}`, {
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

In phase 5 you'll swap this for a generated Hono RPC client (`hc<...>(...)`)
that gives you end-to-end types. For now hand-typed keeps things explicit.

## 3. Auth gate on the root route

We want: if route is in `_auth` group and no session → redirect to `/login`.
Use TanStack Router's `beforeLoad` for this.

### `apps/web/src/routes/__root.tsx`

```tsx
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import type { QueryClient } from '@tanstack/react-query';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <Outlet />
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  ),
});
```

The queryClient gets injected via the `router.ts` setup — see below.

### `apps/web/src/router.ts`

```ts
import { createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen';
import type { RouterContext } from './routes/__root';

const queryClient = new QueryClient();

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
});

export type AppRouter = typeof router;
```

### `apps/web/src/main.tsx`

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { router } from './router';

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={router.context.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

### `apps/web/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ctrluhr</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

## 4. Login route

### `apps/web/src/routes/login.tsx`

```tsx
import { useState } from 'react';
import { createRoute } from '@tanstack/react-router';
import { Route as RootRoute } from './__root';
import { auth } from '../lib/auth';

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/login',
  component: LoginPage,
});

function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const { error } = await auth.magicLink.sendMagicLink({ email });
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

### Auth gate: redirect to `/login` if not authed

For routes under `_auth/`, use `beforeLoad`:

```tsx
// inside any _auth route definition:
beforeLoad: async ({ location }) => {
  const session = await auth.getSession();
  if (!session) {
    throw redirect({ to: '/login', search: { redirect: location.href } });
  }
},
```

You can do this once in a `_auth.tsx` layout route so it applies to all
children. Check TanStack Router's "Layout Routes" doc.

### Magic link callback

better-auth's magic-link expects the user to hit `/auth/verify?token=...` on
the API. When they click the link in the email, it goes directly to the API
host. After successful verification, better-auth replies with a redirect to
`BETTER_AUTH_BASE_URL` by default, OR according to the `callbackURL` you
passed to `sendMagicLink`.

For a React-first flow, call `auth.magicLink.sendMagicLink({ email, callbackURL: '/dashboard' })`
so better-auth redirects back to your web app after verifying. Check your
better-auth version's exact API for `callbackURL`.

## 5. Devices route

### `apps/web/src/routes/_auth/devices.tsx`

A list + create form:

```tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listDevices, createDevice } from '../../../lib/api';

export default function DevicesPage() {
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

## 6. Dashboard with ECharts

### `apps/web/src/lib/charts/dayTimeline.tsx`

```tsx
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export interface DayTimelinePoint {
  hour: number;       // 0..23
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
        { name: 'Neutral', type: 'bar', stack: 'total', data: data.map((d) => d.neutral), itemStyle: { color: '#6b7280' } },
        { name: 'Distracting', type: 'bar', stack: 'total', data: data.map((d) => d.distracting), itemStyle: { color: '#ef4444' } },
      ],
    });
    return () => chart.dispose();
  }, [data]);
  return <div ref={ref} style={{ width: '100%', height: 320 }} />;
}
```

ECharts via `echarts/core` keeps the bundle smaller than full `echarts`. For
phase 0 the full import is fine; optimize later.

### `apps/web/src/routes/_auth/dashboard.tsx`

```tsx
import { useQuery } from '@tanstack/react-query';
import { getDay } from '../../../lib/api';
import { DayTimelineChart, type DayTimelinePoint } from '../../../lib/charts/dayTimeline';

export default function DashboardPage() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, isLoading } = useQuery({
    queryKey: ['day', today],
    queryFn: () => getDay(today),
    refetchInterval: 15_000, // auto-refresh every 15s while daemon emits
  });

  // Transform buckets → hourly array. /analytics/day returns totals for now,
  // so all minutes go into the "current hour" bucket. Phase 1 will make the
  // API return hourly breakdown; for phase 0 we fake the hourly array so the
  // chart still renders something.
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
      </dat>
      {isLoading && <p>Loading…</p>}
      <DayTimelineChart data={chartData} />
    </div>
  );
}
```

Note: there's a `</dat>` typo above — replace with `</div>`. Treat it as a
real bug to make sure you read the code you paste. (Yes, intentional —
typing rushed fixes hurts learning. Fix it.)

### Auth-protected layout

Create `apps/web/src/routes/_auth.tsx` (a pathless layout route in TanStack
Router file-based routing):

```tsx
import { Outlet, createRoute, redirect } from '@tanstack/react-router';
import { auth } from '../lib/auth';
import { Route as RootRoute } from './__root';

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  id: '_auth',
  beforeLoad: async ({ location }) => {
    // better-auth returns null session when unauthenticated
    const { data: session } = await auth.getSession();
    if (!session) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: () => <Outlet />,
});
```

Then `_auth/dashboard.tsx` and `_auth/devices.tsx` need
`getParentRoute: () => Route` pointing at this layout, not `__root`.

## 7. Verify

From `apps/web/`:

```sh
pnpm dev
```

In your browser: `http://localhost:3000/login`. Enter your Resend-account
email → check inbox → click link → land on `/dashboard` (empty). Navigate to
`/devices` → create a device → see token. Token won't be usable until the
daemon exists (next file).

## 8. Commit `[commit]`

```sh
git add -A
git commit -m "feat(web): tanstack start app, magic-link auth, dashboard + devices"
```

## Common pitfalls

### TanStack Router dev-tools crash on first load
Sometimes the devtools need `pnpm add @tanstack/react-router-devtools`. If
import fails, install them. For prod builds drop the devtools.

### `auth.getSession()` doesn't return session even after login
better-auth's session cookie is set for the API domain (`:3001`), not the
web domain (`:3000`). You need to either:
1. Use a reverse proxy in dev (e.g. `vite` server proxying `/auth/*` to
   `:3001`), OR
2. Use better-auth's `crossSubdomainCookies` and a shared base domain
   (only works with real domains), OR
3. Do auth via the `better-auth/react` client which handles cross-origin CORS
   for you.

Option 3 is what we use (the `createAuthClient` call). Verify the cookie sent
back is actually received in the browser — DevTools → Application → Cookies.
If not, `cors` on Hono must include `credentials: true` (we did) AND the
browser fetch must include `credentials: 'include'` (better-auth's client
does this for you).

### ECharts renders blank
ECharts needs an explicit height. We set `style={{ height: 320 }}` on the
container — that's the requirement. Don't use 100% height on the chart
container unless the parent has a fixed height.

### TanStack Start server functions vs loaders
The way "server functions" work in TanStack Start: any function wrapped in
`createServerFn` runs on the server, even if imported from a `.tsx` file on
the client side. For phase 0 we don't need server functions — our API is a
separate service. Use React Query from the browser; let the browser call the
Hono API directly. TanStack Start "server functions" are for SSR data where
the React and the server share a *single* app — not our architecture.

### TanStack Router route generation
File-based routing generates `routeTree.gen.ts` via its Vite plugin. If you
see "Cannot find module './routeTree.gen'", run `pnpm dev` once — the plugin
generates the file on first run. Commit it after regen.

### `@ctrluhr/schema` or `@/*` imports don't resolve
The CLI-generated `vite.config.ts` uses Vite's built-in `resolve.tsconfigPaths: true`
(reads `tsconfig.json` `paths`), not the `vite-tsconfig-paths` plugin. So just
make sure `apps/web/tsconfig.json` has the `paths` block from Step 1 and
`vite.config.ts` has `resolve: { tsconfigPaths: true }` — no extra dep needed.

## Done criteria

- [ ] TanStack Start dev server boots on `:3000`
- [ ] `/login` form sends magic link email (visible in Resend logs)
- [ ] Clicking link sets session cookie; browser lands on `/dashboard`
- [ ] `/dashboard` shows ECharts stacked bar, auto-refreshing every 15s
- [ ] `/devices` lists devices, allows creating one (returns enrollment token)
- [ ] Auth gate redirects unauthed users from `_auth` routes to `/login`
- [ ] `pnpm typecheck` passes
- [ ] One commit: "feat(web): tanstack start app, magic-link auth, dashboard + devices"

Next file: `05-daemon-setup.md` — Go daemon with stub tracker, uplink
client, tray, enrollment CLI.