import { signIn, auth } from "@/auth";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Sign in | Byron Planner",
};

type SearchParams = Promise<{ callbackUrl?: string; error?: string }>;

export default async function SignInPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  const { callbackUrl, error } = await searchParams;

  if (session?.user) {
    redirect(callbackUrl ?? "/");
  }

  return (
    <div
      className="flex flex-1 items-center justify-center px-6 py-24"
      style={{ minHeight: "60vh" }}
    >
      <div
        className="w-full max-w-sm rounded-lg p-8 flex flex-col gap-6"
        style={{
          background: "var(--bg-elevated, var(--bg-page))",
          border: "0.5px solid var(--border)",
        }}
      >
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
            Byron Planner
          </h1>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Sign in with your <strong>@thebyroncoop.com</strong> Google account.
          </p>
        </div>

        {error ? (
          <div
            className="rounded-md p-3 text-sm"
            style={{
              background: "var(--bg-page)",
              border: "0.5px solid var(--border)",
              color: "var(--text-primary)",
            }}
          >
            {error === "AccessDenied"
              ? "That account isn't part of the thebyroncoop.com workspace."
              : "Sign-in failed. Try again or contact an admin."}
          </div>
        ) : null}

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: callbackUrl ?? "/" });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-md px-4 py-2.5 text-sm font-medium"
            style={{
              background: "var(--text-primary)",
              color: "var(--bg-page)",
              cursor: "pointer",
            }}
          >
            Continue with Google
          </button>
        </form>
      </div>
    </div>
  );
}
