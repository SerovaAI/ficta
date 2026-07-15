import type * as React from "react";

/**
 * One labeled setting: a title + description on the left, the control on the right (stacking on narrow
 * screens). Shared by the user and admin forms so settings read consistently.
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="@container border-b border-border py-4">
      <div className="flex flex-col gap-3 @lg:grid @lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] @lg:items-start @lg:gap-6">
        <div className="min-w-0 space-y-1">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="text-sm font-medium">
              {label}
            </label>
          ) : (
            <div className="text-sm font-medium">{label}</div>
          )}
          {description ? <p className="max-w-64 text-xs text-muted-foreground leading-relaxed">{description}</p> : null}
        </div>
        <div className="min-w-0 @lg:pt-0.5">{children}</div>
      </div>
    </div>
  );
}
