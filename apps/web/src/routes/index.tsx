import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight, Check, ChevronDown, Copy, ShieldCheck, Terminal } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Home,
});

const GITHUB = "https://github.com/SerovaAI/ficta";
const NPM = "https://www.npmjs.com/package/@serovaai/ficta";
const DOCS = "https://github.com/SerovaAI/ficta/tree/main/packages/ficta#readme";
const THREAT_MODEL = "https://github.com/SerovaAI/ficta/blob/main/packages/ficta/docs/threat-model.md";
const SEROVA = "https://serova.ai";
const CONTACT_EMAIL = "hello@ficta.sh";
const CONTACT = `mailto:${CONTACT_EMAIL}?subject=ficta%20Gateway`;
const COPY_RESET_MS = 1600;

type CopyStatus = "idle" | "copied" | "manual";

/** A tokenized value as it appears on the wire — the surrogate the model actually receives. */
function Token({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[3px] bg-redaction px-1.5 py-0.5 font-mono text-[0.82em] text-foreground/85 break-words">
      {children}
    </span>
  );
}

/** A real value still inside Gateway, with the same origin language used by the product review. */
function ReviewValue({ children, origin }: { children: React.ReactNode; origin: "registry" | "detected" | "user" }) {
  const border =
    origin === "detected"
      ? "border-restored border-dashed"
      : origin === "registry"
        ? "border-restored"
        : "border-foreground";
  return <span className={`border-b-2 bg-restored/8 px-0.5 text-foreground ${border}`}>{children}</span>;
}

/* The Token Wrapper wordmark — `[ficta]`, brackets in vermilion, letters in chalk (assets/brand).
 * Rendered in code, never as an image, so it inherits the current text size. */
