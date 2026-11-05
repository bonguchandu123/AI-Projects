import type { Metadata } from "next";
import { Suspense } from "react";
import { BrainCircuit } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "ContextOS",
  description: "Decision-aware memory intelligence for AI workspaces",
};

/** Static shell shown while the client shell (which reads the URL) streams in. */
function ShellFallback() {
  return (
    <div className="flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground">
      <BrainCircuit className="size-4 animate-pulse text-primary" aria-hidden /> Loading ContextOS…
    </div>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full bg-background font-sans text-foreground">
        <Suspense fallback={<ShellFallback />}>
          <AppShell>{children}</AppShell>
        </Suspense>
      </body>
    </html>
  );
}
