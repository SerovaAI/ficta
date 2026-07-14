import { describe, expect, it } from "vitest";
import { type EntityFidelityGateInput, evaluateEntityFidelityGate } from "../bench/entity-surrogate-fidelity-gate.js";

const PASSING_RESULT: EntityFidelityGateInput = {
  provider: "openai",
  model: "test-model",
  style: "entity-family",
  transport: "stream",
  run: 1,
  parsed: true,
  scores: {
    exactPartyFields: 1,
    entityAttribution: 1,
    legalFacts: 1,
    tokenPreservationRecall: 1,
    tokenMutationCount: 0,
    residualTokenCountAfterRestore: 0,
  },
};

describe("entity fidelity release gate", () => {
  it("passes only when every expected result has perfect fidelity scores", () => {
    expect(evaluateEntityFidelityGate([PASSING_RESULT], 1)).toEqual({
      passed: true,
      expectedResults: 1,
      evaluatedResults: 1,
      failures: [],
    });
  });

  it.each([
    ["unparsed output", { parsed: false }],
    ["imperfect party fields", { scores: { ...PASSING_RESULT.scores, exactPartyFields: 0.75 } }],
    ["mutated tokens", { scores: { ...PASSING_RESULT.scores, tokenMutationCount: 1 } }],
    ["provider errors", { error: "rate limited", parsed: undefined, scores: undefined }],
  ])("fails on %s", (_label, changes) => {
    const result = { ...PASSING_RESULT, ...changes } as EntityFidelityGateInput;
    expect(evaluateEntityFidelityGate([result], 1).passed).toBe(false);
  });

  it("fails when the matrix returns fewer rows than configured", () => {
    expect(evaluateEntityFidelityGate([PASSING_RESULT], 2).failures[0]?.reasons).toEqual([
      "expected 2 result(s), received 1",
    ]);
  });
});
