import type { ReactNode } from "react";

export type PrimaryRoute = "search" | "activity" | "profile";

export interface NavigationRoute {
	id: PrimaryRoute;
	href: string;
	label: string;
}

export interface ApplicationShellProps {
  activeRoute: PrimaryRoute;
  children: ReactNode;
  eReader?: boolean;
  navigationRoutes?: NavigationRoute[];
  profileName?: string;
}

const defaultRoutes: NavigationRoute[] = [
  { id: "search", href: "/search", label: "Search" },
  { id: "activity", href: "/activity", label: "Activity" },
  { id: "profile", href: "/profile", label: "Profile" },
];

export function ApplicationShell({
  activeRoute,
  children,
  eReader = false,
  navigationRoutes = defaultRoutes,
  profileName = "Member 2",
}: ApplicationShellProps) {
  return (
    <div className={eReader ? "app-shell app-shell--ereader" : "app-shell"}>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <a className="wordmark" href="/search" aria-label="k home">k</a>
        <span className="profile-name">{profileName}</span>
      </header>
      <nav className="primary-nav" aria-label="Primary">
        <ul>
          {navigationRoutes.map((route) => (
            <li key={route.id}>
              <a href={route.href} aria-current={route.id === activeRoute ? "page" : undefined}>
                {route.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="page-content">{children}</main>
    </div>
  );
}