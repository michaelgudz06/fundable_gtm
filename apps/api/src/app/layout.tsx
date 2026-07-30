import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Fundable Personalization API",
  description: "Internal API: person + trigger in, voice-matched copy + evidence out.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="app-nav">
          <a href="/">Overview</a>
          <a href="/guide">Guide</a>
          <a href="/demo">Demo</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
