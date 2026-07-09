import { describe, expect, it } from "vitest";
import { restorePrivacyToggleLabels, threadTraceToggleLabels } from "@/components/chat/TopBar";

describe("restore privacy toggle labels", () => {
  it("describes the next action from values mode", () => {
    expect(restorePrivacyToggleLabels("values")).toEqual({
      ariaLabel: "Show surrogates",
      tooltip: "Show surrogates",
    });
  });

  it("describes the next action from surrogate mode", () => {
    expect(restorePrivacyToggleLabels("surrogates")).toEqual({
      ariaLabel: "Show restored values",
      tooltip: "Show restored values",
    });
  });
});

describe("thread trace toggle labels", () => {
  it("explains unavailable capture when global trace is off", () => {
    expect(threadTraceToggleLabels({ enabled: false, disabled: true, auditEnabled: false })).toEqual({
      ariaLabel: "Thread trace capture unavailable",
      tooltip: "Enable FICTA_LOG_LEVEL=trace on the proxy to trace selected threads",
    });
  });

  it("describes thread-scoped raw body capture", () => {
    expect(threadTraceToggleLabels({ enabled: false, disabled: false, auditEnabled: false })).toEqual({
      ariaLabel: "Enable thread trace capture",
      tooltip: "Raw body trace is off for this thread",
    });
    expect(threadTraceToggleLabels({ enabled: true, disabled: false, auditEnabled: true })).toEqual({
      ariaLabel: "Disable thread trace capture",
      tooltip: "Trace and audit capture is on for this thread",
    });
  });
});
