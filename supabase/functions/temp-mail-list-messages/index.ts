// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CATCHMAIL_DOMAINS = new Set(["catchmail.io", "mailistry.com", "zeppost.com"]);
const MAILSAC_DOMAINS = new Set(["mailsac.com"]);
const INBOXKITTEN_DOMAINS = new Set(["inboxkitten.com"]);

function base64Url(bytes: Uint8Array) {
  const str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(digest));
}

function domainFromAddress(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).trim().toLowerCase();
}

function isCatchmailAddress(address: string) {
  return CATCHMAIL_DOMAINS.has(domainFromAddress(address));
}

function isMailsacAddress(address: string) {
  return MAILSAC_DOMAINS.has(domainFromAddress(address));
}

function isInboxKittenAddress(address: string) {
  return INBOXKITTEN_DOMAINS.has(domainFromAddress(address));
}

function getMailsacHeaders() {
  const apiKey = Deno.env.get("MAILSAC_API_KEY")?.trim();
  return apiKey ? { "Mailsac-Key": apiKey } : {};
}

function decodeQuotedPrintable(input: string) {
  const normalized = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "=" && /^[A-Fa-f0-9]{2}$/.test(normalized.slice(i + 1, i + 3))) {
      bytes.push(parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(ch.charCodeAt(0));
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

function repairMojibakeUtf8(input: string) {
  if (!input) return "";
  const bytes = Uint8Array.from(input, (ch) => ch.charCodeAt(0) & 0xff);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function readabilityScore(input: string) {
  if (!input) return 0;
  let readable = 0;
  let unreadable = 0;

  for (const ch of input) {
    const code = ch.charCodeAt(0);
    const isPrintableAscii = code >= 32 && code <= 126;
    const isWhitespace = ch === "\n" || ch === "\r" || ch === "\t";
    const isCommonUnicode = code >= 0xa0 && ch !== "�";
    const isControl = code < 32 && !isWhitespace;

    if (isControl || code === 127 || ch === "�") {
      unreadable += 1;
      continue;
    }

    if (isPrintableAscii || isWhitespace || isCommonUnicode) {
      readable += 1;
    } else {
      unreadable += 1;
    }
  }

  const total = readable + unreadable;
  return total > 0 ? readable / total : 0;
}

function pickBestReadable(candidates: string[], minScore = 0.6) {
  const ranked = Array.from(
    new Set(candidates.map((value) => String(value ?? "").trim()).filter(Boolean)),
  )
    .map((value) => ({ value, score: readabilityScore(value) }))
    .sort((a, b) => (b.score === a.score ? b.value.length - a.value.length : b.score - a.score));

  const best = ranked[0];
  if (!best || best.score < minScore) return null;
  return best.value;
}

function decodeBase64(input: string): string | null {
  try {
    const compact = input.replace(/[^A-Za-z0-9+/=_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!compact || compact.length < 16) return null;

    const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));

    const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
    const latin1 = binary.trim();
    const repaired = repairMojibakeUtf8(latin1).trim();

    return pickBestReadable([utf8, repaired, latin1], 0.45);
  } catch {
    return null;
  }
}

function decodeHtmlEntities(input: string) {
  return input
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([A-Fa-f0-9]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function looksLikeHtml(input: string) {
  return /<!doctype\s+html/i.test(input) || /<html[\s>]/i.test(input) || /<body[\s>]/i.test(input) || /<\/\w+>/.test(input);
}

function htmlToText(input: string) {
  return decodeHtmlEntities(
    input
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function splitHeadersAndBody(part: string) {
  const normalized = part.replace(/\r\n/g, "\n");
  const idx = normalized.indexOf("\n\n");
  if (idx === -1) return { headersRaw: "", bodyRaw: normalized };
  return {
    headersRaw: normalized.slice(0, idx),
    bodyRaw: normalized.slice(idx + 2),
  };
}

function parseHeaders(headersRaw: string) {
  const result: Record<string, string> = {};
  let currentKey = "";

  for (const line of headersRaw.split("\n")) {
    if (/^[ \t]/.test(line) && currentKey) {
      result[currentKey] += ` ${line.trim()}`;
      continue;
    }

    const idx = line.indexOf(":");
    if (idx === -1) continue;
    currentKey = line.slice(0, idx).trim().toLowerCase();
    result[currentKey] = line.slice(idx + 1).trim();
  }

  return result;
}

function getBoundary(contentType: string) {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return (m?.[1] ?? m?.[2] ?? "").trim();
}

function decodeTransferEncoding(body: string, encoding: string) {
  const normalized = encoding.toLowerCase();
  if (normalized.includes("quoted-printable")) return decodeQuotedPrintable(body);
  if (normalized.includes("base64")) return decodeBase64(body);
  return body;
}

function collectReadableBodies(rawPart: string, plain: string[], html: string[], depth = 0) {
  if (depth > 8) return;

  const { headersRaw, bodyRaw } = splitHeadersAndBody(rawPart);
  const headers = parseHeaders(headersRaw);
  const hasExplicitContentType = Boolean(headers["content-type"]);
  const contentType = (headers["content-type"] ?? "text/plain").toLowerCase();
  const transferEncoding = headers["content-transfer-encoding"] ?? "";

  if (contentType.includes("multipart/")) {
    const boundary = getBoundary(contentType);
    if (!boundary) return;

    const token = `--${boundary}`;
    const parts = bodyRaw.split(token);

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === "--") continue;
      if (trimmed.startsWith("--")) continue;
      collectReadableBodies(trimmed, plain, html, depth + 1);
    }
    return;
  }

  const decoded = decodeTransferEncoding(bodyRaw, transferEncoding).trim();
  if (!decoded) return;

  const isReadable = readabilityScore(decoded) > 0.7;

  if (contentType.includes("text/plain")) {
    if (!hasExplicitContentType && looksLikeHtml(decoded)) {
      const text = htmlToText(decoded);
      if (text && readabilityScore(text) > 0.55) html.push(text);
      return;
    }

    if (isReadable) plain.push(decoded);
    return;
  }

  if (contentType.includes("text/html")) {
    const text = htmlToText(decoded);
    if (text && readabilityScore(text) > 0.55) html.push(text);
  }
}

function extractReadableBody(raw: string) {
  const normalized = String(raw ?? "").replace(/\r\n/g, "\n");
  const plain: string[] = [];
  const html: string[] = [];

  const firstLine = normalized.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.startsWith("--") && normalized.includes("Content-Transfer-Encoding")) {
    const boundary = firstLine.slice(2).trim();
    const token = `--${boundary}`;
    const parts = normalized.split(token);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === "--" || trimmed.startsWith("--")) continue;
      collectReadableBodies(trimmed, plain, html, 1);
    }
  } else {
    collectReadableBodies(normalized, plain, html);
  }

  if (plain.length > 0) return plain.join("\n\n").trim();
  if (html.length > 0) return html.join("\n\n").trim();

  const { bodyRaw } = splitHeadersAndBody(normalized);
  const fallback = decodeQuotedPrintable(bodyRaw).trim();
  if (!fallback) return normalized.trim();

  if (looksLikeHtml(fallback)) {
    const text = htmlToText(fallback);
    return text || fallback;
  }

  return decodeHtmlEntities(fallback).trim();
}

function looksLikeBase64Block(input: string) {
  const compact = input.replace(/\s+/g, "");
  return compact.length > 80 && /^[A-Za-z0-9+/=]+$/.test(compact);
}

function normalizeBody(input: unknown) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  const extracted = extractReadableBody(raw);
  if (looksLikeBase64Block(extracted)) {
    const decoded = decodeBase64(extracted);
    if (decoded !== extracted) {
      if (looksLikeHtml(decoded)) {
        const text = htmlToText(decoded).trim();
        if (text) return text;
      }
      return decodeHtmlEntities(decoded).trim();
    }
  }

  return extracted;
}

