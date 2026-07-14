import {
  characterizeRenderedFixture,
  entityIdForToken,
  loadEntityFidelityFixture,
  type RenderedFixture,
  renderEntityFidelityFixture,
  restoreText,
  type SurrogateStyle,
  surrogateLikeTokens,
  tokenForSurface,
} from "./entity-surrogate-fidelity-lib.js";

interface ProviderTarget {
  provider: "openai" | "anthropic";
  model: string;
}

type Transport = "buffered" | "stream" | "tool";

interface Options {
  styles: SurrogateStyle[];
  transports: Transport[];
  targets: ProviderTarget[];
  runs: number;
  help: boolean;
}

interface ProviderResult {
  response: string;
  fragmentCount: number;
}

interface ScoreResult {
  parsed: boolean;
  scores: {
    exactPartyFields: number;
    entityAttribution: number;
    legalFacts: number;
    tokenPreservationRecall: number;
    tokenMutationCount: number;
    residualTokenCountAfterRestore: number;
  };
  identityExact: Record<string, boolean>;
  entityAttribution: Record<string, boolean>;
  factExact: Record<string, boolean>;
  expectedTokenCount: number;
  exactListedTokenCount: number;
  unknownTokens: string[];
  response: string;
  restoredResponse: string;
}

interface LiveContext {
  provider: ProviderTarget["provider"];
  model: string;
  style: SurrogateStyle;
  transport: Transport;
  run: number;
}

type LiveResult = (LiveContext & { fragmentCount: number } & ScoreResult) | (LiveContext & { error: string });

interface ExpectedAnswer {
  client_token: string;
  counterparty_token: string;
  supplier_duty_token: string;
  notice_sender_token: string;
  damages_cap: string;
  cure_period: string;
  interest_rate: string;
  notice_date: string;
  arbitration_duration: string;
}

interface ModelAnswer extends Partial<ExpectedAnswer> {
  surrogate_tokens?: string[];
}

