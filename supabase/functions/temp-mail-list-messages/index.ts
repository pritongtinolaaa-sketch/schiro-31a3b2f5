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

function getMailsacHeaders() {
  const apiKey = Deno.env.get("MAILSAC_API_KEY")?.trim();
  return apiKey ? { "Mailsac-Key": apiKey } : {};
}

function decodeQuotedPrintable(input: string) {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
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

function normalizeBody(input: unknown) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const decoded = decodeQuotedPrintable(raw);
  if (looksLikeHtml(decoded)) {
    const text = htmlToText(decoded).trim();
    return text || decoded;
  }
  return decodeHtmlEntities(decoded).trim();
}

function toMessageRow(row: any) {
  const body = normalizeBody(row.body);
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