function decodeMessageBody(rawInput: unknown) {
  const raw = String(rawInput ?? "").trim();
  if (!raw) return "";

  const compact = raw.replace(/\s+/g, "");
  if (compact.length > 80 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
    const decoded = decodeBase64(raw);
    if (decoded && decoded !== raw) {
      if (looksLikeHtml(decoded)) {
        const text = htmlToText(decoded).trim();
        if (text) return text;
      }
      return decodeHtmlEntities(decoded).trim();
    }
  }

  return normalizeBody(raw);
}

function toMessageRow(row: any) {
  const body = decodeMessageBody(row.body);
  const previewLine = body.split("\n").find((l) => l.trim().length > 0) ?? body.slice(0, 80);
  return {
    id: row.id,
    from: row.from_address,
    subject: row.subject,
    preview: previewLine,
    receivedAt: new Date(row.received_at).getTime(),
    body,
  };
}

function toCatchmailMessageRow(row: any) {
  const dateInput = String(row?.date ?? row?.received_at ?? row?.created_at ?? "");
  const parsedTs = Date.parse(dateInput);
  const preview = String(row?.preview ?? row?.snippet ?? "").trim();
  const bodyText = normalizeBody(row?.body?.text ?? row?.body ?? "");

  return {
    id: String(row?.id ?? crypto.randomUUID()),
    from: String(row?.from ?? "unknown@sender"),
    subject: String(row?.subject ?? "(no subject)"),
    preview: preview || bodyText.slice(0, 120) || "No preview available",
    receivedAt: Number.isFinite(parsedTs) ? parsedTs : Date.now(),
    body: bodyText || preview || "Full message text is not available from this mailbox response.",
  };
}

function toMailsacMessageRow(address: string, row: any) {
  const dateInput = String(row?.received ?? row?.receivedAt ?? row?.created_at ?? row?.createdAt ?? "");
  const parsedTs = Date.parse(dateInput);
  const fromAddress =
    String(row?.from?.[0]?.address ?? row?.from?.address ?? row?.from ?? row?.sender ?? "unknown@sender") || "unknown@sender";
  const snippet = String(row?.snippet ?? row?.subject ?? "").trim();

  return {
    id: String(row?._id ?? row?.id ?? crypto.randomUUID()),
    from: fromAddress,
    subject: String(row?.subject ?? "(no subject)"),
    preview: snippet || "No preview available",
    receivedAt: Number.isFinite(parsedTs) ? parsedTs : Date.now(),
    body: snippet || `Open https://mailsac.com/inbox/${encodeURIComponent(address)} to view full content.`,
  };
}

