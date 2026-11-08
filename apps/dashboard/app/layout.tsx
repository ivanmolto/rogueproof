import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "RogueProof — Scenario 1: Agent Zero",
  description: "Break your AI agents before the real world does.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "0 auto", maxWidth: 960, padding: 16 }}>
        {children}
      </body>
    </html>
  );
}
