import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
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

// Applies the saved theme before first paint to avoid a flash.
const themeScript = `
try {
  var t = localStorage.getItem("avops-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`h-full ${spaceGrotesk.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="h-full">{children}</body>
    </html>
  );
}
