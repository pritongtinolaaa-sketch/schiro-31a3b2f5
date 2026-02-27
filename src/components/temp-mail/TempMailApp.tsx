import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Copy,
  Inbox,
  Mail,
  RotateCcw,
  Shield,
  Sparkles,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type EmailItem = {
  id: string;
  from: string;
  subject: string;
  preview: string;
  receivedAt: number; // epoch ms
  body: string;
};

const DOMAINS = ["mailshed.dev", "inboxfwd.net", "tempbox.one"] as const;

type Domain = (typeof DOMAINS)[number];

function randomLocalPart() {
  const adjectives = ["quiet", "mint", "rapid", "paper", "neon", "civic", "lunar", "pixel", "soft", "delta"];
  const nouns = ["fox", "relay", "atlas", "spark", "window", "signal", "orbit", "thread", "vault", "kite"];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const num = String(Math.floor(Math.random() * 9000) + 1000);
  return `${a}.${n}${num}`;
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "2-digit",
  });
}

function makeDemoEmail(now: number): EmailItem {
  const senders = [
    "no-reply@streamvault.app",
    "security@cloud-notify.io",
    "newsletter@tinytools.co",
    "team@patchnotes.dev",
  ];
  const subjects = [
    "Your one-time code",
    "New login detected",
    "Welcome — here’s your link",
    "Weekly digest: 5 small wins",
  ];
  const from = senders[Math.floor(Math.random() * senders.length)];
  const subject = subjects[Math.floor(Math.random() * subjects.length)];
  const code = String(Math.floor(Math.random() * 900000) + 100000);
  const body = `Hi there,\n\nThis is a simulated message in your temporary inbox.\n\nVerification code: ${code}\n\nIf you did not request this, you can safely ignore it.\n\n— Temp Mail Demo`;

  return {
    id: crypto.randomUUID(),
    from,
    subject,
    preview: body.split("\n")[2] ?? body.slice(0, 60),
    receivedAt: now,
    body,
  };
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setReduced(Boolean(mq.matches));
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  return reduced;
}

