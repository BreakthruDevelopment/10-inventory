/** 56px (h-14) actions for the phone-first scan screen. Not the shared 44px button. */
export const scanAction =
  "inline-flex h-14 min-h-14 w-full touch-manipulation items-center justify-center gap-2 rounded-card px-4 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60";

export const scanPrimary = `${scanAction} bg-accent text-accent-foreground hover:opacity-90`;

export const scanSecondary = `${scanAction} border border-border bg-surface text-foreground hover:bg-accent-soft`;

export const stepButton =
  "inline-flex h-14 w-14 shrink-0 touch-manipulation items-center justify-center rounded-card border border-border bg-surface text-2xl font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-60";
