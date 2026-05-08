import { auth } from "@/auth";
import { NextResponse } from "next/server";

/**
 * Local-dev escape hatch: when `DISABLE_AUTH=true` is set in `.env.local`,
 * the SSO gate is bypassed and every route renders without requiring a
 * Google session. Intended ONLY for solo local development — never set
 * this in any deployed environment. Default behaviour (var unset) is
 * unchanged: production redirects unauthenticated requests to /signin.
 */
const SKIP_AUTH = process.env.DISABLE_AUTH === "true";

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith("/api/auth") ||
    pathname === "/signin" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  if (SKIP_AUTH) return NextResponse.next();

  if (!req.auth) {
    const signInUrl = new URL("/signin", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
