import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { toast } from "sonner";
import { Copy, Inbox, Mail, Shield, Sparkles, Trash2 } from "lucide-react";

import { lovable } from "@/integrations/lovable";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import InboxCreatorCard, { getTempMailDomains, type Domain } from "@/components/temp-mail/InboxCreatorCard";

import {
  clearInboxRemote,
  clearSavedInbox,
  createInbox,
  deleteMessage,
  listMessages,
  loadSavedInbox,
  saveInbox,
  sendTestEmail,
  subscribeToInbox,
  type TempMailMessage,
} from "./cloudTempMail";

const DOMAINS = getTempMailDomains();

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "2-digit",
  });
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

function domainFromAddress(address: string): Domain | null {
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  const d = address.slice(at + 1);
  return (DOMAINS as readonly string[]).includes(d) ? (d as Domain) : null;
}

export default function TempMailApp() {
  const prefersReducedMotion = usePrefersReducedMotion();

  const [selectedDomain, setSelectedDomain] = useState<Domain | null>(null);
  const [localPart, setLocalPart] = useState("");

  const [address, setAddress] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  const [loadingInbox, setLoadingInbox] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const [emails, setEmails] = useState<TempMailMessage[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  useEffect(() => {
    if (!activeId && emails[0]?.id) setActiveId(emails[0].id);
  }, [activeId, emails]);

  const active = useMemo(() => emails.find((e) => e.id === activeId) ?? null, [emails, activeId]);

  const heroRef = useRef<HTMLDivElement | null>(null);
  const creatingGuestInboxRef = useRef(false);

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

  const loadProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase.from("profiles").select("display_name").eq("id", userId).maybeSingle();
    if (error) {
      setProfileName(null);
      return;
    }
    setProfileName(data?.display_name ?? null);
  }, []);

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession);
      const nextUser = currentSession?.user ?? null;
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser) {
        void loadProfile(nextUser.id);
      } else {
        setProfileName(null);
      }
    });

    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      const nextUser = data.session?.user ?? null;
      setUser(nextUser);
      if (nextUser) {
        void loadProfile(nextUser.id);
      } else {
        setProfileName(null);
      }
      setAuthReady(true);
    });

    return () => listener.subscription.unsubscribe();
  }, [loadProfile]);

  const refreshMessages = useCallback(async (opts?: { silent?: boolean }) => {
    if (!address || !token) return;
    if (!opts?.silent) setLoadingMessages(true);

    try {
      const res = await listMessages({ address, token });
      setEmails(res.messages);
      setExpiresAt(res.expiresAt);
    } catch (e: any) {
      toast.error("Couldn't load inbox", { description: e?.message ?? "Please try again." });
    } finally {
      setLoadingMessages(false);
    }
  }, [address, token]);

  const ensureInbox = async () => {
    setLoadingInbox(true);
    try {
      const saved = loadSavedInbox();
      if (saved) {
        setAddress(saved.address);
        setToken(saved.token);
        setExpiresAt(saved.expiresAt);
        const d = domainFromAddress(saved.address);
        if (d) setSelectedDomain(d);
      }
    } finally {
      setLoadingInbox(false);
    }
  };

  useEffect(() => {
    if (!authReady || loadingInbox || user || address || creatingGuestInboxRef.current) return;

    const domain = selectedDomain ?? DOMAINS[0];
    if (!selectedDomain) setSelectedDomain(domain);

    creatingGuestInboxRef.current = true;
    setLoadingInbox(true);

    void createInbox({ domain })
      .then((created) => {
        setAddress(created.address);
        setToken(created.token);
        setExpiresAt(created.expiresAt);
        saveInbox(created);
      })
      .catch((e: any) => {
        toast.error("Couldn't create guest inbox", { description: e?.message ?? "Please try again." });
      })
      .finally(() => {
        creatingGuestInboxRef.current = false;
        setLoadingInbox(false);
      });
  }, [authReady, loadingInbox, user, address, selectedDomain]);

  useEffect(() => {
    void ensureInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!address || !token) return;
    void refreshMessages({ silent: true });

    const unsubscribe = subscribeToInbox(address, () => {
      void refreshMessages({ silent: true });
      toast.success("New message received", { description: "Your inbox updated in realtime." });
    });

    return unsubscribe;
  }, [address, token, refreshMessages]);

  useEffect(() => {
    if (!address || !token) return;

    const intervalId = window.setInterval(() => {
      void refreshMessages({ silent: true });
    }, 15000);

    return () => window.clearInterval(intervalId);
  }, [address, token, refreshMessages]);

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast.success("Copied address", { description: address });
    } catch {
      toast.error("Couldn't copy", { description: "Your browser blocked clipboard access." });
    }
  };

  const createEmail = async () => {
    if (!selectedDomain) return;

    const trimmed = localPart.trim();
    const chosenLocalPart = trimmed.length ? trimmed : undefined;
    if (chosenLocalPart) {
      const ok = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/i.test(chosenLocalPart);
      if (!ok) {
        toast.error("Invalid email name", {
          description: "Use letters/numbers plus . _ - (3–32 chars), and start/end with a letter or number.",
        });
        return;
      }
    }

    setLoadingInbox(true);
    try {
      // Replace current inbox.
      clearSavedInbox();
      setEmails([]);
      setActiveId(null);

      const created = await createInbox({ domain: selectedDomain, localPart: chosenLocalPart });
      setAddress(created.address);
      setToken(created.token);
      setExpiresAt(created.expiresAt);
      saveInbox(created);
      setLocalPart("");
      toast.success("Email created", { description: created.address });
    } catch (e: any) {
      toast.error("Couldn't create email", { description: e?.message ?? "Please try again." });
    } finally {
      setLoadingInbox(false);
    }
  };

  const regenerate = async () => {
    if (!selectedDomain) return;
    setLoadingInbox(true);
    try {
      clearSavedInbox();
      const created = await createInbox({ domain: selectedDomain });
      setAddress(created.address);
      setToken(created.token);
      setExpiresAt(created.expiresAt);
      saveInbox(created);
      setEmails([]);
      setActiveId(null);
      toast("New inbox generated", { description: "Your previous inbox was cleared." });
    } catch (e: any) {
      toast.error("Couldn't generate inbox", { description: e?.message ?? "Please try again." });
    } finally {
      setLoadingInbox(false);
    }
  };

  const receiveTestEmail = async () => {
    if (!address || !token) return;
    try {
      await sendTestEmail({ address, token });
      toast.success("Test email sent", { description: "Delivered to your inbox." });
      // Realtime will refresh; we also do a quick optimistic refresh in case websocket is slow.
      void refreshMessages({ silent: true });
    } catch (e: any) {
      toast.error("Couldn't send test email", { description: e?.message ?? "Please try again." });
    }
  };

  const deleteActive = async () => {
    if (!active || !address || !token) return;

    try {
      await deleteMessage({ address, token, messageId: active.id });
      toast("Deleted", { description: "Message removed from this inbox." });
      setActiveId(null);
      await refreshMessages({ silent: true });
    } catch (e: any) {
      toast.error("Couldn't delete", { description: e?.message ?? "Please try again." });
    }
  };

  const clearInbox = async () => {
    const targetDomain = selectedDomain ?? (address ? domainFromAddress(address) : null);
    if (!targetDomain) {
      toast.error("Select a domain first", { description: "Pick a domain, then clear to generate a random email." });
      return;
    }

    setLoadingInbox(true);
    try {
      if (address && token) {
        await clearInboxRemote({ address, token });
      }

      clearSavedInbox();
      setEmails([]);
      setActiveId(null);

      const created = await createInbox({ domain: targetDomain });
      setAddress(created.address);
      setToken(created.token);
      setExpiresAt(created.expiresAt);
      saveInbox(created);
      setLocalPart("");

      toast.success("Random email generated", { description: created.address });
    } catch (e: any) {
      toast.error("Couldn't regenerate email", { description: e?.message ?? "Please try again." });
    } finally {
      setLoadingInbox(false);
    }
  };

  const handleAuthSubmit = async () => {
    if (!authEmail || !authPassword) {
      toast.error("Missing credentials", { description: "Please enter email and password." });
      return;
    }

    setAuthLoading(true);
    try {
      if (authMode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail,
          password: authPassword,
        });
        if (error) throw error;
        toast.success("Logged in");
      } else {
        const { error } = await supabase.auth.signUp({
          email: authEmail,
          password: authPassword,
          options: {
            data: {
              display_name: authDisplayName || undefined,
              username: authDisplayName || undefined,
            },
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) throw error;
        toast.success("Account created", { description: "Check your email to verify your account." });
      }

      setIsAuthDialogOpen(false);
      setAuthPassword("");
    } catch (e: any) {
      toast.error("Authentication failed", { description: e?.message ?? "Please try again." });
    } finally {
      setAuthLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    try {
      const { error } = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (error) throw error;
    } catch (e: any) {
      toast.error("Google sign-in failed", { description: e?.message ?? "Please try again." });
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      toast.error("Couldn't sign out", { description: error.message });
      return;
    }
    toast.success("Signed out");
  };

  const isLoggedIn = Boolean(session);
  const profileLabel =
    profileName ??
    String(user?.user_metadata?.username ?? user?.user_metadata?.display_name ?? user?.email?.split("@")[0] ?? "Profile");

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-50 border-b bg-background/85 backdrop-blur-md">
        <div className="container flex h-14 items-center justify-between">
          <div className="inline-flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Mail className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold tracking-wide">schiromail</span>
          </div>

          {isLoggedIn ? (
            <div className="flex items-center gap-3">
              <span className="max-w-[180px] truncate text-sm text-muted-foreground">{profileLabel}</span>
              <Button variant="outline" size="sm" onClick={() => void handleSignOut()}>
                Sign out
              </Button>
            </div>
          ) : (
            <Button variant="hero" size="sm" onClick={() => setIsAuthDialogOpen(true)}>
              Login
            </Button>
          )}
        </div>
      </nav>

      <header ref={heroRef} className="relative overflow-hidden border-b bg-hero">
        <div className="pointer-events-none absolute inset-0 opacity-70" />
        <div className="container relative py-10 md:py-14">
          <div className="grid gap-8 md:grid-cols-12 md:items-start">
            <div className="md:col-span-7">
              <div className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs text-muted-foreground shadow-elev">
                <Sparkles className="h-3.5 w-3.5" />
                <span>Real inbox • persisted • realtime updates</span>
              </div>
              <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight md:text-5xl">
                Temporary email, now with persistence and realtime delivery.
              </h1>
              <p className="mt-3 max-w-2xl text-pretty text-base text-muted-foreground md:text-lg">
                Your inbox is stored in the backend and updates live when new mail arrives. Keep this tab open to watch
                messages stream in.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Button variant="hero" onClick={receiveTestEmail} disabled={loadingInbox || !address}>
                  <Inbox /> Receive test email
                </Button>
                <Button variant="glass" onClick={copyAddress} disabled={!address}>
                  <Copy /> Copy address
                </Button>
                <Button variant="secondary" onClick={() => void refreshMessages()} disabled={loadingMessages || !address}>
                  Refresh
                </Button>
              </div>

              <div className="mt-6 flex flex-wrap gap-3 text-sm text-muted-foreground">
                <div className="inline-flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  <span>Private via access token</span>
                </div>
                <div className="inline-flex items-center gap-2">
                  <Mail className="h-4 w-4" />
                  <span>Broadcast-driven updates</span>
                </div>
              </div>
            </div>

            <div className="md:col-span-5">
              <InboxCreatorCard
                loadingInbox={loadingInbox}
                address={address}
                expiresAt={expiresAt}
                selectedDomain={selectedDomain}
                onSelectedDomainChange={setSelectedDomain}
                localPart={localPart}
                onLocalPartChange={setLocalPart}
                onCreate={() => void createEmail()}
                onRegenerate={() => void regenerate()}
                onCopy={() => void copyAddress()}
                onClear={() => void clearInbox()}
              />
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
              <Button variant="secondary" size="sm" onClick={receiveTestEmail} disabled={loadingInbox || !address}>
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
                      Use this address on a signup form, or press "Receive" to deliver a real test email.
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
                <div className="truncate text-xs text-muted-foreground text-mono">{address ?? "—"}</div>
              </div>
              <Button variant="outline" size="sm" onClick={() => void deleteActive()} disabled={!active}>
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
                    <pre className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{active.body}</pre>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="glass" onClick={copyAddress} disabled={!address}>
                      <Copy /> Copy address
                    </Button>
                    <Button variant="secondary" onClick={receiveTestEmail} disabled={loadingInbox || !address}>
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
            Backend is enabled via Lovable Cloud. Next: connect an inbound email provider to the webhook so real external
            emails are ingested automatically.
          </p>
        </footer>
      </main>

      <Dialog open={isAuthDialogOpen} onOpenChange={setIsAuthDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{authMode === "login" ? "Login" : "Create account"}</DialogTitle>
            <DialogDescription>
              {authMode === "login"
                ? "Sign in to access your account."
                : "Create your account. Email verification is required before login."}
            </DialogDescription>
          </DialogHeader>

          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void handleAuthSubmit();
            }}
          >
            {authMode === "login" ? (
              <Button type="button" variant="outline" onClick={() => void handleGoogleSignIn()} disabled={authLoading}>
                Continue with Google
              </Button>
            ) : null}

            {authMode === "login" ? <div className="text-center text-xs text-muted-foreground">or use email</div> : null}

            {authMode === "signup" ? (
              <Input
                placeholder="Username"
                value={authDisplayName}
                onChange={(e) => setAuthDisplayName(e.target.value)}
                disabled={authLoading}
                required
              />
            ) : null}

            <Input
              type="email"
              placeholder="you@example.com"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              disabled={authLoading}
              required
            />
            <Input
              type="password"
              placeholder="Password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              disabled={authLoading}
              required
            />

            <Button type="submit" variant="hero" disabled={authLoading}>
              {authLoading ? "Please wait..." : authMode === "login" ? "Login" : "Create account"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAuthMode((m) => (m === "login" ? "signup" : "login"))}
              disabled={authLoading}
            >
              {authMode === "login" ? "Need an account? Sign up" : "Already have an account? Login"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
