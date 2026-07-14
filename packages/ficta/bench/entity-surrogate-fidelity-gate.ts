export interface EntityFidelityScores {
  exactPartyFields: number;
  entityAttribution: number;
  legalFacts: number;
  tokenPreservationRecall: number;
  tokenMutationCount: number;
  residualTokenCountAfterRestore: number;
}

export interface EntityFidelityGateInput {
  provider: string;
  model: string;
  style: string;
  transport: string;
  run: number;
  error?: string;
  parsed?: boolean;
  scores?: EntityFidelityScores;
}

export interface EntityFidelityGateFailure {
  provider?: string;
  model?: string;
  style?: string;
  transport?: string;
  run?: number;
  reasons: string[];
}

export interface EntityFidelityGate {
  passed: boolean;
  expectedResults: number;
  evaluatedResults: number;
  failures: EntityFidelityGateFailure[];
}

const PERFECT_SCORES = [
  "exactPartyFields",
  "entityAttribution",
  "legalFacts",
  "tokenPreservationRecall",
] as const satisfies readonly (keyof EntityFidelityScores)[];

const ZERO_SCORES = [
  "tokenMutationCount",
  "residualTokenCountAfterRestore",
] as const satisfies readonly (keyof EntityFidelityScores)[];

/** Apply the strict release gate to provider results. No failure is averaged away across runs. */
export function evaluateEntityFidelityGate(
  results: readonly EntityFidelityGateInput[],
  expectedResults: number = results.length,
): EntityFidelityGate {
  const failures: EntityFidelityGateFailure[] = [];
  if (results.length !== expectedResults) {
    failures.push({ reasons: [`expected ${expectedResults} result(s), received ${results.length}`] });
  }

  for (const result of results) {
    const reasons: string[] = [];
    if (result.error) {
      reasons.push(`provider error: ${result.error}`);
    } else {
      if (result.parsed !== true) reasons.push("response was not valid result JSON");
      for (const score of PERFECT_SCORES) {
        if (result.scores?.[score] !== 1) reasons.push(`${score} must equal 1`);
      }
      for (const score of ZERO_SCORES) {
        if (result.scores?.[score] !== 0) reasons.push(`${score} must equal 0`);
      }
    }
    if (reasons.length === 0) continue;
    failures.push({
      provider: result.provider,
      model: result.model,
      style: result.style,
      transport: result.transport,
      run: result.run,
      reasons,
    });
  }

  return {
    passed: failures.length === 0,
    expectedResults,
    evaluatedResults: results.length,
    failures,
  };
}
