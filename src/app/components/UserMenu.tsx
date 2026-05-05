import { auth, signOut } from "@/auth";

export async function UserMenu() {
  const session = await auth();
  if (!session?.user) return null;

  const label = session.user.email ?? session.user.name ?? "Signed in";

  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/signin" });
      }}
      className="flex items-center gap-2"
    >
      <span
        className="text-xs"
        style={{ color: "var(--text-muted)" }}
        title={label}
      >
        {label}
      </span>
      <button
        type="submit"
        className="rounded px-2 py-1 text-xs"
        style={{
          background: "var(--bg-surface)",
          border: "0.5px solid var(--border)",
          color: "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        Sign out
      </button>
    </form>
  );
}
