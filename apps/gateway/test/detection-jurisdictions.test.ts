import { SUPPORTED_DETECTION_JURISDICTIONS } from "@serovaai/ficta-protocol";
import { describe, expect, it } from "vitest";
import {
  detectionJurisdictionSummary,
  detectionJurisdictionToggleLabel,
  JURISDICTION_LABELS,
  jurisdictionLabel,
  toggleDetectionJurisdiction,
} from "../src/lib/detection-jurisdictions";

describe("detection jurisdiction labels", () => {
  it("has a human label for every protocol-supported jurisdiction", () => {
    // The picker falls back to an uppercased code, so a missing label degrades silently in the UI;
    // this is the only sync gate for the label half of the jurisdiction vocabulary.
    for (const code of SUPPORTED_DETECTION_JURISDICTIONS) {
      expect(JURISDICTION_LABELS[code], `missing display label for jurisdiction "${code}"`).toBeTruthy();
    }
  });

  it("labels no codes outside the protocol vocabulary", () => {
    expect(Object.keys(JURISDICTION_LABELS).sort()).toEqual([...SUPPORTED_DETECTION_JURISDICTIONS].sort());
  });

  it("falls back to the uppercased code for unknown values", () => {
    expect(jurisdictionLabel("xx")).toBe("XX");
  });

  it("toggles selections in protocol display order", () => {
    expect(toggleDetectionJurisdiction([], "uk")).toEqual(["uk"]);
    expect(toggleDetectionJurisdiction(["uk", "us"], "za")).toEqual(["za", "uk", "us"]);
    expect(toggleDetectionJurisdiction(["za", "uk", "us"], "uk")).toEqual(["za", "us"]);
  });

  it("summarizes baseline and additional selections", () => {
    expect(detectionJurisdictionSummary([])).toBe("Baseline only");
    expect(detectionJurisdictionSummary(["uk"])).toBe("1 additional jurisdiction");
    expect(detectionJurisdictionSummary(["za", "uk", "us"])).toBe("3 additional jurisdictions");
  });

  it("describes the panel trigger action and selection count", () => {
    expect(detectionJurisdictionToggleLabel(0, "open")).toBe("Open jurisdiction detection, baseline only");
    expect(detectionJurisdictionToggleLabel(1, "close")).toBe(
      "Close jurisdiction detection, 1 additional jurisdiction",
    );
    expect(detectionJurisdictionToggleLabel(3, "open")).toBe("Open jurisdiction detection, 3 additional jurisdictions");
  });
});
