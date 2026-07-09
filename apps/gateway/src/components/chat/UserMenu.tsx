import { useQuery } from "@tanstack/react-query";
import { LogOut, Plus, RefreshCw, Settings, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { switchOrganization } from "@/lib/auth/auth";
import { organizationsQueryOptions } from "@/lib/auth/organizationQueries";
import type { AuthUser } from "@/lib/auth/types";

type MenuSide = React.ComponentProps<typeof DropdownMenuContent>["side"];
type MenuAlign = React.ComponentProps<typeof DropdownMenuContent>["align"];

/**
 * Account control shown in the sidebar footer. Hosted auth passes a real user and enables workspace and
 * sign-out actions; `none` mode passes a local user so settings/admin live in the same menu shape.
 *
 * When the user belongs to WorkOS organizations, a "Workspace" radio group lets them switch the active
 * one and create more. The list is warmed as soon as the account control mounts, so opening the menu
 * usually reads from cache instead of waiting on the first WorkOS membership round trip.
 * Admin settings are included when the caller provides an admin opener, keeping
 * workspace-level controls in the account popover instead of the chat navigation.
 *
 * `variant` picks the trigger: `row` is the full-width label used in the expanded sidebar footer; `icon`
 * is the avatar-only button used in the collapsed rail. `side`/`align` position the menu relative to the
 * trigger — the footer opens it upward.
 */
export function UserMenu({
  user,
  description,
  variant = "icon",
  side = "top",
  align = "start",
  onOpenAdmin,
  onOpenSettings,
  onCreateWorkspace,
  showWorkspaces = true,
  showSignOut = true,
}: {
  user: AuthUser;
  description?: string;
  variant?: "row" | "icon";
  side?: MenuSide;
  align?: MenuAlign;
  onOpenAdmin?: () => void;
  onOpenSettings: () => void;
  onCreateWorkspace: () => void;
  showWorkspaces?: boolean;
  showSignOut?: boolean;
}) {
  const label = user.name ?? user.email;
  const secondaryLabel = description ?? user.email;
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  const organizationsQuery = useQuery({ ...organizationsQueryOptions, enabled: showWorkspaces });
  const orgs = showWorkspaces ? (organizationsQuery.data ?? []) : [];
  const activeOrg =
    showWorkspaces && user.organizationId ? orgs.find((org) => org.id === user.organizationId) : undefined;
  const workspaceLabel =
    showWorkspaces && user.organizationId && organizationsQuery.isPending ? "Loading workspace..." : activeOrg?.name;

  const handleSwitch = async (organizationId: string) => {
    if (organizationId === user.organizationId) return;
    await switchOrganization({ data: { organizationId } });
    // The active thread and settings belong to the old workspace, so re-derive everything from a clean load.
    window.location.assign("/");
  };

  const avatar = user.avatarUrl ? (
    <img src={user.avatarUrl} alt="" className="size-6 shrink-0 rounded-full object-cover" />
  ) : (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
      {initial}
    </span>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "row" ? (
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
            aria-label="Account"
          >
            {avatar}
            <span className="flex min-w-0 flex-col items-start leading-tight">
              <span className="max-w-full truncate text-sm font-medium">{label}</span>
              {workspaceLabel ? (
                <span className="max-w-full truncate text-xs font-normal text-muted-foreground">{workspaceLabel}</span>
              ) : description ? (
                <span className="max-w-full truncate text-xs font-normal text-muted-foreground">{description}</span>
              ) : null}
            </span>
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account">
            {avatar}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className="min-w-52">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          {user.name ? <span className="truncate font-medium">{user.name}</span> : null}
          <span className="truncate text-xs font-normal text-muted-foreground">{secondaryLabel}</span>
          {workspaceLabel ? (
            <span className="truncate text-xs font-normal text-muted-foreground">{workspaceLabel}</span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {showWorkspaces && organizationsQuery.isPending ? (
          <>
            <DropdownMenuItem disabled>Loading workspaces…</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : showWorkspaces && organizationsQuery.isError ? (
          <>
            <DropdownMenuItem disabled>Could not load workspaces</DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                void organizationsQuery.refetch();
              }}
            >
              <RefreshCw className="size-4" aria-hidden />
              Retry
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : showWorkspaces && orgs.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Workspace</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={user.organizationId} onValueChange={handleSwitch}>
              {orgs.map((org) => (
                <DropdownMenuRadioItem key={org.id} value={org.id}>
                  <span className="truncate">{org.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuItem onSelect={onCreateWorkspace}>
              <Plus className="size-4" aria-hidden />
              Create workspace…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {onOpenAdmin ? (
          <DropdownMenuItem onSelect={onOpenAdmin}>
            <Shield className="size-4" aria-hidden />
            Admin
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onOpenSettings}>
          <Settings className="size-4" aria-hidden />
          Settings
        </DropdownMenuItem>
        {showSignOut ? (
          <DropdownMenuItem variant="destructive" onSelect={() => window.location.assign("/api/auth/sign-out")}>
            <LogOut className="size-4" aria-hidden />
            Sign out
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