export default function TempMailApp() {
  const prefersReducedMotion = usePrefersReducedMotion();

  const [domain, setDomain] = useState<Domain>(DOMAINS[0]);
  const [local, setLocal] = useState(() => randomLocalPart());
  const address = useMemo(() => `${local}@${domain}`, [local, domain]);

  const [emails, setEmails] = useState<EmailItem[]>(() => {
    const now = Date.now();
    return [makeDemoEmail(now - 1000 * 60 * 12), makeDemoEmail(now - 1000 * 60 * 60 * 3)];
  });
  const [activeId, setActiveId] = useState<string | null>(emails[0]?.id ?? null);

  useEffect(() => {
    if (!activeId && emails[0]?.id) setActiveId(emails[0].id);
  }, [activeId, emails]);

  const active = useMemo(() => emails.find((e) => e.id === activeId) ?? null, [emails, activeId]);

  const heroRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (prefersReducedMotion) return;

    const el = heroRef.current;
    if (!el) return;

    const onMove = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * 100;
      const y = ((ev.clientY - rect.top) / rect.height) * 100;
      el.style.setProperty("--spot-x", `${x.toFixed(2)}%`);
      el.style.setProperty("--spot-y", `${y.toFixed(2)}%`);
    };

    el.addEventListener("pointermove", onMove);
    return () => el.removeEventListener("pointermove", onMove);
  }, [prefersReducedMotion]);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      toast.success("Copied address", { description: address });
    } catch {
      toast.error("Couldn’t copy", { description: "Your browser blocked clipboard access." });
    }
  };

  const regenerate = () => {
    setLocal(randomLocalPart());
    setEmails([]);
    setActiveId(null);
    toast("New inbox generated", { description: "Your previous inbox was cleared." });
  };

  const receiveTestEmail = () => {
    const now = Date.now();
    const next = makeDemoEmail(now);
    setEmails((prev) => [next, ...prev]);
    setActiveId(next.id);
    toast.success("New message received", { description: "(Simulated for this demo UI)" });
  };

  const deleteActive = () => {
    if (!active) return;

    setEmails((prev) => {
      const remaining = prev.filter((e) => e.id !== active.id);
      setActiveId(remaining[0]?.id ?? null);
      return remaining;
    });

    toast("Deleted", { description: "Message removed from this inbox." });
  };

  const clearInbox = () => {
    setEmails([]);
    setActiveId(null);
    toast("Inbox cleared");
  };

  return (
    <div className="min-h-screen">
      <header ref={heroRef} className="relative overflow-hidden border-b bg-hero">
        <div className="pointer-events-none absolute inset-0 opacity-70" />
        <div className="container relative py-10 md:py-14">
          <div className="grid items-end gap-8 md:grid-cols-12">
            <div className="md:col-span-7">
              <div className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs text-muted-foreground shadow-elev">
                <Sparkles className="h-3.5 w-3.5" />
                <span>Instant inbox • no signup • demo UI</span>
              </div>
              <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight md:text-5xl">
                Temporary email, with a clean inbox you can actually use.
              </h1>
              <p className="mt-3 max-w-2xl text-pretty text-base text-muted-foreground md:text-lg">
                Generate a disposable address, copy it in one click, and watch messages appear. This first version is
                front-end only (no real email receiving yet).
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Button variant="hero" onClick={receiveTestEmail}>
                  <Inbox /> Receive test email
                </Button>
                <Button variant="glass" onClick={copyAddress}>
                  <Copy /> Copy address
                </Button>
              </div>

              <div className="mt-6 flex flex-wrap gap-3 text-sm text-muted-foreground">
                <div className="inline-flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  <span>Disposable by default</span>
                </div>
                <div className="inline-flex items-center gap-2">
                  <Mail className="h-4 w-4" />
                  <span>Preview + full message view</span>
                </div>
              </div>
            </div>

            <div className="md:col-span-5">
              <Card className="glass border-border/80 shadow-elev">
                <div className="p-5 md:p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-xs text-muted-foreground">Your temporary address</div>
                      <div className="mt-1 text-sm font-medium">
                        <span className="text-mono">{address}</span>
                      </div>
                    </div>
                    <Button size="icon" variant="outline" onClick={regenerate} aria-label="Regenerate inbox">
                      <RotateCcw />
                    </Button>
                  </div>

                  <div className="mt-4 grid gap-2">
                    <label className="text-xs text-muted-foreground">Local part</label>
                    <Input
                      value={local}
                      onChange={(e) => setLocal(e.target.value.replace(/\s+/g, "").slice(0, 32))}
                      className="text-mono"
                      placeholder="your.name"
                      inputMode="text"
                      aria-label="Local part"
                    />
                    <div className="flex flex-wrap gap-2">
                      {DOMAINS.map((d) => (
                        <Button
                          key={d}
                          variant={d === domain ? "default" : "secondary"}
                          size="sm"
                          onClick={() => setDomain(d)}
                          className="text-mono"
                        >
                          @{d}
                        </Button>
                      ))}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="glass" className="flex-1" onClick={copyAddress}>
                        <Copy /> Copy
                      </Button>
                      <Button variant="outline" className="flex-1" onClick={clearInbox}>
                        <Trash2 /> Clear
                      </Button>
                    </div>

                    <div className="mt-2 rounded-lg border bg-background/60 p-3 text-xs text-muted-foreground">
                      Tip: click <span className="font-medium">Receive test email</span> to simulate deliveries while the
                      real backend is not connected.
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </header>

      <main className="container py-8 md:py-10">
        <section className="grid gap-4 md:grid-cols-12">
          <Card className="md:col-span-5">
            <div className="flex items-center justify-between gap-4 border-b p-4">
              <div>
                <div className="text-sm font-medium">Inbox</div>
                <div className="text-xs text-muted-foreground">{emails.length} message(s)</div>
              </div>
              <Button variant="secondary" size="sm" onClick={receiveTestEmail}>
                <Inbox /> Receive
              </Button>
            </div>

            <div className="max-h-[520px] overflow-auto">
              {emails.length === 0 ? (
                <div className="p-6">
                  <div className="rounded-xl border bg-surface-2 p-5 shadow-sm">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Mail className="h-4 w-4" />
                      No messages yet
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Use this address on a signup form, or press “Receive” to simulate an incoming email.
                    </p>
                  </div>
                </div>
              ) : (
                <ul className="divide-y">
                  {emails.map((e) => {
                    const selected = e.id === activeId;
                    return (
                      <li key={e.id}>
                        <button
                          type="button"
                          onClick={() => setActiveId(e.id)}
                          className={cn(
                            "w-full px-4 py-4 text-left transition-colors",
                            selected ? "bg-accent/10" : "hover:bg-muted/50",
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{e.subject}</div>
                              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                <span className="text-mono">{e.from}</span>
                              </div>
                            </div>
                            <div className="shrink-0 text-xs text-muted-foreground">{formatTime(e.receivedAt)}</div>
                          </div>
                          <div className="mt-2 line-clamp-2 text-sm text-muted-foreground">{e.preview}</div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>

          <Card className="md:col-span-7">
            <div className="flex items-center justify-between gap-4 border-b p-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">Message</div>
                <div className="truncate text-xs text-muted-foreground text-mono">{address}</div>
              </div>
              <Button variant="outline" size="sm" onClick={deleteActive} disabled={!active}>
                <Trash2 /> Delete
              </Button>
            </div>

            <div className="p-5 md:p-6">
              {!active ? (
                <div className="rounded-xl border bg-surface-2 p-6 text-sm text-muted-foreground">
                  Select a message on the left to view it here.
                </div>
              ) : (
                <article className="animate-enter">
                  <h2 className="text-xl font-semibold tracking-tight">{active.subject}</h2>
                  <div className="mt-2 grid gap-1 text-sm text-muted-foreground">
                    <div>
                      From: <span className="text-mono">{active.from}</span>
                    </div>
                    <div>Received: {formatTime(active.receivedAt)}</div>
                  </div>

                  <div className="mt-5 rounded-xl border bg-background p-4 shadow-sm">
                    <pre className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                      {active.body}
                    </pre>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="glass" onClick={copyAddress}>
                      <Copy /> Copy address
                    </Button>
                    <Button variant="secondary" onClick={receiveTestEmail}>
                      <Inbox /> Receive another
                    </Button>
                  </div>
                </article>
              )}
            </div>
          </Card>
        </section>

        <footer className="mt-10 border-t pt-6 text-xs text-muted-foreground">
          <p>
            This is a UI prototype. To receive real emails, we can enable Lovable Cloud and connect it to an email
            receiving provider or implement an inbox API.
          </p>
        </footer>
      </main>
    </div>
  );
}
