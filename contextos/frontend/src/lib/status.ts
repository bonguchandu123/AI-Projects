import {
  Ban, CheckCircle2, CircleDashed, CircleDot, Clock, GitBranch, Lightbulb, type LucideIcon, Archive,
  ShieldAlert, Undo2, XCircle, Hammer, Repeat, PauseCircle, Flag, ListChecks,
} from "lucide-react";

export interface StatusMeta {
  label: string;
  /** Tailwind classes for pill background/text/border */
  tone: string;
  /** Solid dot / marker color */
  dot: string;
  icon: LucideIcon;
}

const T = {
  sky: { tone: "bg-sky-500/10 text-sky-300 border-sky-500/25", dot: "bg-sky-400" },
  violet: { tone: "bg-violet-500/10 text-violet-300 border-violet-500/25", dot: "bg-violet-400" },
  emerald: { tone: "bg-emerald-500/10 text-emerald-300 border-emerald-500/25", dot: "bg-emerald-400" },
  amber: { tone: "bg-amber-500/10 text-amber-300 border-amber-500/25", dot: "bg-amber-400" },
  rose: { tone: "bg-rose-500/10 text-rose-300 border-rose-500/25", dot: "bg-rose-400" },
  orange: { tone: "bg-orange-500/10 text-orange-300 border-orange-500/25", dot: "bg-orange-400" },
  slate: { tone: "bg-slate-500/10 text-slate-300 border-slate-500/25", dot: "bg-slate-400" },
  zinc: { tone: "bg-zinc-500/10 text-zinc-400 border-zinc-500/25", dot: "bg-zinc-500" },
};

export const STATUS: Record<string, StatusMeta> = {
  // commitment axis
  NONE: { label: "No decision", ...T.zinc, icon: CircleDashed },
  PROPOSED: { label: "Proposed", ...T.sky, icon: Lightbulb },
  DECIDED: { label: "Decided", ...T.violet, icon: Flag },
  REJECTED: { label: "Rejected", ...T.rose, icon: XCircle },
  CANCELLED: { label: "Cancelled", ...T.zinc, icon: Ban },
  REVERSED: { label: "Reversed", ...T.orange, icon: Undo2 },
  SUPERSEDED: { label: "Superseded", ...T.slate, icon: GitBranch },
  // implementation axis
  NOT_STARTED: { label: "Not started", ...T.zinc, icon: PauseCircle },
  CLAIMED_IMPLEMENTED: { label: "Claimed · unverified", ...T.amber, icon: Hammer },
  VERIFIED: { label: "Verified", ...T.emerald, icon: CheckCircle2 },
  RETIRED: { label: "Retired", ...T.slate, icon: Archive },
  // events
  IMPLEMENTATION_CLAIMED: { label: "Implementation claimed", ...T.amber, icon: Hammer },
  CORROBORATED: { label: "Corroborated", ...T.zinc, icon: Repeat },
  CONFLICT_FLAGGED: { label: "Conflict flagged", ...T.rose, icon: ShieldAlert },
  HELD_FOR_REVIEW: { label: "Held for review", ...T.orange, icon: Clock },
  COMMITMENT_OPENED: { label: "Commitment opened", ...T.sky, icon: ListChecks },
  COMMITMENT_DONE: { label: "Commitment done", ...T.emerald, icon: CheckCircle2 },
  COMMITMENT_CANCELLED: { label: "Commitment cancelled", ...T.zinc, icon: Ban },
  // commitments
  OPEN: { label: "Open", ...T.sky, icon: CircleDot },
  DONE: { label: "Done", ...T.emerald, icon: CheckCircle2 },
  OVERDUE: { label: "Overdue", ...T.rose, icon: Clock },
  // subject status
  UNVERIFIED: { label: "Unverified", ...T.amber, icon: Hammer },
  DECIDED_NOT_IMPLEMENTED: { label: "Decided · not implemented", ...T.violet, icon: Flag },
  UNDECIDED: { label: "Undecided", ...T.sky, icon: Lightbulb },
  DISPUTED: { label: "Disputed", ...T.rose, icon: ShieldAlert },
  // reviews
  conflict: { label: "Conflict", ...T.rose, icon: ShieldAlert },
  ambiguous: { label: "Ambiguous", ...T.orange, icon: Clock },
  missing_decision: { label: "Missing decision", ...T.amber, icon: Flag },
  unverified_excerpt: { label: "Unverifiable excerpt", ...T.rose, icon: ShieldAlert },
  reopened: { label: "Reopened", ...T.orange, icon: Repeat },
  open: { label: "Open", ...T.orange, icon: Clock },
  confirmed: { label: "Confirmed", ...T.emerald, icon: CheckCircle2 },
  dismissed: { label: "Dismissed", ...T.zinc, icon: XCircle },
};

export function statusMeta(key: string): StatusMeta {
  return STATUS[key] ?? { label: key.replace(/_/g, " ").toLowerCase(), ...T.zinc, icon: CircleDot };
}

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
export const fmtShort = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "—";
export const fmtMonth = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
