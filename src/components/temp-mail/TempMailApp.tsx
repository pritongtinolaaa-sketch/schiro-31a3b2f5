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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import InboxCreatorCard, { type Domain } from "@/components/temp-mail/InboxCreatorCard";

import {
  clearInboxRemote,
  clearSavedInbox,
  createInbox,
  deleteMessage,
  deleteOwnedInbox,
  listMessages,
  listOwnedInboxes,
  listAvailableDomains,
  loadSavedInbox,
  saveInbox,
  getKnownInboxToken,
  sendTestEmail,
  subscribeToInbox,
  type OwnedInbox,
  type TempMailMessage,
} from "./cloudTempMail";

const DEFAULT_DOMAINS: Domain[] = [
  "tinola.eu.cc",
  "schiro.qzz.io",
  "schiro.dpdns.org",
  "schiro.indevs.in",
  "mailshed.dev",
  "inboxfwd.net",
  "tempbox.one",
];
const CLAIMED_INBOX_SEEN_KEY = "temp_mail_claimed_seen_v1";

type ClaimedSeenMap = Record<string, number>;

function readClaimedSeenMap(): ClaimedSeenMap {
  try {
    const raw = localStorage.getItem(CLAIMED_INBOX_SEEN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ClaimedSeenMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeClaimedSeenMap(map: ClaimedSeenMap) {
  localStorage.setItem(CLAIMED_INBOX_SEEN_KEY, JSON.stringify(map));
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

function domainFromAddress(address: string, domains: readonly string[]): Domain | null {
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  const d = address.slice(at + 1);
  return domains.includes(d) ? d : null;
}

export default function TempMailApp() {
  const prefersReducedMotion = usePrefersReducedMotion();

  const [availableDomains, setAvailableDomains] = useState<Domain[]>(DEFAULT_DOMAINS);
  const [selectedDomain, setSelectedDomain] = useState<Domain | null>(DEFAULT_DOMAINS[0] ?? null);
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
  const [ownedInboxes, setOwnedInboxes] = useState<OwnedInbox[]>([]);
  const [loadingOwnedInboxes, setLoadingOwnedInboxes] = useState(false);
  const [selectedClaimedAddress, setSelectedClaimedAddress] = useState<string | null>(null);
  const [claimedSeenMap, setClaimedSeenMap] = useState<ClaimedSeenMap>({});
  const [deletingOwnedAddress, setDeletingOwnedAddress] = useState<string | null>(null);

  useEffect(() => {
    if (!activeId && emails[0]?.id) setActiveId(emails[0].id);
  }, [activeId, emails]);

  const active = useMemo(() => emails.find((e) => e.id === activeId) ?? null, [emails, activeId]);
  const selectedClaimedInbox = useMemo(
    () => ownedInboxes.find((inbox) => inbox.address === selectedClaimedAddress) ?? ownedInboxes[0] ?? null,
    [ownedInboxes, selectedClaimedAddress],
  );

  const heroRef = useRef<HTMLDivElement | null>(null);
  const creatingGuestInboxRef = useRef(false);

  useEffect(() => {
    setClaimedSeenMap(readClaimedSeenMap());
  }, []);

  useEffect(() => {
    if (ownedInboxes.length === 0) {
      if (selectedClaimedAddress !== null) setSelectedClaimedAddress(null);
      return;
    }

    const hasSelected = selectedClaimedAddress
      ? ownedInboxes.some((inbox) => inbox.address === selectedClaimedAddress)
      : false;

    if (hasSelected) return;

    if (address && ownedInboxes.some((inbox) => inbox.address === address)) {
      setSelectedClaimedAddress(address);
      return;
    }

    setSelectedClaimedAddress(ownedInboxes[0].address);
  }, [ownedInboxes, address, selectedClaimedAddress]);

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

  const loadAvailableDomains = useCallback(async () => {
    try {
      const domains = await listAvailableDomains();
      if (domains.length > 0) {
        setAvailableDomains(domains);
      }
    } catch {
      // fallback domains stay in place
    }
  }, []);

  const loadProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase.from("profiles").select("display_name").eq("id", userId).maybeSingle();
    if (error) {
      setProfileName(null);
      return;
    }
    setProfileName(data?.display_name ?? null);
  }, []);

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((event, currentSession) => {
      setSession(currentSession);
      const nextUser = currentSession?.user ?? null;
      setUser(nextUser);
      setAuthReady(true);

      if (event === "SIGNED_OUT") {
        clearSavedInbox();
        setAddress(null);
        setToken(null);
        setExpiresAt(null);
        setEmails([]);
        setActiveId(null);
        setLocalPart("");
      }

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

      const latestSeenTs = res.messages[0]?.receivedAt ?? Date.now();
      setClaimedSeenMap((prev) => {
        if ((prev[address] ?? 0) >= latestSeenTs) return prev;
        const next = { ...prev, [address]: latestSeenTs };
        writeClaimedSeenMap(next);
        return next;
      });
    } catch (e: any) {
      toast.error("Couldn't load inbox", { description: e?.message ?? "Please try again." });
    } finally {
      setLoadingMessages(false);
    }
  }, [address, token]);

  const refreshOwnedInboxes = useCallback(async () => {
    if (!user) {
      setOwnedInboxes([]);
      return;
    }

    setLoadingOwnedInboxes(true);
    try {
      const inboxes = await listOwnedInboxes();
      setOwnedInboxes(inboxes);
    } catch (e: any) {
      toast.error("Couldn't load claimed emails", { description: e?.message ?? "Please try again." });
    } finally {
      setLoadingOwnedInboxes(false);
    }
  }, [user]);

  const openClaimedInbox = async (claimedInbox: OwnedInbox) => {
    const [claimedLocalPart, claimedDomain] = claimedInbox.address.split("@");
    if (!claimedLocalPart || !claimedDomain || !availableDomains.includes(claimedDomain)) {
      toast.error("Invalid claimed address", { description: "That address can't be opened." });
      return;
    }

    setLoadingInbox(true);
    try {
      const created = await createInbox({ domain: claimedDomain as Domain, localPart: claimedLocalPart });
      setAddress(created.address);
      setToken(created.token);
      setExpiresAt(created.expiresAt);
      setSelectedDomain(claimedDomain as Domain);
      saveInbox(created);
      const res = await listMessages({ address: created.address, token: created.token });
      setEmails(res.messages);
      setExpiresAt(res.expiresAt);
      setActiveId(res.messages[0]?.id ?? null);

      const seenTs = claimedInbox.latestReceivedAt ? Date.parse(claimedInbox.latestReceivedAt) : Date.now();
      setClaimedSeenMap((prev) => {
        const next = { ...prev, [created.address]: seenTs };
        writeClaimedSeenMap(next);
        return next;
      });

      toast.success("Claimed inbox opened", { description: created.address });
    } catch (e: any) {
      toast.error("Couldn't open claimed inbox", { description: e?.message ?? "Please try again." });
    } finally {
      setLoadingInbox(false);
    }
  };

  const handleDeleteOwnedInbox = async (claimedAddress: string) => {
    setDeletingOwnedAddress(claimedAddress);
    try {
      await deleteOwnedInbox({ address: claimedAddress });

      if (address === claimedAddress) {
        clearSavedInbox();
        setAddress(null);
        setToken(null);
        setExpiresAt(null);
        setEmails([]);
        setActiveId(null);
      }

      setClaimedSeenMap((prev) => {
        if (!(claimedAddress in prev)) return prev;
        const next = { ...prev };
        delete next[claimedAddress];
        writeClaimedSeenMap(next);
        return next;
      });

      await refreshOwnedInboxes();
      toast.success("Claimed address deleted", { description: claimedAddress });
    } catch (e: any) {
      toast.error("Couldn't delete claimed address", { description: e?.message ?? "Please try again." });
    } finally {
      setDeletingOwnedAddress(null);
    }
  };

  const copyClaimedAddress = async (claimedAddress: string) => {
    try {
      await navigator.clipboard.writeText(claimedAddress);
      toast.success("Copied address", { description: claimedAddress });
    } catch {
      toast.error("Couldn't copy", { description: "Your browser blocked clipboard access." });
    }
  };

  const handleClaimedAddressSelect = async (nextAddress: string) => {
    setSelectedClaimedAddress(nextAddress);
    const nextInbox = ownedInboxes.find((inbox) => inbox.address === nextAddress);
    if (!nextInbox) return;
    await openClaimedInbox(nextInbox);
  };

  const ensureInbox = async () => {
    setLoadingInbox(true);
    try {
      const saved = loadSavedInbox();
      if (saved) {
        setAddress(saved.address);
        setToken(saved.token);
        setExpiresAt(saved.expiresAt);
        const d = domainFromAddress(saved.address, availableDomains);
        if (d) setSelectedDomain(d);
      }
    } finally {
      setLoadingInbox(false);
    }
  };

  useEffect(() => {
    if (!authReady || loadingInbox || user || address || creatingGuestInboxRef.current) return;

    const domain = selectedDomain ?? availableDomains[0];
    if (!selectedDomain && domain) setSelectedDomain(domain);

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
    if (!authReady) return;
    if (!user) {
      setOwnedInboxes([]);
      return;
    }
    void refreshOwnedInboxes();
  }, [authReady, user, refreshOwnedInboxes]);

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

      const reclaimToken = chosenLocalPart ? getKnownInboxToken(`${chosenLocalPart}@${selectedDomain}`) ?? undefined : undefined;
      const created = await createInbox({ domain: selectedDomain, localPart: chosenLocalPart, reclaimToken });
      setAddress(created.address);
      setToken(created.token);
      setExpiresAt(created.expiresAt);
      saveInbox(created);
      setLocalPart("");
      toast.success("Email created", { description: created.address });
      if (user) await refreshOwnedInboxes();
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
      if (user) await refreshOwnedInboxes();
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
    const targetDomain = selectedDomain ?? (address ? domainFromAddress(address, availableDomains) : null);
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
      if (user) await refreshOwnedInboxes();
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
        {isLoggedIn ? (
          <Card className="mb-4">
            <div className="border-b p-4">
              <div className="text-sm font-medium">Claimed email addresses</div>
              <div className="text-xs text-muted-foreground">Addresses tied to your account</div>
            </div>
            <div className="p-4">
              {loadingOwnedInboxes ? (
                <div className="text-sm text-muted-foreground">Loading claimed addresses...</div>
              ) : ownedInboxes.length === 0 || !selectedClaimedInbox ? (
                <div className="text-sm text-muted-foreground">No claimed addresses yet.</div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedClaimedInbox.address}
                      onValueChange={(value) => void handleClaimedAddressSelect(value)}
                      disabled={loadingInbox || deletingOwnedAddress === selectedClaimedInbox.address}
                    >
                      <SelectTrigger className="flex-1 text-mono">
                        <SelectValue placeholder="Pick claimed email" />
                      </SelectTrigger>
                      <SelectContent>
                        {ownedInboxes.map((inbox) => {
                          const latestReceivedAtTs = inbox.latestReceivedAt ? Date.parse(inbox.latestReceivedAt) : 0;
                          const seenTs = claimedSeenMap[inbox.address] ?? 0;
                          const hasUnread = latestReceivedAtTs > seenTs;
                          return (
                            <SelectItem key={inbox.address} value={inbox.address} className="text-mono">
                              {hasUnread ? `${inbox.address} • Unread` : inbox.address}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      disabled={deletingOwnedAddress === selectedClaimedInbox.address}
                      onClick={() => void copyClaimedAddress(selectedClaimedInbox.address)}
                      aria-label={`Copy ${selectedClaimedInbox.address}`}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      disabled={deletingOwnedAddress === selectedClaimedInbox.address}
                      onClick={() => void handleDeleteOwnedInbox(selectedClaimedInbox.address)}
                      aria-label={`Delete ${selectedClaimedInbox.address}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>
        ) : null}

        <section className="grid gap-4 md:grid-cols-12">
          <Card className="md:col-span-5">
            <div className="flex items-center justify-between gap-4 border-b p-4">
              <div>
                <div className="text-sm font-medium">Inbox</div>
                <div className="text-xs text-muted-foreground">{emails.length} message(s)</div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={receiveTestEmail} disabled={loadingInbox || !address}>
                  <Inbox /> Receive
                </Button>
                <Button variant="outline" size="sm" onClick={() => void refreshMessages()} disabled={loadingMessages || !address}>
                  Refresh
                </Button>
              </div>
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
