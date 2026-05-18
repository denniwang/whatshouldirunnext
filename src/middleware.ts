import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

export default function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const protectedPaths = ["/dashboard", "/onboarding", "/preferences"];
  const needsAuth = protectedPaths.some((p) => pathname.startsWith(p));

  if (!needsAuth) return NextResponse.next();

  const hasSession = SESSION_COOKIES.some((name) => req.cookies.has(name));
  if (!hasSession) {
    return NextResponse.redirect(new URL("/", req.nextUrl.origin));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/onboarding/:path*", "/preferences/:path*"],
};
