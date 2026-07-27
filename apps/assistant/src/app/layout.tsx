import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";

// Heading face — geometric like the ILUMINA brand's Poppins, but with the
// weight to carry titles. Display use only (wordmark, headings), never body.
// Self-hosted by next/font at build time; no runtime Google requests.
const spaceGrotesk = Space_Grotesk({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ILUMINA AV Ops",
  description: "AI assistant for the ILUMINA AV crew knowledge base",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Manual theme override travels as a cookie so it can be applied
  // server-side — no theme-init script, no flash. Absent cookie falls back
  // to prefers-color-scheme via CSS.
  const themeCookie = (await cookies()).get("avops-theme")?.value;
  const theme = themeCookie === "light" || themeCookie === "dark" ? themeCookie : undefined;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-theme={theme}
      className={`h-full ${spaceGrotesk.variable}`}
    >
      <body className="h-full">{children}</body>
    </html>
  );
}
