import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { auth } from '#/lib/auth-client'

export const Route = createFileRoute('/_auth')({
  beforeLoad: async ({location}) => {
    const { data: session } = await auth.getSession();
    if (!session) {
      throw redirect({to: "/login", search: { redirect: location.href }})
    }
  },
  component: () => <Outlet />
})