import { describe, expect, it } from "vitest";
import { restorePrivacyToggleLabels, threadTraceToggleLabels } from "@/components/chat/TopBar";

describe("restore privacy toggle labels", () => {
  it("describes the next action from values mode", () => {
    expect(restorePrivacyToggleLabels("values")).toEqual({
      ariaLabel: "Show protected tokens",
      tooltip: "Show protected tokens",
      menuLabel: "Show protected tokens",
    });
  });

  it("describes the next action from surrogate mode", () => {
    expect(restorePrivacyToggleLabels("surrogates")).toEqual({
      ariaLabel: "Show original values",
      tooltip: "Show original values",
      menuLabel: "Show original values",
    });
  });
});

describe("thread trace toggle labels", () => {
  it("explains unavailable capture when global trace is off", () => {
    expect(threadTraceToggleLabels({ enabled: false, disabled: true })).toEqual({
      ariaLabel: "Trace capture unavailable",
      tooltip: "Trace capture: Disabled by your server administrator · Click to open admin settings",
    });
  });

  it("describes thread-scoped raw body capture", () => {
    expect(threadTraceToggleLabels({ enabled: false, disabled: false })).toEqual({
      ariaLabel: "Start trace capture for this chat",
      tooltip: "Trace capture: Off for this chat · Click to start",
    });
    expect(threadTraceToggleLabels({ enabled: true, disabled: false })).toEqual({
      ariaLabel: "Stop trace capture for this chat",
      tooltip: "Trace capture: On for this chat · Click to stop",
    });
  });

  it("distinguishes loading and failed updates", () => {
    expect(threadTraceToggleLabels({ enabled: false, disabled: true, loading: true })).toEqual({
      ariaLabel: "Checking trace capture availability",
      tooltip: "Trace capture: Checking availability…",
    });
    expect(threadTraceToggleLabels({ enabled: false, disabled: false, error: true })).toEqual({
      ariaLabel: "Retry changing trace capture",
      tooltip: "Trace capture setting wasn't saved · Click to try again",
    });
  });
});
