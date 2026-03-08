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

export async function createInbox(input?: {
  domain?: string;
  localPart?: string;
  reclaimToken?: string;
}): Promise<CreateInboxResponse> {
  const { data, error } = await supabase.functions.invoke<CreateInboxResponse>("temp-mail-create-inbox", {
    body: { domain: input?.domain, localPart: input?.localPart, reclaimToken: input?.reclaimToken },
  });
  if (error) throw error;
  if (!data?.address || !data?.token || !data?.expiresAt) throw new Error("Invalid response");
  return data;
}

function decodeBase64Utf8(input: string) {
  try {
    const binary = atob(input.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return input;
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

  const mimeBase64 = raw.match(/Content-Transfer-Encoding:\s*base64[\s\S]*?\n\n([A-Za-z0-9+/=\n\r]+)(?:\n--|$)/i)?.[1];
  if (mimeBase64) {
    const decoded = decodeBase64Utf8(mimeBase64);
    if (decoded !== mimeBase64) {
      const text = /<[^>]+>/.test(decoded) ? htmlToText(decoded) : decoded.trim();
      if (text) return text;
    }
  }

  const compact = raw.replace(/\s+/g, "");
  if (compact.length > 120 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
    const decoded = decodeBase64Utf8(compact);
    if (decoded !== raw) {
      const text = /<[^>]+>/.test(decoded) ? htmlToText(decoded) : decoded.trim();
      if (text) return text;
    }
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
