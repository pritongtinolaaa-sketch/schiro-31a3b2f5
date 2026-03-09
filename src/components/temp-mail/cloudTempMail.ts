import { supabase } from "@/integrations/supabase/client";

export type TempMailMessage = {
  id: string;
  from: string;
  subject: string;
  preview: string;
  receivedAt: number; // epoch ms
  body: string;
};

type CreateInboxResponse = {
  address: string;
  token: string;
  expiresAt: string;
};

type ListMessagesResponse = {
  messages: TempMailMessage[];
  expiresAt: string;
};

export type OwnedInbox = {
  address: string;
  createdAt: string;
  expiresAt: string;
  latestReceivedAt: string | null;
};

const STORAGE_KEY = "temp_mail_inbox_v1";
const HISTORY_KEY = "temp_mail_inbox_history_v1";

type SavedInbox = { address: string; token: string; expiresAt: string };

function readInboxHistory(): Record<string, Omit<SavedInbox, "address">> {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Omit<SavedInbox, "address">>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeInboxHistory(history: Record<string, Omit<SavedInbox, "address">>) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

export function getKnownInboxToken(address: string): string | null {
  const history = readInboxHistory();
  const known = history[address];
  if (!known?.token) return null;
  return known.token;
}

export function loadSavedInbox(): SavedInbox | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedInbox;
    if (!parsed?.address || !parsed?.token || !parsed?.expiresAt) return null;

    if (Date.parse(parsed.expiresAt) <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveInbox(input: SavedInbox) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(input));
  const history = readInboxHistory();
  history[input.address] = { token: input.token, expiresAt: input.expiresAt };
  writeInboxHistory(history);
}

export function clearSavedInbox() {
  localStorage.removeItem(STORAGE_KEY);
}

async function getFunctionAuthHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const accessToken = session?.access_token?.trim();
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : null;
}

export async function createInbox(input?: {
  domain?: string;
  localPart?: string;
  reclaimToken?: string;
}): Promise<CreateInboxResponse> {
  const headers = await getFunctionAuthHeaders();
  const { data, error } = await supabase.functions.invoke<CreateInboxResponse>("temp-mail-create-inbox", {
    body: { domain: input?.domain, localPart: input?.localPart, reclaimToken: input?.reclaimToken },
    ...(headers ? { headers } : {}),
  });
  if (error) throw error;
  if (!data?.address || !data?.token || !data?.expiresAt) throw new Error("Invalid response");
  return data;
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

function decodeBase64Utf8(input: string) {
  try {
    const compact = input.replace(/[^A-Za-z0-9+/=_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (compact.length < 40) return null;

    const binary = atob(compact.padEnd(Math.ceil(compact.length / 4) * 4, "="));

    for (let i = 0; i < binary.length; i += 1) {
      const code = binary.charCodeAt(i);
      if (code === 0 || (code < 9 || (code > 13 && code < 32))) return null;
    }

    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
    return readabilityScore(decoded) >= 0.7 ? decoded : null;
  } catch {
    return null;
  }
}

function htmlToText(input: string) {
  return input
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
}

function normalizeIncomingBody(body: string) {
  const raw = String(body ?? "").trim();
  if (!raw) return "";

  if (/<[^>]+>/.test(raw)) {
    const text = htmlToText(raw);
    if (text) return text;
  }

  const compact = raw.replace(/\s+/g, "");
  if (compact.length > 120 && /^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    const decoded = decodeBase64Utf8(compact);
    if (decoded) {
      return /<[^>]+>/.test(decoded) ? htmlToText(decoded) : decoded;
    }
    return "Message body is encoded/binary and could not be decoded safely.";
  }

  if (readabilityScore(raw) < 0.5) {
    return "Message body is encoded/binary and could not be decoded safely.";
  }

  return raw;
}

export async function listMessages(input: { address: string; token: string }): Promise<ListMessagesResponse> {
  const { data, error } = await supabase.functions.invoke<ListMessagesResponse>("temp-mail-list-messages", {
    body: input,
  });
  if (error) throw error;
  if (!data?.messages) throw new Error("Invalid response");

  const messages = data.messages.map((message) => {
    const body = normalizeIncomingBody(message.body);
    const preview = body.split("\n").find((line) => line.trim().length > 0)?.trim() ?? message.preview;
    return { ...message, body, preview };
  });

  return { ...data, messages };
}

export async function sendTestEmail(input: { address: string; token: string }) {
  const { error } = await supabase.functions.invoke("temp-mail-send-test", { body: input });
  if (error) throw error;
}

export async function deleteMessage(input: { address: string; token: string; messageId: string }) {
  const { error } = await supabase.functions.invoke("temp-mail-delete-message", { body: input });
  if (error) throw error;
}

export async function clearInboxRemote(input: { address: string; token: string }) {
  const { error } = await supabase.functions.invoke("temp-mail-clear-inbox", { body: input });
  if (error) throw error;
}

export async function deleteOwnedInbox(input: { address: string }) {
  const { error } = await supabase.functions.invoke("temp-mail-delete-owned-inbox", { body: input });
  if (error) throw error;
}

export async function listOwnedInboxes(): Promise<OwnedInbox[]> {
  const { data, error } = await supabase.functions.invoke<{ inboxes: OwnedInbox[] }>("temp-mail-list-owned-inboxes");
  if (error) throw error;
  return data?.inboxes ?? [];
}

export async function listAvailableDomains(): Promise<string[]> {
  const { data, error } = await supabase.functions.invoke<{ domains: string[] }>("temp-mail-list-domains");
  if (error) throw error;
  return data?.domains ?? [];
}

export function subscribeToInbox(address: string, onNewMail: () => void) {
  const channel = supabase
    .channel(`inbox:${address}`)
    .on("broadcast", { event: "new_mail" }, () => onNewMail())
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
