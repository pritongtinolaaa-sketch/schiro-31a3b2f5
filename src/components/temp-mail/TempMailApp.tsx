import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { toast } from "sonner";
import { Copy, Inbox, Mail, Shield, Sparkles, Trash2 } from "lucide-react";

import { lovable } from "@/integrations/lovable";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  "schiromail.indevs.in",
  "dollicons.com",
];
const CLAIMED_INBOX_SEEN_KEY = "temp_mail_claimed_seen_v1";
const AUTO_REFRESH_SECONDS = 15;
const OWNER_USER_ID = "fD11RMWDuvYFY2I0yBSTKXUj4d23";

const DOMAIN_NOTES: Record<string, string> = {
  "inboxkitten.com": "Public inbox, auto-deletes quickly (best for testing only).",
  "mailsac.com": "Public/testing inbox with limited retention depending on provider policy.",
  "catchmail.io": "Public/testing inbox with limited retention depending on provider policy.",
  "mailistry.com": "Public/testing inbox with limited retention depending on provider policy.",
  "zeppost.com": "Public/testing inbox with limited retention depending on provider policy.",
};

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

function readabilityScore(input: string) {
  if (!input) return 0;
  let readable = 0;
  let invalid = 0;

  for (const ch of input) {
    const code = ch.charCodeAt(0);
    const isWhitespace = ch === "\n" || ch === "\r" || ch === "\t";
    const isPrintableAscii = code >= 32 && code <= 126;
    const isCommonUnicode = code >= 0xa0 && ch !== "�";

    if (ch === "�" || (code < 32 && !isWhitespace) || code === 127) {
      invalid += 1;
      continue;
    }

    if (isWhitespace || isPrintableAscii || isCommonUnicode) readable += 1;
  }

  const total = readable + invalid;
  return total > 0 ? readable / total : 0;
}

function decodeBodyForDisplay(input: string) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  const toText = (value: string) =>
    value
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  if (/<[^>]+>/.test(raw)) {
    const text = toText(raw);
    if (text) return text;
  }

  const compact = raw.replace(/\s+/g, "");
  if (compact.length > 120 && /^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    return "Message body is encoded/binary and could not be decoded safely.";
  }

  if (readabilityScore(raw) < 0.5) {
    return "Message body is encoded/binary and could not be decoded safely.";
  }

  return raw;
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

