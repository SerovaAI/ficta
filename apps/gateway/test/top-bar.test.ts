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
      ariaLabel: "Trace disabled; open administrator settings",
      label: "Trace disabled",
      tooltip: "Runtime trace capture is disabled · Click to open admin settings",
    });
  });

  it("describes thread-scoped raw body capture", () => {
    expect(threadTraceToggleLabels({ enabled: false, disabled: false })).toEqual({
      ariaLabel: "Start trace capture for this chat",
      label: "Trace ready",
      tooltip: "Runtime capture is available, but this chat is not opted in · Click to start",
    });
    expect(threadTraceToggleLabels({ enabled: true, disabled: false })).toEqual({
      ariaLabel: "Stop trace capture for this chat",
      label: "Tracing bodies",
      tooltip: "This chat is capturing raw bodies · Click to stop",
    });
    expect(threadTraceToggleLabels({ enabled: true, disabled: false, valueAudit: true })).toEqual({
      ariaLabel: "Stop trace capture for this chat",
      label: "Tracing bodies + values",
      tooltip: "This chat is capturing raw bodies and protected values · Click to stop",
    });
  });

  it("distinguishes loading and failed updates", () => {
    expect(threadTraceToggleLabels({ enabled: false, disabled: true, loading: true })).toEqual({
      ariaLabel: "Checking trace capture availability",
      label: "Checking trace",
      tooltip: "Trace capture: Checking availability…",
    });
    expect(threadTraceToggleLabels({ enabled: false, disabled: false, error: true })).toEqual({
      ariaLabel: "Retry changing trace capture",
      label: "Trace error",
      tooltip: "Trace capture setting wasn't saved · Click to try again",
    });
  });
});
