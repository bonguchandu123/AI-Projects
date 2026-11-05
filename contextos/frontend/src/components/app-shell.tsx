"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  BarChart3, BrainCircuit, CalendarRange, Gavel, LayoutDashboard, Menu, MessageSquarePlus, Network, Plug, ScanSearch,
  ShieldAlert, FolderKanban, X,
} from "lucide-react";
import { useApi, type Project } from "@/lib/api";
import { cn } from "@/lib/utils";
import { selectClass } from "@/components/cos";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/ask", label: "Ask ContextOS", icon: ScanSearch, accent: true },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/ingest", label: "Ingest conversations", icon: MessageSquarePlus },
  { href: "/decisions", label: "Decision intelligence", icon: Gavel },
  { href: "/timeline", label: "Timeline", icon: CalendarRange },
  { href: "/graph", label: "Memory graph", icon: Network },
  { href: "/review", label: "Review queue", icon: ShieldAlert },
  { href: "/evaluation", label: "Evaluation", icon: BarChart3 },
  { href: "/settings", label: "Integrations", icon: Plug },
];

interface ProjectCtx {
  projects: Project[];
  projectId: string | null;
  project: Project | null;
  setProjectId: (id: string | null) => void;
  reloadProjects: () => Promise<void>;
  loading: boolean;
}

const Ctx = createContext<ProjectCtx | null>(null);

export function useProjects(): ProjectCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjects outside AppShell");
  return v;
}

const STORAGE_KEY = "contextos.projectId";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data, reload, loading } = useApi<Project[]>("/projects");
  const [chosen, setChosen] = useState<string | null>(() => (typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY)));
  const [mobileOpen, setMobileOpen] = useState(false);

  const projects = useMemo(() => data ?? [], [data]);
  const projectId = data?.some((p) => p.id === chosen) ? chosen : (data?.find((p) => p.isDemo)?.id ?? data?.[0]?.id ?? null);

  const setProjectId = (id: string | null) => {
    setChosen(id);
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
  };
  const ctx: ProjectCtx = {
    projects, projectId, project: projects.find((p) => p.id === projectId) ?? null, setProjectId,
    reloadProjects: reload, loading,
  };

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
              active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )}
          >
            <Icon className={cn("size-4", active || item.accent ? "text-primary" : "")} aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <Ctx.Provider value={ctx}>
      <div className="flex min-h-svh">
        <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 py-4 lg:flex">
          <Brand />
          <div className="mt-6 flex-1 overflow-y-auto">{nav}</div>
          <SidebarFooter />
        </aside>

        {mobileOpen ? (
          <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setMobileOpen(false)}>
            <aside className="h-full w-64 border-r border-sidebar-border bg-sidebar px-3 py-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <Brand />
                <button aria-label="Close menu" onClick={() => setMobileOpen(false)} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
                  <X className="size-4" />
                </button>
              </div>
              <div className="mt-6">{nav}</div>
            </aside>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border/60 bg-background/80 px-4 backdrop-blur md:px-6">
            <button aria-label="Open menu" className="rounded-md p-1 text-muted-foreground hover:text-foreground lg:hidden" onClick={() => setMobileOpen(true)}>
              <Menu className="size-5" />
            </button>
            <div className="flex items-center gap-2 text-sm">
              <span className="hidden text-muted-foreground sm:inline">Project</span>
              <select
                aria-label="Active project"
                className={cn(selectClass, "min-w-40")}
                value={projectId ?? ""}
                onChange={(e) => setProjectId(e.target.value || null)}
                disabled={projects.length === 0}
              >
                {projects.length === 0 ? <option value="">No projects yet</option> : null}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.isDemo ? " (demo data)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Link href="/ask" className="hidden items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 sm:inline-flex">
                <ScanSearch className="size-3.5" /> Ask ContextOS
              </Link>
            </div>
          </header>
          <main className="cos-grid flex-1 px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto w-full max-w-7xl">{children}</div>
          </main>
        </div>
      </div>
    </Ctx.Provider>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-1.5">
      <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/20">
        <BrainCircuit className="size-4.5" aria-hidden />
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold tracking-tight">ContextOS</div>
        <div className="text-[10px] text-muted-foreground">Decision-aware memory</div>
      </div>
    </Link>
  );
}

function SidebarFooter() {
  return (
    <div className="mt-4 rounded-lg border border-sidebar-border bg-background/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
      Proposal → Decision → Implementation → Verification. AI extracts; deterministic rules decide.
    </div>
  );
}
