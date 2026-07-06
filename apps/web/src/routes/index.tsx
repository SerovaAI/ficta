import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight, Check, ChevronDown, Copy, Lock, ShieldCheck, Terminal } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Home,
});

const GITHUB = "https://github.com/SerovaAI/ficta";
const NPM = "https://www.npmjs.com/package/@serovaai/ficta";
const DOCS = "https://github.com/SerovaAI/ficta/tree/main/packages/ficta#readme";
const THREAT_MODEL = "https://github.com/SerovaAI/ficta/blob/main/packages/ficta/docs/threat-model.md";
const CONTACT_EMAIL = "hello@ficta.sh";
const CONTACT = `mailto:${CONTACT_EMAIL}?subject=ficta%20Gateway`;
const COPY_RESET_MS = 1600;

type CopyStatus = "idle" | "copied" | "manual";

/** A tokenized value as it appears on the wire — the surrogate the model actually receives. */
function Token({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[3px] bg-redaction px-1.5 py-0.5 font-mono text-[0.82em] text-foreground/85">
      {children}
    </span>
  );
}

/** A real value that stays local — shown in the mint "restored" signal. */
function Kept({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[0.82em] text-restored">{children}</span>;
}

/** Required provider auth passes through; it is not part of the protected model payload. */
function Passthrough({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[0.82em] text-muted-foreground">{children}</span>;
}

/** The return leg, animated: the reply arrives carrying the surrogate, which restores to the real
 * value in place. Static (and reduced-motion) default is the restored value — the loop only
 * replays the swap. Both layers share one grid cell so the swap never shifts layout. */
function RestoredSwap({ token, value, suffix = "" }: { token: string; value: string; suffix?: string }) {
  // `suffix` rides inside both layers so trailing punctuation hugs whichever value is visible;
  // the cell's slack (token is wider) then falls at the end of the line, where it's invisible.
  return (
    <span className="inline-grid align-baseline">
      <span aria-hidden className="wire-restore-token col-start-1 row-start-1 opacity-0">
        <Token>{token}</Token>
        {suffix}
      </span>
      <span className="wire-restore-value col-start-1 row-start-1">
        <Kept>{value}</Kept>
        {suffix}
      </span>
    </span>
  );
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
            How it works
          </a>
          <a
            href="#gateway"
            className="inline-flex items-center transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
          >
            ficta Gateway
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
      <div className="mx-auto grid max-w-6xl gap-14 px-5 pt-20 pb-24 sm:px-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:pt-28 lg:pb-32">
        <div className="min-w-0 animate-rise">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card/50 py-1 pr-3 pl-2 text-muted-foreground text-xs">
            <span className="inline-block size-1.5 rounded-full bg-restored" />
            self-hosted Gateway · local restore
          </p>
          <h1 className="font-semibold text-[clamp(2.5rem,4.2vw,3.3rem)] leading-[0.98]">
            AI chat behind your <br />
            <span className="text-muted-foreground">redaction boundary.</span>
          </h1>
          <p className="mt-6 max-w-xl text-[1.05rem] text-muted-foreground leading-relaxed">
            ficta Gateway is a self-hosted AI workspace for regulated teams. It swaps registered client names, matter
            IDs, secrets, and opt-in detected PII for local surrogates{" "}
            <em className="text-foreground/90 not-italic">before</em> requests reach the model — then restores the reply
            inside your environment.
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
            Built on an inspectable open-source engine.{" "}
            <a
              href="#oss"
              className="text-foreground underline decoration-primary/50 underline-offset-4 transition-colors hover:decoration-primary"
            >
              See the source path →
            </a>
          </p>
        </div>
        <WireCard />
      </div>
    </section>
  );
}

/** The airlock, made literal: real values on your machine, tokens on the wire, restored on return. */
function WireCard() {
  return (
    <div className="min-w-0 animate-rise [animation-delay:120ms]">
      <div className="min-w-0 rounded-xl border border-border bg-card/70 shadow-2xl shadow-black/40">
        <div className="flex items-center gap-2 border-border/70 border-b px-4 py-2.5 font-mono text-muted-foreground text-xs">
          <Lock className="size-3.5 text-primary" />
          POST /v1/messages
          <span className="ml-auto text-restored">on your machine</span>
        </div>
        <pre className="max-w-full overflow-x-auto px-4 py-4 font-mono text-[0.82rem] leading-6">
          <code>
            {"Authorization: Bearer "}
            <Passthrough>sk-live-4a9f…c2</Passthrough>
            {"\n\n"}
            {"{\n"}
            {'  "content": "email me at '}
            <Kept>ada@acme.co</Kept>
            {'"\n}'}
          </code>
        </pre>
        <div className="flex items-center justify-center gap-3 border-border/70 border-t border-b py-2 font-mono text-[0.7rem] text-muted-foreground uppercase tracking-widest">
          <span className="h-px w-8 bg-border" />
          ficta · redact
          <span className="h-px w-8 bg-border" />
        </div>
        <div className="px-4 py-2.5 font-mono text-muted-foreground text-xs">
          <span className="text-primary">→ leaves for the model</span>
        </div>
        <pre className="max-w-full overflow-x-auto px-4 pt-0 pb-4 font-mono text-[0.82rem] leading-6">
          <code>
            {"Authorization: Bearer "}
            <Passthrough>sk-live-4a9f…c2</Passthrough>
            {"\n\n"}
            {"{\n"}
            {'  "content": "email me at '}
            <Token>FICTA_1b8e4d…</Token>
            {'"\n}'}
          </code>
        </pre>
        <div className="flex items-center justify-center gap-3 border-border/70 border-t border-b py-2 font-mono text-[0.7rem] text-muted-foreground uppercase tracking-widest">
          <span className="h-px w-8 bg-border" />
          ficta · restore
          <span className="h-px w-8 bg-border" />
        </div>
        <div className="px-4 py-2.5 font-mono text-muted-foreground text-xs">
          <span className="text-restored">← restored in the reply</span>
        </div>
        <pre className="max-w-full overflow-x-auto px-4 pt-0 pb-4 font-mono text-[0.82rem] leading-6">
          <code>
            {"{\n"}
            {'  "content": "Here\'s your draft to '}
            <RestoredSwap token="FICTA_1b8e4d…" value="ada@acme.co" suffix={'"'} />
            {"\n}"}
          </code>
        </pre>
      </div>
      <p className="mt-3 px-1 text-muted-foreground text-xs">
        The provider receives required auth headers; protected payload values leave as tokens, and the mapping never
        leaves your machine.
      </p>
    </div>
  );
}

const STEPS = [
  {
    title: "Detect",
    body: "Registered .env / Doppler secrets, secret-shaped keys and JWTs, and — opt-in — detected PII across the request body, query, and non-auth headers.",
  },
  {
    title: "Tokenize",
    body: "Each protected value is swapped for a deterministic local surrogate. If a registered secret would still be forwarded verbatim, the request is blocked, not sent.",
  },
  {
    title: "Forward",
    body: "Protected payload values cross the boundary as tokens. Required auth headers pass through to the vendor; the mapping never leaves your machine.",
  },
  {
    title: "Restore",
    body: "As the reply streams back, surrogates are swapped for the real values locally — so your agent, or your lawyer, reads a coherent answer.",
  },
];

function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-16 border-border/60 border-t">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
        <div className="max-w-2xl">
          <h2 className="font-semibold text-[clamp(1.75rem,3.5vw,2.5rem)] leading-tight">
            A one-way airlock for model traffic
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            Point Gateway, an agent, or an app at the local ficta proxy. Everything on the way out is redacted;
            everything on the way back is restored. Reversible by design.
          </p>
        </div>
        <ol className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
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
              Self-hosted AI chat with the redaction boundary in front of the model.
            </h2>
            <p className="mt-4 text-muted-foreground leading-relaxed">
              Gateway packages ficta's local redact-and-restore engine as an internal workspace for law, health,
              finance, and other teams that need AI workflows without sending known sensitive values straight into
              provider context.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button asChild>
                <a href={CONTACT}>
                  Talk to us
                  <ArrowUpRight className="size-4" />
                </a>
              </Button>
              <Button asChild variant="outline">
                <a href="#faq">Review the boundary</a>
              </Button>
            </div>
            <p className="mt-4 text-muted-foreground text-sm">
              Design-partner pilots now — or email <ContactEmail />
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
              <span className="font-mono text-xs uppercase tracking-widest">Gateway · self-hosted</span>
            </div>
            <h3 className="relative mt-4 font-semibold text-2xl">
              What Gateway adds <span className="text-muted-foreground">around the engine</span>
            </h3>
            <ul className="relative mt-5 grid gap-4 text-sm sm:grid-cols-2">
              {[
                "Deploys inside your perimeter, with chat history on your own database",
                "Loads client, matter, patient, vendor, and case rosters as exact-match values",
                "Runs Presidio / OpenMed sidecars fail-closed when detection is required",
                "Supports regional recognizers, including South African ID and company numbers",
                "Admin controls and redaction proof without logging protected values",
                "SSO, workspaces, private support, and commercial licensing for teams",
              ].map((item) => (
                <li key={item} className="flex gap-2.5 text-muted-foreground">
                  <Check className="mt-0.5 size-4 shrink-0 text-restored" />
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
              "Exact-match protection for registered secrets",
              "Fail-closed if a protected value would leave verbatim",
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
    question: "Does the gateway support South African identifiers?",
    answer: (
      <>
        Yes. The Presidio sidecar can mount ficta's registry config, which keeps Presidio's default recognizers, enables
        South African ID numbers, and adds a South African company registration number recognizer.
      </>
    ),
  },
  {
    question: "Is that an exact guarantee?",
    answer: (
      <>
        No. Presidio recognition is still a best-effort detector. For the strong guarantee, load the firm's client
        names, matter IDs, case numbers, and other known identifiers as registered exact-match values.
      </>
    ),
  },
  {
    question: "Does Ficta make privileged or confidential legal content safe to send?",
    answer: (
      <>
        No. Legal confidentiality is broader than identifiers and PII. Ficta reduces exposure of registered identifiers
        and detectable PII, but factual content can still be confidential or privileged even after names are removed.
        Use Gateway inside your own policy boundary and treat external model use accordingly.
      </>
    ),
  },
  {
    question: "What happens if Presidio is unavailable?",
    answer: (
      <>
        For the gateway, run the detector fail-closed: if the sidecar is down, chat requests are blocked before they
        reach the model. That protects against an outage, but it does not make detection complete.
      </>
    ),
  },
  {
    question: "Can a firm add its own local patterns?",
    answer: (
      <>
        Yes. A deployment can extend Presidio with recognizers or deny-lists for firm-specific identifiers, while the
        ficta registry handles exact-match protection for known rosters and matter data.
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
            Built for local rules, not generic privacy theater.
          </h2>
          <p className="mt-4 max-w-xl text-muted-foreground leading-relaxed">
            The gateway can run Microsoft Presidio with local recognizer configuration, so regional identifiers and
            firm-specific shapes can be handled inside the same redact-and-restore path.
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
        <h2 className="font-semibold text-[clamp(1.5rem,3vw,2rem)] leading-tight">Honest about what it is</h2>
        <div className="mt-6 space-y-4 text-muted-foreground leading-relaxed">
          <p>
            The strong guarantee is <strong className="font-medium text-foreground">exact-match</strong> protection for
            the secrets you already manage: if a registered value would be sent verbatim in a surface ficta redacts, the
            request is blocked instead of forwarded.
          </p>
          <p>
            Secret-shape and PII detection are{" "}
            <strong className="font-medium text-foreground">opt-in, best-effort</strong> layers. They reduce exposure;
            they are not a completeness guarantee, and undetected values can still reach the model. ficta is
            secret-hygiene and PII-reduction tooling — <strong className="font-medium text-foreground">not</strong>{" "}
            enterprise DLP, a compliance product, or a sandbox.
          </p>
          <p>
            Ficta reduces exposure of registered identifiers and detectable PII. It does not make all confidential legal
            content safe to send to an external model.
          </p>
          <p>
            The exact boundary — every covered surface and deliberate exception — is written down in the{" "}
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
              If that boundary fits your team, email <ContactEmail /> — you'll hear back from the founder within a day.
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
            </a>{" "}
            — built and run by{" "}
            <a
              href="https://github.com/SerovaAI"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline decoration-primary/50 underline-offset-4 transition-colors hover:decoration-primary"
            >
              Stefan Lesicnik
              <span className="sr-only"> (opens in new tab)</span>
            </a>
            .
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
          <p className="mt-2 text-muted-foreground text-sm">A local redaction gateway for model traffic.</p>
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
        Engine + CLI are MIT. ficta&nbsp;Gateway is AGPL-3.0 with a commercial option. © 2026 ficta — built by
        Stefan&nbsp;Lesicnik ·{" "}
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