const REQUEST_TIMEOUT_MS = 60_000;
const TOOL_NAME = "report_entity_fidelity";
const options = parseOptions(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const fixture = await loadEntityFidelityFixture();
const rendered = options.styles.map((style) => renderEntityFidelityFixture(fixture, style));
const offline = rendered.map((item) => characterizeRenderedFixture(fixture, item));

const live: LiveResult[] = [];
for (const target of options.targets) {
  assertApiKey(target.provider);
  for (const item of rendered) {
    for (const transport of options.transports) {
      for (let run = 1; run <= options.runs; run += 1) {
        const context: LiveContext = {
          provider: target.provider,
          model: target.model,
          style: item.style,
          transport,
          run,
        };
        try {
          const { prompt, expected } = evaluationPrompt(item, transport);
          const result = await callProvider(target, prompt, transport);
          live.push({ ...context, fragmentCount: result.fragmentCount, ...scoreResponse(item, expected, result.response) });
        } catch (error) {
          live.push({ ...context, error: errorMessage(error) });
        }
      }
    }
  }
}

console.log(
  JSON.stringify(
    {
      phase: "0-characterization",
      fixture: fixture.name,
      mode: options.targets.length === 0 ? "offline" : "live",
      note: "Candidate entity-family rendering exists only in this benchmark. It is not wired into shipped engine behavior.",
      offline,
      live,
    },
    null,
    2,
  ),
);

function evaluationPrompt(
  renderedFixture: RenderedFixture,
  transport: Transport,
): { prompt: string; expected: ExpectedAnswer } {
  const facts = fixture.evaluation.facts;
  const expected: ExpectedAnswer = {
    client_token: tokenForSurface(renderedFixture, fixture.evaluation.clientSurface),
    counterparty_token: tokenForSurface(renderedFixture, fixture.evaluation.counterpartySurface),
    supplier_duty_token: tokenForSurface(renderedFixture, fixture.evaluation.supplierDutySurface),
    notice_sender_token: tokenForSurface(renderedFixture, fixture.evaluation.noticeSenderSurface),
    damages_cap: facts.damagesCap,
    cure_period: facts.curePeriod,
    interest_rate: facts.interestRate,
    notice_date: facts.noticeDate,
    arbitration_duration: facts.arbitrationDuration,
  };

  return {
    expected,
    prompt: [
      "Analyze the synthetic legal memo below.",
      "Every FICTA_ value is an opaque identifier. Copy each identifier character-for-character; never shorten, reformat, or invent one.",
      transport === "tool"
        ? `Call ${TOOL_NAME} exactly once with exactly these arguments:`
        : "Return JSON only with exactly these keys:",
      '{"client_token":"token beside Client","counterparty_token":"token beside Counterparty","supplier_duty_token":"token in the sentence assigning the cold-chain duty","notice_sender_token":"token that sent the breach notice","damages_cap":"exact amount","cure_period":"exact duration","interest_rate":"exact rate phrase","notice_date":"exact date","arbitration_duration":"exact duration","surrogate_tokens":["every distinct FICTA_ token in the memo"]}',
      transport === "tool" ? "Do not produce a narrative answer." : "Do not wrap the JSON in Markdown.",
      "",
      renderedFixture.text,
    ].join("\n"),
  };
}

function scoreResponse(renderedFixture: RenderedFixture, expected: ExpectedAnswer, response: string): ScoreResult {
  const answer = parseModelAnswer(response);
  const identityFields = ["client_token", "counterparty_token", "supplier_duty_token", "notice_sender_token"] as const;
  const factFields = ["damages_cap", "cure_period", "interest_rate", "notice_date", "arbitration_duration"] as const;
  const identityExact = Object.fromEntries(identityFields.map((field) => [field, answer?.[field] === expected[field]]));
  const entityAttribution = Object.fromEntries(
    identityFields.map((field) => [
      field,
      typeof answer?.[field] === "string" &&
        entityIdForToken(renderedFixture, answer[field]) === entityIdForToken(renderedFixture, expected[field]),
    ]),
  );
  const factExact = Object.fromEntries(
    factFields.map((field) => [field, normalized(answer?.[field]) === normalized(expected[field])]),
  );
  const expectedTokens = new Set(
    renderedFixture.mappings
      .filter((mapping) => renderedFixture.text.includes(mapping.token))
      .map((mapping) => mapping.token),
  );
  const listedTokens = Array.isArray(answer?.surrogate_tokens) ? answer.surrogate_tokens : [];
  const exactListedTokens = new Set(listedTokens.filter((token) => expectedTokens.has(token)));
  const unknownTokens = new Set(surrogateLikeTokens(response).filter((token) => !expectedTokens.has(token)));
  const restoredResponse = restoreText(response, renderedFixture.mappings);

  return {
    parsed: answer !== undefined,
    scores: {
      exactPartyFields: rate(Object.values(identityExact)),
      entityAttribution: rate(Object.values(entityAttribution)),
      legalFacts: rate(Object.values(factExact)),
      tokenPreservationRecall: expectedTokens.size === 0 ? 1 : exactListedTokens.size / expectedTokens.size,
      tokenMutationCount: unknownTokens.size,
      residualTokenCountAfterRestore: surrogateLikeTokens(restoredResponse).length,
    },
    identityExact,
    entityAttribution,
    factExact,
    expectedTokenCount: expectedTokens.size,
    exactListedTokenCount: exactListedTokens.size,
    unknownTokens: [...unknownTokens],
    response,
    restoredResponse,
  };
}

async function callProvider(target: ProviderTarget, prompt: string, transport: Transport): Promise<ProviderResult> {
  if (target.provider === "openai") return callOpenAi(target.model, prompt, transport);
  return callAnthropic(target.model, prompt, transport);
}

async function callOpenAi(model: string, prompt: string, transport: Transport): Promise<ProviderResult> {
  const url = "https://api.openai.com/v1/responses";
  const headers = { authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  const base = { model, input: prompt, max_output_tokens: 800, store: false };

  if (transport === "stream") {
    const events = await postSse(url, headers, { ...base, stream: true });
    const fragments = events.flatMap((event) =>
      isRecord(event) && event.type === "response.output_text.delta" && typeof event.delta === "string"
        ? [event.delta]
        : [],
    );
    if (fragments.length === 0) throw new Error("OpenAI stream contained no response.output_text.delta events");
    return { response: fragments.join(""), fragmentCount: fragments.length };
  }

  const response = await postJson(
    url,
    headers,
    transport === "tool"
      ? {
          ...base,
          tools: [openAiTool()],
          tool_choice: { type: "function", name: TOOL_NAME },
          parallel_tool_calls: false,
        }
      : base,
  );
  if (transport === "tool") {
    if (!isRecord(response) || !Array.isArray(response.output)) throw new Error("OpenAI response omitted output[]");
    const call = response.output.find(
      (item) => isRecord(item) && item.type === "function_call" && item.name === TOOL_NAME,
    );
    if (!isRecord(call) || typeof call.arguments !== "string") {
      throw new Error(`OpenAI response omitted ${TOOL_NAME} arguments`);
    }
    return { response: call.arguments, fragmentCount: 1 };
  }

  return { response: openAiOutputText(response), fragmentCount: 1 };
}

function openAiOutputText(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.output)) throw new Error("OpenAI response omitted output[]");
  const text: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        text.push(content.text);
      }
    }
  }
  if (text.length === 0) throw new Error("OpenAI response contained no output_text blocks");
  return text.join("");
}