function isUnauthorizedError(error: unknown) {
  const anyError = error as { message?: string; status?: number; context?: { status?: number } };
  const status = Number(anyError?.context?.status ?? anyError?.status);
  if (status === 401) return true;
  return /\b401\b|unauthorized/i.test(String(anyError?.message ?? ""));
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
  const [refreshCountdown, setRefreshCountdown] = useState(AUTO_REFRESH_SECONDS);

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

  const recoverClaimedInboxAfterUnauthorized = useCallback(async () => {
    if (!user || !selectedClaimedInbox) return false;

    const [claimedLocalPart, claimedDomain] = selectedClaimedInbox.address.split("@");
    if (!claimedLocalPart || !claimedDomain || !availableDomains.includes(claimedDomain as Domain)) return false;

    try {
      const recreated = await createInbox({ domain: claimedDomain as Domain, localPart: claimedLocalPart });
      setAddress(recreated.address);
      setToken(recreated.token);
      setExpiresAt(recreated.expiresAt);
      setSelectedDomain(claimedDomain as Domain);
      saveInbox(recreated);

      const res = await listMessages({ address: recreated.address, token: recreated.token });
      setEmails(res.messages);
      setExpiresAt(res.expiresAt);
      setActiveId(res.messages[0]?.id ?? null);
      return true;
    } catch {
      return false;
    }
  }, [user, selectedClaimedInbox, availableDomains]);

  const heroRef = useRef<HTMLDivElement | null>(null);
  const inboxSectionRef = useRef<HTMLElement | null>(null);
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

  const getDomainNote = useCallback((domain: Domain | null) => {
    if (!domain) return null;
    return DOMAIN_NOTES[domain] ?? null;
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
    if (!domain) return;
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
  }, [authReady, loadingInbox, user, address, selectedDomain, availableDomains]);

  useEffect(() => {
    if (!authReady) return;
    if (!user) {
      setOwnedInboxes([]);
      return;
    }
    void refreshOwnedInboxes();
  }, [authReady, user, refreshOwnedInboxes]);

  useEffect(() => {
    void loadAvailableDomains();
  }, [loadAvailableDomains]);

  useEffect(() => {
    if (selectedDomain && availableDomains.includes(selectedDomain)) return;
    setSelectedDomain(availableDomains[0] ?? null);
  }, [availableDomains, selectedDomain]);

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
    if (!address || !token) {
      setRefreshCountdown(AUTO_REFRESH_SECONDS);
      return;
    }

    setRefreshCountdown(AUTO_REFRESH_SECONDS);

    const countdownId = window.setInterval(() => {
      setRefreshCountdown((prev) => (prev <= 1 ? AUTO_REFRESH_SECONDS : prev - 1));
    }, 1000);

    const intervalId = window.setInterval(() => {
      void refreshMessages({ silent: true });
      setRefreshCountdown(AUTO_REFRESH_SECONDS);
    }, AUTO_REFRESH_SECONDS * 1000);

    return () => {
      window.clearInterval(countdownId);
      window.clearInterval(intervalId);
    };
  }, [address, token, refreshMessages]);

  const handleManualRefresh = useCallback(() => {
    setRefreshCountdown(AUTO_REFRESH_SECONDS);
    void refreshMessages();
  }, [refreshMessages]);

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
      if (user) setSelectedClaimedAddress(created.address);
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
      if (user) setSelectedClaimedAddress(created.address);
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

  const scrollToInbox = () => {
    inboxSectionRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "start",
    });
  };

  const isLoggedIn = Boolean(session);
  const profileLabel =
    profileName ??
    String(user?.user_metadata?.username ?? user?.user_metadata?.display_name ?? user?.email?.split("@")[0] ?? "Profile");
  const isOwner =
    (session?.user.id != null && session.user.id === OWNER_USER_ID) || profileLabel.trim().toLowerCase() === "schiro";

  return (
    <div className="min-h-screen overflow-x-hidden">
      <nav className="sticky top-0 z-50 border-b bg-background/85 backdrop-blur-md">
        <div className="container max-w-6xl flex min-h-14 flex-wrap items-center justify-between gap-2 px-3 py-2 sm:flex-nowrap sm:gap-3 sm:px-8 sm:py-0">
          <div className="inline-flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Mail className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold tracking-wide">schiromail</span>
          </div>

          {isLoggedIn ? (
            <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto sm:gap-3">
              <span className="max-w-[96px] truncate text-sm text-muted-foreground sm:max-w-[180px]">{profileLabel}</span>
              {isOwner ? (
                <Badge
                  className="relative hidden overflow-hidden border-primary bg-primary/30 px-2.5 py-1 text-[10px] font-bold tracking-[0.16em] text-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.95),0_0_18px_hsl(var(--primary)/0.95),0_0_38px_hsl(var(--primary)/0.9),0_0_64px_hsl(var(--primary)/0.7)] before:pointer-events-none before:absolute before:inset-0 before:bg-[linear-gradient(120deg,transparent_0%,hsl(var(--primary-foreground)/0.35)_38%,transparent_62%),radial-gradient(circle_at_20%_30%,hsl(var(--primary-foreground)/0.58),transparent_35%),radial-gradient(circle_at_80%_70%,hsl(var(--accent-foreground)/0.48),transparent_32%)] before:opacity-95 before:mix-blend-screen motion-safe:animate-pulse max-[380px]:hidden sm:inline-flex"
                  variant="outline"
                >
                  OWNER
                </Badge>
              ) : null}
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
        <div className="container relative max-w-6xl px-3 py-8 sm:px-8 md:py-10">
          <div className="grid gap-6 md:grid-cols-12 md:items-start">
            <div className="md:col-span-7 relative md:pb-24">
              <div className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs text-muted-foreground shadow-elev">
                <Sparkles className="h-3.5 w-3.5" />
                <span>Real inbox • persisted • realtime updates</span>
              </div>
              <h1 className="mt-4 text-balance text-3xl font-semibold tracking-tight md:text-4xl xl:text-5xl">
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
                <Button variant="secondary" onClick={handleManualRefresh} disabled={loadingMessages || !address}>
                  Refresh
                </Button>
                <span className="text-xs text-muted-foreground">Auto-refresh: {address && token ? `${refreshCountdown}s` : "—"}</span>
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

              <div className="mt-10 md:absolute md:bottom-0 md:left-0 md:mt-0 md:w-[30rem] md:max-w-[92%]">
                <div className="rounded-lg border bg-background/60 p-3 text-xs text-muted-foreground">
                  Tip: Create an email first, then press “Receive” to deliver a real test message.
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="hero" size="lg" className="mt-2 w-full text-sm font-semibold tracking-wide">
                      Check out my other sites
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[min(22rem,calc(100vw-1.5rem))] p-0" align="center">
                    <Card className="border-0 shadow-none">
                      <div className="space-y-3 p-4">
                        <div className="text-sm font-semibold">Visit my other projects</div>
                        <div className="grid gap-2">
                          <Button
                            asChild
                            variant="hero"
                            className="w-full justify-start whitespace-normal break-words text-left shadow-elev transition-[transform,box-shadow,filter] duration-200 hover:-translate-y-0.5 hover:shadow-glow hover:brightness-110 active:translate-y-0.5"
                          >
                            <a href="https://schiro.eu.cc" target="_blank" rel="noopener noreferrer">
                              Schiro Cookie Checker - Netflix Checker
                            </a>
                          </Button>
                          <Button
                            asChild
                            variant="hero"
                            className="w-full justify-start whitespace-normal break-words text-left shadow-elev transition-[transform,box-shadow,filter] duration-200 hover:-translate-y-0.5 hover:shadow-glow hover:brightness-110 active:translate-y-0.5"
                          >
                            <a href="https://schiropaste.lovable.app" target="_blank" rel="noopener noreferrer">
                              Schiropaste - Paste and Share
                            </a>
                          </Button>
                        </div>
                      </div>
                    </Card>
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="md:col-span-5">
              <InboxCreatorCard
                loadingInbox={loadingInbox}
                address={address}
                expiresAt={expiresAt}
                domains={availableDomains}
                selectedDomain={selectedDomain}
                onSelectedDomainChange={setSelectedDomain}
                localPart={localPart}
                onLocalPartChange={setLocalPart}
                onCreate={() => void createEmail()}
                onRegenerate={() => void regenerate()}
                onCopy={() => void copyAddress()}
                onClear={() => void clearInbox()}
                onGoToInbox={scrollToInbox}
                getDomainNote={getDomainNote}
              />
            </div>
          </div>
        </div>
      </header>

      <main className="container max-w-6xl px-3 py-6 sm:px-8 md:py-8">
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
                  <div className="min-w-0 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Select
                      value={selectedClaimedInbox.address}
                      onValueChange={(value) => void handleClaimedAddressSelect(value)}
                      disabled={loadingInbox || deletingOwnedAddress === selectedClaimedInbox.address}
                    >
                      <SelectTrigger className="min-w-0 w-full max-w-full flex-1 text-mono">
                        <SelectValue placeholder="Pick claimed email" />
                      </SelectTrigger>
                      <SelectContent>
                        {ownedInboxes.map((inbox) => {
                          const latestReceivedAtTs = inbox.latestReceivedAt ? Date.parse(inbox.latestReceivedAt) : 0;
                          const seenTs = claimedSeenMap[inbox.address] ?? 0;
                          const hasUnread = latestReceivedAtTs > seenTs;
                          return (
                            <SelectItem key={inbox.address} value={inbox.address} className="max-w-[calc(100vw-3rem)] text-mono">
                              {hasUnread ? `${inbox.address} • Unread` : inbox.address}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center justify-end gap-2">
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
                </div>
              )}
            </div>
          </Card>
        ) : null}

        <section ref={inboxSectionRef} className="grid gap-3 md:grid-cols-12">
          <Card className="md:col-span-5">
            <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium">Inbox</div>
                <div className="text-xs text-muted-foreground">{emails.length} message(s)</div>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1 sm:flex-none"
                  onClick={receiveTestEmail}
                  disabled={loadingInbox || !address}
                >
                  <Inbox /> Receive
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 sm:flex-none"
                  onClick={handleManualRefresh}
                  disabled={loadingMessages || !address}
                >
                  Refresh
                </Button>
                <span className="w-full text-xs text-muted-foreground sm:w-auto">Auto-refresh: {address && token ? `${refreshCountdown}s` : "—"}</span>
              </div>
            </div>

            <div className="max-h-[52vh] overflow-auto md:max-h-[460px]">
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
            <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">Message</div>
                <div className="truncate text-xs text-muted-foreground text-mono">{address ?? "—"}</div>
              </div>
              <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => void deleteActive()} disabled={!active}>
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
                    <pre className="m-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-relaxed text-foreground">{decodeBodyForDisplay(active.body)}</pre>
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

        <footer className="mt-8 border-t pt-6 text-center text-xs text-muted-foreground">
          <p>© Schiro 2026</p>
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
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleGoogleSignIn()}
                disabled={authLoading}
                className="gap-2"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" focusable="false">
                  <path
                    fill="currentColor"
                    d="M21.6 12.23c0-.68-.06-1.33-.17-1.96H12v3.71h5.39a4.62 4.62 0 0 1-2 3.04v2.52h3.23c1.89-1.74 2.98-4.3 2.98-7.31Z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 22c2.7 0 4.96-.9 6.61-2.46l-3.23-2.52c-.9.6-2.04.95-3.38.95-2.6 0-4.8-1.75-5.58-4.1H3.07v2.58A10 10 0 0 0 12 22Z"
                  />
                  <path
                    fill="currentColor"
                    d="M6.42 13.87a5.99 5.99 0 0 1 0-3.74V7.55H3.07a10 10 0 0 0 0 8.9l3.35-2.58Z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 6.03c1.47 0 2.8.5 3.85 1.5l2.88-2.88C16.95 2.98 14.7 2 12 2a10 10 0 0 0-8.93 5.55l3.35 2.58c.78-2.35 2.98-4.1 5.58-4.1Z"
                  />
                </svg>
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
