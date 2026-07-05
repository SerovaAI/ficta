import type { ProtectedValue } from "../types.js";
import {
  checkPresidioCompatibleAnalyzerHealth,
  detectWithPresidioCompatibleAnalyzer,
  type PresidioConfig,
  presidioConfig,
} from "./presidio-recognizer.js";
import type { PiiRecognizer } from "./recognizer.js";

const DEFAULT_MEDICAL_URL = "http://127.0.0.1:5003";

export function medicalConfig(env: NodeJS.ProcessEnv = process.env): PresidioConfig {
  return presidioConfig({
    ...env,
    FICTA_PII_PRESIDIO_URL: env.FICTA_PII_MEDICAL_URL?.trim() || DEFAULT_MEDICAL_URL,
    FICTA_PII_PRESIDIO_LANGUAGE: env.FICTA_PII_MEDICAL_LANGUAGE?.trim() || env.FICTA_PII_PRESIDIO_LANGUAGE,
    FICTA_PII_PRESIDIO_SCORE_THRESHOLD: env.FICTA_PII_MEDICAL_SCORE_THRESHOLD ?? env.FICTA_PII_PRESIDIO_SCORE_THRESHOLD,
    FICTA_PII_PRESIDIO_ENTITIES: env.FICTA_PII_MEDICAL_ENTITIES ?? env.FICTA_PII_PRESIDIO_ENTITIES,
    FICTA_PII_PRESIDIO_TIMEOUT_MS: env.FICTA_PII_MEDICAL_TIMEOUT_MS ?? env.FICTA_PII_PRESIDIO_TIMEOUT_MS,
  });
}

export const medicalRecognizer: PiiRecognizer = {
  name: "medical",
  async detect(text, ctx) {
    const values = await detectWithPresidioCompatibleAnalyzer(text, ctx, medicalConfig(), "medical");
    return values.map((value): ProtectedValue => ({ ...value, source: "pii-medical" }));
  },
};

/** GET /health for `ficta doctor`. Never throws — returns a safe reachability verdict. */
export async function checkMedicalHealth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; url: string; detail?: string }> {
  return checkPresidioCompatibleAnalyzerHealth(medicalConfig(env));
}