async function callAnthropic(model: string, prompt: string, transport: Transport): Promise<ProviderResult> {
  const url = "https://api.anthropic.com/v1/messages";
  const headers = {
    "anthropic-version": "2023-06-01",
    "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
  };
  const base = { model, max_tokens: 800, messages: [{ role: "user", content: prompt }] };

  if (transport === "stream") {
    const events = await postSse(url, headers, { ...base, stream: true });
    const fragments = events.flatMap((event) => {
      if (!isRecord(event) || event.type !== "content_block_delta" || !isRecord(event.delta)) return [];
      return event.delta.type === "text_delta" && typeof event.delta.text === "string" ? [event.delta.text] : [];
    });
    if (fragments.length === 0) throw new Error("Anthropic stream contained no content_block_delta text events");
    return { response: fragments.join(""), fragmentCount: fragments.length };
  }

  const response = await postJson(
    url,
    headers,
    transport === "tool"
      ? {
          ...base,
          tools: [anthropicTool()],
          tool_choice: { type: "tool", name: TOOL_NAME, disable_parallel_tool_use: true },
        }
      : base,
  );
  if (transport === "tool") {
    if (!isRecord(response) || !Array.isArray(response.content))
      throw new Error("Anthropic response omitted content[]");
    const call = response.content.find(
      (block) => isRecord(block) && block.type === "tool_use" && block.name === TOOL_NAME,
    );
    if (!isRecord(call) || !isRecord(call.input)) throw new Error(`Anthropic response omitted ${TOOL_NAME} input`);
    return { response: JSON.stringify(call.input), fragmentCount: 1 };
  }

  return { response: anthropicOutputText(response), fragmentCount: 1 };
}

function anthropicOutputText(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.content)) throw new Error("Anthropic response omitted content[]");
  const text = response.content.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
  if (text.length === 0) throw new Error("Anthropic response contained no text blocks");
  return text.join("");
}

