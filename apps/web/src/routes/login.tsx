import { createFileRoute } from "@tanstack/react-router";

export const Login = () => (
    <form>
        <h1>Sign in</h1>
        <input type="email" name="" id="" />
        <button type="submit">
            Send magic link
        </button>
    </form>
)

export const Route = createFileRoute("/login")({ component: Login });