async function listCatchmailMessages(address: string) {
  const url = `https://api.catchmail.io/api/v1/mailbox?address=${encodeURIComponent(address)}&page=1&page_size=100`;
  const response = await fetch(url, { method: "GET" });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`CatchMail mailbox lookup failed (${response.status}): ${details || "unknown error"}`);
  }

  const payload = await response.json().catch(() => ({}));
  const rows = Array.isArray(payload?.messages) ? payload.messages : [];

  return rows.map(toCatchmailMessageRow).sort((a, b) => b.receivedAt - a.receivedAt);
}

async function listMailsacMessages(address: string) {
  const url = `https://mailsac.com/api/addresses/${encodeURIComponent(address)}/messages`;
  const response = await fetch(url, { method: "GET", headers: getMailsacHeaders() });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Mailsac mailbox lookup failed (${response.status}): ${details || "unknown error"}`);
  }

  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows)) return [];

  return rows.map((row: any) => toMailsacMessageRow(address, row)).sort((a, b) => b.receivedAt - a.receivedAt);
}

async function listInboxKittenMessages(address: string) {
  const localPart = String(address.split("@")[0] ?? "").trim().toLowerCase();
  if (!localPart) return [];

  const listUrl = `https://inboxkitten.com/inbox/${encodeURIComponent(localPart)}/list`;
  const listResponse = await fetch(listUrl, { method: "GET" });
  if (!listResponse.ok) {
    const details = await listResponse.text().catch(() => "");
    throw new Error(`InboxKitten list lookup failed (${listResponse.status}): ${details || "unknown error"}`);
  }

  const listHtml = await listResponse.text();
  if (/there\s+for\s+no\s+messages\s+for\s+this\s+kitten/i.test(listHtml)) {
    return [];
  }

  const rawPaths = Array.from(listHtml.matchAll(/href="(\/inbox\/[^"]+)"/gi)).map((m) => m[1]).filter(Boolean) as string[];
  const messagePaths = Array.from(
    new Set(
      rawPaths.filter((path) => {
        if (!path.startsWith(`/inbox/${localPart}/`)) return false;
        if (path.endsWith("/list")) return false;
        return true;
      }),
    ),
  ).slice(0, 30);

  const messages = await Promise.all(
    messagePaths.map(async (path, index) => {
      const url = `https://inboxkitten.com${path}`;
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) return null;

      const html = await response.text();
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "(no subject)";
      const textBody = normalizeBody(
        html
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<br\s*\/?\s*>/gi, "\n")
          .replace(/<\/p\s*>/gi, "\n\n")
          .replace(/<[^>]+>/g, " "),
      );

      const id = path.split("/").filter(Boolean).join("-") || crypto.randomUUID();
      const preview = textBody.split("\n").find((line) => line.trim().length > 0) ?? "No preview available";

      return {
        id,
        from: `public@inboxkitten.com`,
        subject: decodeHtmlEntities(String(title).trim()) || "(no subject)",
        preview: preview.slice(0, 160),
        receivedAt: Date.now() - index * 1000,
        body: textBody || `Open ${url} to view the full message.`,
      };
    }),
  );

  return messages.filter(Boolean).sort((a, b) => b.receivedAt - a.receivedAt);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { address, token } = await req.json();
    if (!address || !token) {
      return new Response(JSON.stringify({ error: "Missing address/token" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const tokenHash = await sha256Base64Url(String(token));

    const { data: inbox, error: inboxError } = await supabase
      .from("temp_mail_inboxes")
      .select("id, expires_at")
      .eq("email_address", String(address))
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (inboxError) throw inboxError;
    if (!inbox) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (new Date(inbox.expires_at).getTime() <= Date.now()) {
      return new Response(JSON.stringify({ error: "Inbox expired" }), {
        status: 410,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (isCatchmailAddress(String(address))) {
      const messages = await listCatchmailMessages(String(address));
      return new Response(JSON.stringify({ messages, expiresAt: inbox.expires_at }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (isMailsacAddress(String(address))) {
      const messages = await listMailsacMessages(String(address));
      return new Response(JSON.stringify({ messages, expiresAt: inbox.expires_at }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (isInboxKittenAddress(String(address))) {
      const messages = await listInboxKittenMessages(String(address));
      return new Response(JSON.stringify({ messages, expiresAt: inbox.expires_at }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: rows, error: msgError } = await supabase
      .from("temp_mail_messages")
      .select("id, from_address, subject, body, received_at")
      .eq("inbox_id", inbox.id)
      .order("received_at", { ascending: false })
      .limit(200);

    if (msgError) throw msgError;

    return new Response(JSON.stringify({ messages: (rows ?? []).map(toMessageRow), expiresAt: inbox.expires_at }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
