import { describe, expect, it } from "vitest";
import { restorePrivacyToggleLabels } from "@/components/chat/TopBar";

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
