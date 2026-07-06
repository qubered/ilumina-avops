import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

// ILUMINA's brand face — display use only (wordmark, titles), never body.
// Self-hosted by next/font at build time; no runtime Google requests.
const poppins = Poppins({
  weight: "200",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-poppins",
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
    <html lang="en" suppressHydrationWarning className={`h-full ${poppins.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="h-full">{children}</body>
    </html>
  );
}
