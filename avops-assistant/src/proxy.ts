import { NextResponse, type NextRequest } from "next/server";

/**
 * Allow the /widget page to be iframed by the Outline origin (brief §9):
 * CSP frame-ancestors instead of X-Frame-Options. Everything else keeps
 * Next's defaults; page-level auth guards live in the layouts.
 */
export function proxy(request: NextRequest) {
  const response = NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/widget")) {
    const outlineUrl = process.env.OUTLINE_URL ?? "";
    response.headers.set(
      "Content-Security-Policy",
      `frame-ancestors 'self' ${outlineUrl}`.trim(),
    );
  }

  return response;
}

export const config = {
  matcher: ["/widget/:path*", "/widget"],
};
