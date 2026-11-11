import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "RogueProof — Scenario 1: Agent Zero",
  description: "Break your AI agents before the real world does.",
  icons: {
    icon: [
      { url: "/brand/favicon/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/brand/favicon/favicon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/brand/pwa/apple-touch-icon-180.png", sizes: "180x180" }],
  },
  openGraph: {
    title: "RogueProof",
    description: "Break your AI agents before the real world does.",
    images: [{ url: "/brand/social/github-social.png", width: 1280, height: 640, alt: "RogueProof" }],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/brand/social/github-social.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="mx-auto max-w-4xl bg-white px-4 py-4 font-sans text-neutral-900 antialiased">
        {children}
      </body>
    </html>
  );
}
