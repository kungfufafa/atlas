import { ArrowLeft01Icon, ArrowRight01Icon, Menu01Icon } from "hugeicons-react";
import type { ElementType } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useSearchParams } from "react-router-dom";
import { CommandPalette } from "@/components/CommandPalette";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { ProfileRail } from "@/components/ProfileRail";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ActiveChatProfileProvider } from "@/context/active-chat-profile-context";
import { useAppContext } from "@/context/use-app-context";
import { useAuth } from "@/context/use-auth";
import { usePrefetchAppData } from "@/hooks/use-app-queries";
import { useAutomationUnreadTotal } from "@/hooks/use-automations";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { chatProfileIdFromPath } from "@/lib/chat-history";
import {
  findNavItem,
  type NavItem,
  navHrefForPage,
  PAGE_PATHS,
  pageIdFromPath,
  visibleNavGroups,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { AgentWorkTabs } from "@/pages/automations/agent-work-tabs";
import { ProfileDetailTabButton } from "@/pages/profiles/profiles-ui";

export function Layout() {
  const location = useLocation();
  const page = pageIdFromPath(location.pathname) ?? "chat";
  const chatProfileId = chatProfileIdFromPath(location.pathname);
  const { error } = useAppContext();
  const { user, activeOrg } = useAuth();
  const prefetchAppData = usePrefetchAppData();
  const { data: automationUnreadTotal = 0 } = useAutomationUnreadTotal();
  const { collapsed, toggle } = useSidebarCollapsed();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isDesktop = useMinWidthMediaQuery(640);
  const activeNav = findNavItem(page);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileNavOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileNavOpen]);

  const navGroups = useMemo(
    () =>
      visibleNavGroups({
        isPlatformAdmin: user?.isPlatformAdmin === true,
        orgRole: activeOrg?.role,
      }),
    [activeOrg?.role, user?.isPlatformAdmin]
  );

  return (
    <TooltipProvider delay={0}>
      <ActiveChatProfileProvider>
        <div className="flex h-svh overflow-hidden bg-background">
          <div className="hidden h-full sm:flex">
            <ProfileRail />
          </div>

          {mobileNavOpen ? (
            <button
              aria-label="Close navigation"
              className="fixed inset-0 z-40 bg-black/40 sm:hidden"
              onClick={() => setMobileNavOpen(false)}
              type="button"
            />
          ) : null}

          <aside
            aria-label="Main navigation"
            className={cn(
              "sidebar-shell fixed inset-y-0 left-0 z-50 flex h-full shrink-0 flex-col overflow-hidden border-border/50 border-r transition-transform duration-200",
              mobileNavOpen ? "translate-x-0" : "-translate-x-full",
              "sm:static sm:translate-x-0 sm:transform-none sm:transition-none",
              "motion-reduce:transition-none"
            )}
            data-collapsed={collapsed && isDesktop ? true : undefined}
          >
            <div className="app-shell-header">
              {collapsed && isDesktop ? (
                <CollapsedOrgExpandControl onExpand={toggle} />
              ) : (
                <>
                  <div className="flex min-w-0 flex-1">
                    <OrgSwitcher collapsed={false} />
                  </div>
                  <SidebarCollapseButton
                    className="max-sm:hidden"
                    onToggle={toggle}
                  />
                </>
              )}
            </div>

            <nav className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
              {navGroups.map((group) => (
                <div
                  aria-label={group.label}
                  className="sidebar-nav-group"
                  key={group.id}
                  role="group"
                >
                  <div className="sidebar-nav-group-items">
                    {group.items.map((item) => (
                      <SidebarNavButton
                        active={item.id === page}
                        badge={
                          item.id === "automations"
                            ? automationUnreadTotal
                            : undefined
                        }
                        collapsed={collapsed}
                        icon={item.icon}
                        item={item}
                        key={item.id}
                        onPrefetch={
                          item.id === "automations"
                            ? prefetchAppData
                            : undefined
                        }
                        to={
                          item.id === "soul"
                            ? `${navHrefForPage(item.id, chatProfileId)}?tab=tools`
                            : navHrefForPage(item.id, chatProfileId)
                        }
                      />
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {page === "chat" ? (
              <div className="app-shell-header gap-1 bg-card px-3 sm:hidden">
                <Button
                  aria-expanded={mobileNavOpen}
                  aria-label="Open navigation"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setMobileNavOpen(true)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Menu01Icon className="size-4" strokeWidth={1.75} />
                </Button>
                <h1 className="type-brand min-w-0 flex-1 truncate">Chat</h1>
              </div>
            ) : (
              <header className="app-shell-header h-auto min-h-14 flex-wrap content-center gap-2 bg-card px-3 sm:h-14 sm:flex-nowrap sm:gap-4 sm:px-6">
                <Button
                  aria-expanded={mobileNavOpen}
                  aria-label="Open navigation"
                  className="text-muted-foreground hover:text-foreground sm:hidden"
                  onClick={() => setMobileNavOpen(true)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Menu01Icon className="size-4" strokeWidth={1.75} />
                </Button>
                {page === "soul" || page === "profiles" ? (
                  <h1 className="type-brand min-w-0 truncate sm:hidden">
                    {activeNav?.label}
                  </h1>
                ) : (
                  <h1 className="type-brand min-w-0 truncate">
                    {activeNav?.label}
                  </h1>
                )}
                <div
                  className="flex w-full shrink-0 items-stretch justify-start gap-2 sm:order-none sm:ml-auto sm:h-full sm:w-auto"
                  data-page-header-actions
                >
                  {page === "automations" ? (
                    <AgentWorkTabs />
                  ) : page === "files" ? (
                    <FilesViewTabs />
                  ) : null}
                </div>
              </header>
            )}

            {error ? (
              <div className="shrink-0 border-red-200 border-b bg-red-50 px-6 py-3 text-red-800 text-sm dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200">
                {error}
              </div>
            ) : null}

            <main
              className={cn(
                "min-h-0 flex-1",
                page === "chat" ||
                  page === "tasks" ||
                  page === "automations" ||
                  page === "files" ||
                  location.pathname.startsWith(`${PAGE_PATHS.soul}/playground/`)
                  ? "flex flex-col overflow-hidden"
                  : "overflow-y-auto",
                !location.pathname.startsWith(
                  `${PAGE_PATHS.profiles}/skills/`
                ) &&
                  page !== "chat" &&
                  page !== "tasks" &&
                  page !== "automations" &&
                  page !== "files" &&
                  !location.pathname.startsWith(
                    `${PAGE_PATHS.soul}/playground/`
                  )
                  ? "p-4 sm:p-6"
                  : null
              )}
            >
              <Outlet />
            </main>
          </div>
        </div>

        <CommandPalette />
      </ActiveChatProfileProvider>
    </TooltipProvider>
  );
}

function useMinWidthMediaQuery(minWidthPx: number): boolean {
  const [matches, setMatches] = useState(
    () =>
      typeof window === "undefined" ||
      window.matchMedia(`(min-width: ${minWidthPx}px)`).matches
  );

  useEffect(() => {
    const media = window.matchMedia(`(min-width: ${minWidthPx}px)`);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [minWidthPx]);

  return matches;
}

function FilesViewTabs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view =
    searchParams.get("tab") === "knowledge" ? "knowledge" : "artifacts";

  function selectView(nextView: "artifacts" | "knowledge") {
    if (nextView === "artifacts") {
      searchParams.delete("tab");
    } else {
      searchParams.set("tab", nextView);
    }
    setSearchParams(searchParams);
  }

  return (
    <div
      aria-label="Files views"
      className="flex h-full min-w-0 items-stretch"
      role="tablist"
    >
      <ProfileDetailTabButton
        active={view === "artifacts"}
        controls="files-page-panel-artifacts"
        id="files-page-tab-artifacts"
        onSelect={() => selectView("artifacts")}
      >
        Artifacts
      </ProfileDetailTabButton>
      <ProfileDetailTabButton
        active={view === "knowledge"}
        controls="files-page-panel-knowledge"
        id="files-page-tab-knowledge"
        onSelect={() => selectView("knowledge")}
      >
        Knowledge base
      </ProfileDetailTabButton>
    </div>
  );
}

function CollapsedOrgExpandControl({ onExpand }: { onExpand: () => void }) {
  return (
    <div className="group relative flex size-9 shrink-0 items-center justify-center self-center">
      <div className="transition-opacity duration-150 group-focus-within:pointer-events-none group-focus-within:opacity-0 group-hover:pointer-events-none group-hover:opacity-0">
        <OrgSwitcher collapsed />
      </div>
      <Button
        aria-label="Expand sidebar"
        className="absolute inset-0 size-9 rounded-md p-0 text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-sidebar-accent/55 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        onClick={onExpand}
        title="Expand sidebar"
        type="button"
        variant="ghost"
      >
        <ArrowRight01Icon className="size-4" strokeWidth={1.75} />
      </Button>
    </div>
  );
}

function SidebarCollapseButton({
  className,
  onToggle,
}: {
  className?: string;
  onToggle: () => void;
}) {
  return (
    <Button
      aria-expanded
      aria-label="Collapse sidebar"
      className={cn(
        "shrink-0 self-center text-muted-foreground hover:text-foreground",
        className
      )}
      onClick={onToggle}
      size="icon-sm"
      title="Collapse sidebar"
      type="button"
      variant="ghost"
    >
      <ArrowLeft01Icon className="size-4" strokeWidth={1.75} />
    </Button>
  );
}

function SidebarNavButton({
  item,
  icon: Icon,
  active,
  collapsed,
  to,
  onPrefetch,
  badge,
  className,
}: {
  item: NavItem;
  icon: ElementType;
  active: boolean;
  collapsed: boolean;
  to: string;
  onPrefetch?: () => void;
  badge?: number;
  className?: string;
}) {
  const showBadge = Boolean(badge && badge > 0);
  const badgeLabel = badge && badge > 99 ? "99+" : String(badge ?? "");

  const link = (
    <Link
      aria-current={active ? "page" : undefined}
      aria-label={
        showBadge
          ? `${item.label}, ${badge} unread automation run${badge === 1 ? "" : "s"}`
          : item.label
      }
      className={cn(
        "sidebar-nav-link",
        collapsed && "sidebar-nav-link--collapsed",
        className
      )}
      data-active={active || undefined}
      onFocus={onPrefetch}
      onMouseEnter={onPrefetch}
      title={collapsed ? undefined : item.description}
      to={to}
    >
      <span className="relative shrink-0">
        <Icon
          aria-hidden="true"
          className="sidebar-nav-icon"
          strokeWidth={1.75}
        />
        {showBadge && collapsed ? (
          <span
            aria-hidden
            className="absolute top-0 right-0 inline-flex h-[18px] min-w-[18px] translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-sidebar bg-primary px-1.5 font-bold text-2xs text-primary-foreground tabular-nums leading-none shadow-sm"
          >
            {badgeLabel}
          </span>
        ) : null}
      </span>
      <span className="sidebar-nav-label truncate">{item.label}</span>
      {showBadge && !collapsed ? (
        <span
          aria-hidden
          className="sidebar-nav-label ml-auto inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 font-semibold text-2xs text-primary-foreground tabular-nums"
        >
          {badgeLabel}
        </span>
      ) : null}
    </Link>
  );

  if (!collapsed) {
    return link;
  }

  const tooltipLabel = showBadge
    ? `${item.label} (${badge} unread)`
    : item.label;

  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right" sideOffset={8}>
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  );
}