async function postJson(url: string, headers: Record<string, string>, body: object): Promise<unknown> {
  const text = await postText(url, headers, body);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Provider returned unreadable JSON: ${errorMessage(error)}`, { cause: error });
  }
}

async function postSse(url: string, headers: Record<string, string>, body: object): Promise<unknown[]> {
  return parseSse(await postText(url, headers, body));
}

async function postText(url: string, headers: Record<string, string>, body: object): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`Provider request failed: ${errorMessage(error)}`, { cause: error });
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Provider returned HTTP ${response.status}: ${detail}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseSse(stream: string): unknown[] {
  const events: unknown[] = [];
  for (const record of stream.replace(/\r\n/gu, "\n").split("\n\n")) {
    const data = record
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch (error) {
      throw new Error(`Provider returned unreadable SSE data: ${errorMessage(error)}`, { cause: error });
    }
  }
  return events;
}

function answerSchema(): object {
  const stringFields = [
    "client_token",
    "counterparty_token",
    "supplier_duty_token",
    "notice_sender_token",
    "damages_cap",
    "cure_period",
    "interest_rate",
    "notice_date",
    "arbitration_duration",
  ];
  return {
    type: "object",
    properties: {
      ...Object.fromEntries(stringFields.map((field) => [field, { type: "string" }])),
      surrogate_tokens: { type: "array", items: { type: "string" } },
    },
    required: [...stringFields, "surrogate_tokens"],
    additionalProperties: false,
  };
}

function openAiTool(): object {
  return {
    type: "function",
    name: TOOL_NAME,
    description: "Report the entity-surrogate legal fidelity answers.",
    parameters: answerSchema(),
    strict: true,
  };
}

function anthropicTool(): object {
  return {
    name: TOOL_NAME,
    description: "Report the entity-surrogate legal fidelity answers.",
    input_schema: answerSchema(),
  };
}

function parseModelAnswer(response: string): ModelAnswer | undefined {
  const start = response.indexOf("{");
  const end = response.lastIndexOf("}");
  if (start === -1 || end < start) return undefined;
  try {
    const parsed: unknown = JSON.parse(response.slice(start, end + 1));
    return isRecord(parsed) ? (parsed as ModelAnswer) : undefined;
  } catch {
    return undefined;
  }
}

function parseOptions(args: string[]): Options {
  const styles: SurrogateStyle[] = ["opaque", "typed", "entity-family"];
  const transports: Transport[] = ["buffered", "stream", "tool"];
  const targets: ProviderTarget[] = [];
  let selectedStyles = styles;
  let selectedTransports = transports;
  let runs = 1;
  let help = false;

  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg.startsWith("--openai-model=")) {
      targets.push({ provider: "openai", model: requiredValue(arg) });
      continue;
    }
    if (arg.startsWith("--anthropic-model=")) {
      targets.push({ provider: "anthropic", model: requiredValue(arg) });
      continue;
    }
    if (arg.startsWith("--styles=")) {
      const requested = requiredValue(arg).split(",");
      if (requested.some((style) => !styles.includes(style as SurrogateStyle))) {
        throw new Error(`--styles must contain only ${styles.join(", ")}`);
      }
      selectedStyles = [...new Set(requested)] as SurrogateStyle[];
      continue;
    }
    if (arg.startsWith("--transports=")) {
      const requested = requiredValue(arg).split(",");
      if (requested.some((transport) => !transports.includes(transport as Transport))) {
        throw new Error(`--transports must contain only ${transports.join(", ")}`);
      }
      selectedTransports = [...new Set(requested)] as Transport[];
      continue;
    }
    if (arg.startsWith("--runs=")) {
      runs = Number(requiredValue(arg));
      if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20)
        throw new Error("--runs must be an integer from 1 to 20");
      continue;
    }
    throw new Error(`Unknown argument ${arg}; run with --help`);
  }
  return { styles: selectedStyles, transports: selectedTransports, targets, runs, help };
}

function requiredValue(arg: string): string {
  const value = arg.slice(arg.indexOf("=") + 1).trim();
  if (!value) throw new Error(`${arg.slice(0, arg.indexOf("="))} requires a value`);
  return value;
}

function assertApiKey(provider: ProviderTarget["provider"]): void {
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("--openai-model requires OPENAI_API_KEY");
  }
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("--anthropic-model requires ANTHROPIC_API_KEY");
  }
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ").toLowerCase() : "";
}

function rate(values: boolean[]): number {
  return values.length === 0 ? 1 : values.filter(Boolean).length / values.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  console.log(`Entity-surrogate Phase 0 fidelity benchmark

Offline characterization (no network or API spend):
  pnpm --filter @serovaai/ficta bench:entity-fidelity

Opt in to one or both live providers by naming an exact model:
  OPENAI_API_KEY=... pnpm --filter @serovaai/ficta bench:entity-fidelity -- --openai-model=<model>
  ANTHROPIC_API_KEY=... pnpm --filter @serovaai/ficta bench:entity-fidelity -- --anthropic-model=<model>

Options:
  --styles=opaque,typed,entity-family  Compare a subset (default: all)
  --transports=buffered,stream,tool    Compare a subset (default: all)
  --runs=1                              Runs per provider/style, from 1 to 20 (default: 1)
  --help                               Show this help

No provider is contacted unless its --*-model flag is present. A default live run makes nine
requests per provider (three styles by three transports).`);
}