function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline font-mono text-[1.05rem] tracking-tight ${className}`}>
      <span aria-hidden className="text-primary">
        [
      </span>
      <span className="text-foreground">ficta</span>
      <span aria-hidden className="text-primary">
        ]
      </span>
    </span>
  );
}

/** Copy `text` with clipboard-API → execCommand fallbacks; selects `fallbackNode` as a last resort. */
function useCopy(text: string) {
  const [status, setStatus] = React.useState<CopyStatus>("idle");
  const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleReset = React.useCallback(() => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = setTimeout(() => setStatus("idle"), COPY_RESET_MS);
  }, []);

  React.useEffect(
    () => () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  const copy = React.useCallback(
    async (fallbackNode?: HTMLElement | null) => {
      const finish = (nextStatus: CopyStatus) => {
        setStatus(nextStatus);
        scheduleReset();
      };

      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          // Legacy / insecure-context fallback.
          if (typeof document === "undefined") {
            throw new Error("Clipboard is unavailable");
          }
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "absolute";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          try {
            const copied = document.execCommand("copy");
            if (!copied) {
              throw new Error("execCommand copy failed");
            }
          } finally {
            document.body.removeChild(ta);
          }
        }
        finish("copied");
      } catch {
        // Last resort: select the text so a manual copy is one keystroke away.
        const selection = typeof window !== "undefined" ? window.getSelection() : null;
        if (fallbackNode && selection) {
          const range = document.createRange();
          range.selectNodeContents(fallbackNode);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        finish("manual");
      }
    },
    [scheduleReset, text],
  );

  return { copied: status === "copied", manualCopy: status === "manual", status, copy };
}

/** The contact address as visible text with a copy affordance — mailto can silently fail on
 * locked-down machines, so the address itself must be graspable. */
function ContactEmail() {
  const emailRef = React.useRef<HTMLAnchorElement>(null);
  const { copied, manualCopy, copy } = useCopy(CONTACT_EMAIL);
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <a
        ref={emailRef}
        href={CONTACT}
        className="text-foreground underline decoration-primary/50 underline-offset-4 transition-colors hover:decoration-primary"
      >
        {CONTACT_EMAIL}
      </a>
      <button
        type="button"
        onClick={() => copy(emailRef.current)}
        aria-label={copied ? "Copied" : "Copy email address"}
        className="inline-flex size-6 translate-y-1 items-center justify-center self-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
      >
        {copied ? <Check className="size-3 text-restored" /> : <Copy className="size-3" />}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Email address copied" : manualCopy ? "Email address selected for manual copy" : ""}
      </span>
    </span>
  );
}

function InstallLine() {
  const codeRef = React.useRef<HTMLElement>(null);
  const cmd = "npm i -g @serovaai/ficta";
  const { copied, manualCopy, copy } = useCopy(cmd);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card/60 py-2 pr-2 pl-3.5 font-mono text-sm">
      <span aria-hidden className="text-muted-foreground">
        $
      </span>
      <code ref={codeRef} className="min-w-0 overflow-x-auto whitespace-nowrap text-foreground/90">
        {cmd}
      </code>
      <button
        type="button"
        onClick={() => copy(codeRef.current)}
        aria-label={copied ? "Copied" : "Copy install command"}
        className="ml-auto inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
      >
        {copied ? <Check className="size-3.5 text-restored" /> : <Copy className="size-3.5" />}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : manualCopy ? "Install command selected for manual copy" : ""}
      </span>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
    >
      {children}
      <span className="sr-only"> (opens in new tab)</span>
      <ArrowUpRight className="size-3.5" />
    </a>
  );
}

function Home() {
  return (
    <div className="min-h-dvh overflow-x-clip bg-background text-foreground">
      <SiteHeader />
      <main id="main">
        <Hero />
        <HowItWorks />
        <GatewaySection />
        <OssProof />
        <Faq />
        <ScopeNote />
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-border/70 border-b bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-15 max-w-6xl items-center gap-6 px-5 sm:px-8">
        <Wordmark />
        <nav className="ml-auto hidden items-center gap-6 text-sm text-muted-foreground lg:flex">
          <a
            href="#how"
            className="inline-flex items-center transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
          >
            Workflow
          </a>
          <a
            href="#gateway"
            className="inline-flex items-center transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
          >
            Workspace
          </a>
          <a
            href="#oss"
            className="inline-flex items-center transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
          >
            OSS engine
          </a>
          <a
            href="#faq"
            className="inline-flex items-center transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
          >
            FAQ
          </a>
          <ExternalLink href={THREAT_MODEL}>Threat model</ExternalLink>
          <ExternalLink href={GITHUB}>GitHub</ExternalLink>
        </nav>
        <Button asChild size="sm" className="ml-auto sm:ml-0">
          <a href={CONTACT}>Talk to us</a>
        </Button>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* A faint vermilion wash anchored top-right — the redaction stamp bleeding in. */}
      <div
        aria-hidden
        className="-z-10 pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(60rem 40rem at 82% -8%, oklch(0.67 0.2 33 / 0.14), transparent 60%)",
        }}
      />
      <div className="mx-auto grid max-w-6xl gap-14 px-5 pt-20 pb-24 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:pt-28 lg:pb-32">
        <div className="min-w-0 animate-rise">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card/50 py-1 pr-3 pl-2 text-muted-foreground text-xs">
            <span className="inline-block size-1.5 rounded-full bg-restored" />
            review before send · local restore
          </p>
          <h1 className="font-semibold text-[clamp(2.5rem,4.2vw,3.3rem)] leading-[0.98]">
            See what leaves. <br />
            <span className="text-muted-foreground">Protect what matters.</span>
          </h1>
          <p className="mt-6 max-w-xl text-[1.05rem] text-muted-foreground leading-relaxed">
            ficta Gateway is a self-hosted AI workspace for regulated teams. It marks registered and detected values
            before model egress, lets users add anything missed, and replaces protected text with local surrogates
            before the provider sees it.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <a href={CONTACT}>
                Talk to us
                <ArrowUpRight className="size-4" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href={THREAT_MODEL} target="_blank" rel="noreferrer">
                Read the threat model
                <ArrowUpRight className="size-4" />
              </a>
            </Button>
          </div>
          <p className="mt-5 text-muted-foreground text-sm">
            Provider keys stay server-side. Responses are restored inside your environment.{" "}
            <a
              href="#oss"
              className="text-foreground underline decoration-primary/50 underline-offset-4 transition-colors hover:decoration-primary"
            >
              Inspect the engine →
            </a>
          </p>
        </div>
        <GatewayReviewArt />
      </div>
    </section>
  );
}

/** A faithful, interactive slice of Gateway's pre-send review instead of a generic product screenshot. */
function GatewayReviewArt() {
  const [mode, setMode] = React.useState<"values" | "model">("values");
  return (
    <div className="w-full min-w-0 max-w-full animate-rise [animation-delay:120ms] lg:-mr-10">
      <div className="relative mx-auto w-full max-w-[760px] lg:w-[736px] lg:max-w-none">
        <div aria-hidden className="-z-10 absolute inset-y-8 right-12 left-12 rounded-full bg-primary/8 blur-3xl" />
        <div className="overflow-hidden rounded-xl bg-card shadow-2xl shadow-black/40">
          <div className="flex min-w-0 items-center gap-3 border-border/70 border-b bg-background/35 px-4 py-3">
            <div aria-hidden className="flex gap-1.5">
              <span className="size-2.5 rounded-full border border-border" />
              <span className="size-2.5 rounded-full border border-border" />
              <span className="size-2.5 rounded-full border border-border" />
            </div>
            <div className="flex min-w-0 items-baseline gap-2">
              <Wordmark className="text-sm" />
              <span className="font-medium text-foreground text-sm">Gateway</span>
            </div>
            <div className="ml-auto hidden items-center gap-2 rounded-full border border-border px-2.5 py-1 font-mono text-[0.68rem] text-restored sm:flex">
              <span className="size-1.5 rounded-full bg-restored" />
              protection connected
            </div>
          </div>

          <div className="border-border/70 border-b px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-restored" aria-hidden />
                  <p className="font-medium text-sm">Review protection</p>
                </div>
                <p className="mt-1 text-muted-foreground text-xs">
                  Nothing is sent to the model until you choose Send protected.
                </p>
              </div>
              <div
                className="flex rounded-lg bg-background/60 p-0.5"
                role="tablist"
                aria-label="Protection preview view"
              >
                <button
                  type="button"
                  role="tab"
                  id="hero-values-tab"
                  aria-selected={mode === "values"}
                  aria-controls="hero-values-panel"
                  onClick={() => setMode("values")}
                  className={`min-h-8 rounded-md px-2.5 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11 ${mode === "values" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Values
                </button>
                <button
                  type="button"
                  role="tab"
                  id="hero-model-tab"
                  aria-selected={mode === "model"}
                  aria-controls="hero-model-panel"
                  onClick={() => setMode("model")}
                  className={`min-h-8 rounded-md px-2.5 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11 ${mode === "model" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Model will see
                </button>
              </div>
            </div>
          </div>

          <div className="p-4 sm:p-5">
            <div id="hero-values-panel" role="tabpanel" aria-labelledby="hero-values-tab" hidden={mode !== "values"}>
              <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-[0.68rem] text-muted-foreground">
                <LegendMark label="Registry · Exact" border="border-restored" />
                <LegendMark label="Detected · best effort" border="border-restored border-dashed" />
                <LegendMark label="You protected · Exact" border="border-foreground" />
              </div>
              <div className="rounded-lg bg-background/55 px-4 py-4 text-[0.9rem] text-foreground leading-7 break-words">
                Draft a renewal note for <ReviewValue origin="registry">Northwind Health</ReviewValue> about matter{" "}
                <ReviewValue origin="user">invoice-4471</ReviewValue> and send it to{" "}
                <ReviewValue origin="detected">emily.carter@northwind.co</ReviewValue>.
              </div>
              <p className="mt-3 text-muted-foreground text-xs">
                Highlight text or type a phrase to protect it for this chat.
              </p>
            </div>
            <div id="hero-model-panel" role="tabpanel" aria-labelledby="hero-model-tab" hidden={mode !== "model"}>
              <p className="mb-3 text-muted-foreground text-xs">
                Protected values are replaced before the provider receives the request.
              </p>
              <div className="rounded-lg bg-background/55 px-4 py-4 font-mono text-[0.78rem] text-foreground/85 leading-7 break-words">
                Draft a renewal note for <Token>FICTA_82a1c0...</Token> about matter <Token>FICTA_71d4aa...</Token> and
                send it to <Token>FICTA_9f3a2c...</Token>.
              </div>
              <p className="mt-3 font-mono text-[0.68rem] text-muted-foreground">
                mapping: local to this Gateway scope
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-border/70 border-t bg-background/25 px-4 py-3 sm:px-5">
            <span className="text-muted-foreground text-xs">Back to edit</span>
            <span className="inline-flex min-h-9 items-center gap-2 rounded-md bg-primary px-3 font-medium text-primary-foreground text-sm">
              <Check className="size-4" aria-hidden />
              Send protected
            </span>
          </div>
        </div>

        <p className="mt-3 px-1 text-muted-foreground text-xs">
          Exact matches use solid lines. Best-effort detector matches use dashed lines.
        </p>
      </div>
    </div>
  );
}

function LegendMark({ label, border }: { label: string; border: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-3 rounded-[3px] border-2 bg-restored/8 ${border}`} aria-hidden />
      {label}
    </span>
  );
}

