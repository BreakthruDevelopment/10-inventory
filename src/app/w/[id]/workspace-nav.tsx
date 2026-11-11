"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const linkClass = (active: boolean) =>
  `inline-flex min-h-11 items-center rounded-card border px-3 text-sm font-semibold ${
    active ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-foreground hover:bg-accent-soft"
  }`;

/** In-page links for one workspace. Forecast and team stay off the bar for staff; the pages still check the role. */
export function WorkspaceNav({ id, manager }: { id: string; manager: boolean }) {
  const pathname = usePathname();
  const links = [
    { href: `/w/${id}`, label: "Dashboard", exact: true },
    { href: `/w/${id}/scan`, label: "Scan", exact: false },
    { href: `/w/${id}/items`, label: "Items", exact: false },
    ...(manager
      ? [
          { href: `/w/${id}/forecast`, label: "Forecast", exact: false },
          { href: `/w/${id}/team`, label: "Team", exact: false },
        ]
      : []),
  ];
  return (
    <nav aria-label="Workspace" className="mb-6 flex flex-wrap gap-2">
      {links.map((link) => {
        const active = link.exact ? pathname === link.href : pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined} className={linkClass(active)}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
