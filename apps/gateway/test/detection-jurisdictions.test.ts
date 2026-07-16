import { SUPPORTED_DETECTION_JURISDICTIONS } from "@serovaai/ficta-protocol";
import { describe, expect, it } from "vitest";
import { JURISDICTION_LABELS, jurisdictionLabel } from "../src/lib/detection-jurisdictions";

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
});