const STEPS = [
  {
    title: "Review",
    body: "Registry matches and configured detector matches are marked before any provider request begins.",
  },
  {
    title: "Protect",
    body: "Users can add a missed name, amount, project, code, or clause and inspect the exact text the model will see.",
  },
  {
    title: "Send and verify",
    body: "Gateway tokenizes protected values, restores the response locally, and records values-free egress evidence.",
  },
];

function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-16 border-border/60 border-t">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
        <div className="max-w-2xl">
          <h2 className="font-semibold text-[clamp(1.75rem,3.5vw,2.5rem)] leading-tight">Review. Protect. Send.</h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            Gateway turns model egress into a visible workflow. Registered values use exact matching; configured
            detectors remain best effort.
          </p>
        </div>
        <ol className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="bg-card p-6">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-muted-foreground text-sm">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="font-medium text-lg">{step.title}</h3>
              </div>
              <p className="mt-3 text-muted-foreground text-sm leading-relaxed">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function GatewaySection() {
  return (
    <section id="gateway" className="scroll-mt-16 border-border/60 border-t">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
        <div className="grid gap-10 lg:grid-cols-[0.92fr_1.08fr] lg:items-start">
          <div className="max-w-2xl">
            <h2 className="font-semibold text-[clamp(1.75rem,3.5vw,2.5rem)] leading-tight">
              Protection gets stronger with the team.
            </h2>
            <p className="mt-4 text-muted-foreground leading-relaxed">
              Users can protect a phrase for one chat or suggest it for the workspace. Admins approve exact-match
              policy, publish it to the running proxy, and verify that the same revision is active.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button asChild>
                <a href={CONTACT}>
                  Talk to us
                  <ArrowUpRight className="size-4" />
                </a>
              </Button>
              <Button asChild variant="outline">
                <a href="#faq">Review deployment</a>
              </Button>
            </div>
            <p className="mt-4 text-muted-foreground text-sm">
              One Gateway and proxy deployment serves one organization. Email <ContactEmail />
            </p>
          </div>
          <article className="relative overflow-hidden rounded-xl border border-primary/30 bg-card p-7">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background: "radial-gradient(30rem 20rem at 100% 0%, oklch(0.67 0.2 33 / 0.1), transparent 62%)",
              }}
            />
            <div className="relative flex items-center gap-2.5 text-muted-foreground">
              <ShieldCheck className="size-4 text-primary" />
              <span className="font-mono text-xs uppercase tracking-widest">Gateway · governed workspace</span>
            </div>
            <h3 className="relative mt-4 font-semibold text-2xl">
              From a missed phrase <span className="text-muted-foreground">to active policy.</span>
            </h3>
            <ol className="relative mt-5 border-border/70 border-y">
              {[
                [
                  "Protected in this chat",
                  "A user adds an amount, project, code, or clause the detectors did not find.",
                ],
                [
                  "Suggested for workspace",
                  "The value enters an admin review queue; it does not silently change policy.",
                ],
                [
                  "Approved and published",
                  "Exact-match values and aliases are written privately and loaded by the proxy.",
                ],
                ["Verified active", "Gateway confirms the running proxy parsed that exact revision."],
              ].map(([title, body], index) => (
                <li key={title} className="flex gap-3 border-border/70 border-t py-3 first:border-t-0">
                  <span className="mt-0.5 font-mono text-restored text-xs">{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    <span className="block font-medium text-foreground text-sm">{title}</span>
                    <span className="mt-1 block text-muted-foreground text-xs leading-relaxed">{body}</span>
                  </span>
                </li>
              ))}
            </ol>
            <ul className="relative mt-5 grid gap-x-5 gap-y-2 text-muted-foreground text-xs sm:grid-cols-2">
              {[
                "BYO OpenAI and Anthropic keys",
                "Model allow-lists and reasoning controls",
                "PDF, DOCX, and text review",
                "Values-free receipts and trends",
              ].map((item) => (
                <li key={item} className="flex gap-2">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-restored" />
                  {item}
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}

function OssProof() {
  return (
    <section id="oss" className="scroll-mt-16 border-border/60 border-t">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[0.85fr_1.15fr] lg:py-24">
        <div className="max-w-xl">
          <h2 className="font-semibold text-[clamp(1.75rem,3.5vw,2.5rem)] leading-tight">
            Open source where the boundary needs proof.
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            The engine and CLI stay visible because technical evaluators should be able to inspect the redaction path,
            run it locally, and compare the shipped behavior against the written threat model.
          </p>
        </div>
        <article className="rounded-xl border border-border bg-card p-7">
          <div className="flex items-center gap-2.5 text-muted-foreground">
            <Terminal className="size-4 text-foreground" />
            <span className="font-mono text-xs uppercase tracking-widest">open source · MIT engine</span>
          </div>
          <h3 className="mt-4 font-semibold text-2xl">
            Same redaction core. <span className="text-muted-foreground">Readable, installable, auditable.</span>
          </h3>
          <p className="mt-3 text-muted-foreground leading-relaxed">
            Developers can run the CLI with <strong className="font-medium text-foreground">Claude Code</strong>,{" "}
            <strong className="font-medium text-foreground">Codex</strong>, and{" "}
            <strong className="font-medium text-foreground">Pi</strong>. Gateway builds the team workspace around that
            same local mechanism.
          </p>
          <div className="mt-6 max-w-md">
            <InstallLine />
          </div>
          <ul className="mt-6 grid gap-3 text-sm sm:grid-cols-3">
            {[
              "Exact-match protection for registered values",
              "Fail-closed if a registered value would leave verbatim",
              "Runs locally per launch, with no account or telemetry",
            ].map((item) => (
              <li key={item} className="flex gap-2.5 text-muted-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-restored" />
                {item}
              </li>
            ))}
          </ul>
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-border/60 border-t pt-5 text-sm">
            <ExternalLink href={GITHUB}>GitHub</ExternalLink>
            <ExternalLink href={NPM}>npm</ExternalLink>
            <ExternalLink href={DOCS}>Docs</ExternalLink>
            <ExternalLink href={THREAT_MODEL}>Threat model</ExternalLink>
          </div>
        </article>
      </div>
    </section>
  );
}

const FAQ_ITEMS = [
  {
    question: "What is exact, and what is best effort?",
    answer: (
      <>
        Registered values, aliases, and phrases a user protects for a chat use exact matching. Secret-shape and PII
        detection reduce exposure, but they can miss values and are not a completeness guarantee.
      </>
    ),
  },
  {
    question: "Can administrators require review before sending?",
    answer: (
      <>
        Yes. Review starts on for each chat, and administrators can lock it on for the deployment. The server requires a
        short-lived confirmation bound to the user, organization, chat, and exact message before the provider request
        begins.
      </>
    ),
  },
  {
    question: "Where do provider keys and chat history live?",
    answer: (
      <>
        Provider keys stay server-side and workspace-managed keys are encrypted before storage. Chat history remains in
        your PGlite or Postgres database and contains the restored transcript, so it must be governed as sensitive data.
      </>
    ),
  },
  {
    question: "What happens if a configured detector is unavailable?",
    answer: (
      <>
        The outage policy is explicit. A production-like deployment can run networked detectors fail-closed so sends are
        blocked while a required sidecar is unavailable. Detector health remains visible to administrators.
      </>
    ),
  },
  {
    question: "Does Ficta make confidential content safe to send?",
    answer: (
      <>
        No. Confidentiality is broader than identifiers and PII. Ficta reduces exposure of registered and detectable
        values, but facts, clauses, and context can remain sensitive after names are removed. External model use still
        needs your policy boundary.
      </>
    ),
  },
];

function Faq() {
  return (
    <section id="faq" className="scroll-mt-16 border-border/60 border-t">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:py-28">
        <div>
          <h2 className="font-semibold text-[clamp(1.75rem,3.5vw,2.5rem)] leading-tight">
            Questions the boundary should answer.
          </h2>
          <p className="mt-4 max-w-xl text-muted-foreground leading-relaxed">
            Deployment, policy, and evidence stay explicit. Covered request surfaces and deliberate exceptions are
            documented in the threat model.
          </p>
        </div>
        <div className="border-border/70 border-y">
          {FAQ_ITEMS.map((item) => (
            <details key={item.question} className="group border-border/70 border-t first:border-t-0">
              <summary className="flex cursor-pointer list-none items-start gap-4 rounded-sm py-5 text-left font-medium text-foreground transition-colors hover:text-primary [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 pt-0.5">{item.question}</span>
                <ChevronDown className="mt-1 ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 group-hover:text-primary" />
              </summary>
              <div className="max-w-2xl pb-5 text-muted-foreground text-sm leading-relaxed">{item.answer}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function ScopeNote() {
  return (
    <section className="border-border/60 border-t">
      <div className="mx-auto max-w-2xl px-5 py-20 sm:px-8 lg:py-24">
        <h2 className="font-semibold text-[clamp(1.5rem,3vw,2rem)] leading-tight">
          Exact where configured. Honest everywhere else.
        </h2>
        <div className="mt-6 space-y-4 text-muted-foreground leading-relaxed">
          <p>
            Registered values and chat-added phrases use{" "}
            <strong className="font-medium text-foreground">exact-match</strong> protection. If a registered value
            survives redaction in a covered surface, the request is blocked instead of forwarded.
          </p>
          <p>
            Secret-shape and PII detection are <strong className="font-medium text-foreground">best-effort</strong>.
            They reduce exposure but can miss values, and confidential context can remain after identifiers are removed.
            ficta is not enterprise DLP, a compliance product, or a sandbox. The exact boundary is written down in the{" "}
            <a
              href={THREAT_MODEL}
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline decoration-primary/50 underline-offset-4 transition-colors hover:decoration-primary"
            >
              threat model
            </a>
            .
          </p>
        </div>
        {/* The honesty section is the enterprise pitch — so it gets the close. */}
        <div className="mt-10 border-border/60 border-t pt-8">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Button asChild size="lg">
              <a href={CONTACT}>
                Talk to us
                <ArrowUpRight className="size-4" />
              </a>
            </Button>
            <p className="text-muted-foreground text-sm">
              If that boundary fits your team, email <ContactEmail />.
            </p>
          </div>
          <p className="mt-5 text-muted-foreground text-sm">
            The engine is MIT-licensed —{" "}
            <a
              href={GITHUB}
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline decoration-primary/50 underline-offset-4 transition-colors hover:decoration-primary"
            >
              read every line
              <span className="sr-only"> (opens in new tab)</span>
            </a>
            {"."}
          </p>
        </div>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="border-border/60 border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:px-8">
        <div>
          <Wordmark />
          <p className="mt-2 text-muted-foreground text-sm">Review and redaction for self-hosted model traffic.</p>
        </div>
        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm sm:ml-auto">
          <ExternalLink href={GITHUB}>GitHub</ExternalLink>
          <ExternalLink href={NPM}>npm</ExternalLink>
          <ExternalLink href={DOCS}>Docs</ExternalLink>
          <ExternalLink href={THREAT_MODEL}>Threat model</ExternalLink>
          <a
            href={CONTACT}
            className="inline-flex items-center text-muted-foreground transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
          >
            Talk to us
          </a>
        </nav>
      </div>
      <div className="mx-auto max-w-6xl border-border/40 border-t px-5 py-5 text-muted-foreground text-xs sm:px-8">
        Engine + CLI are MIT. ficta&nbsp;Gateway is source-available (BUSL-1.1); production use needs a commercial
        license. © 2026 ficta — built and owned by{" "}
        <a
          href={SEROVA}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center underline underline-offset-4 transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11"
        >
          Serova
          <span className="sr-only"> (opens in new tab)</span>
        </a>{" "}
        ·{" "}
        <a
          href={CONTACT}
          className="inline-flex items-center underline underline-offset-4 transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11"
        >
          {CONTACT_EMAIL}
        </a>
      </div>
    </footer>
  );
}
