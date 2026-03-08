// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-temp-mail-secret",
};

async function broadcastNewMail(opts: { supabaseUrl: string; serviceKey: string; topic: string }) {
  const url = `${opts.supabaseUrl}/realtime/v1/api/broadcast`;
  await fetch(url, {
    method: "POST",
    headers: {
      apikey: opts.serviceKey,
      Authorization: `Bearer ${opts.serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [{ topic: opts.topic, event: "new_mail", payload: { ok: true } }],
    }),
  });
}

function decodeQuotedPrintable(input: string) {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBase64(input: string) {
  try {
    const compact = input.replace(/\s+/g, "");
    return atob(compact);
  } catch {
    return input;
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

  if (contentType.includes("text/plain")) {
    plain.push(decoded);
    return;
  }

  if (contentType.includes("text/html")) {
    const text = htmlToText(decoded);
    if (text) html.push(text);
  }
}

function extractReadableBody(raw: string) {
  const normalized = String(raw ?? "").replace(/\r\n/g, "\n");
  const plain: string[] = [];
  const html: string[] = [];

  collectReadableBodies(normalized, plain, html);

  if (plain.length > 0) return plain.join("\n\n").trim();
  if (html.length > 0) return html.join("\n\n").trim();

  const { bodyRaw } = splitHeadersAndBody(normalized);
  const fallback = decodeQuotedPrintable(bodyRaw).trim();
  return fallback || normalized.trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const inboundSecret = Deno.env.get("TEMP_MAIL_INBOUND_SECRET") ?? "";
    const provided = req.headers.get("x-temp-mail-secret") ?? "";

    if (!inboundSecret || provided !== inboundSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { address, from, subject, body } = await req.json();
    if (!address || !from || !subject || body === undefined || body === null) {
      return new Response(JSON.stringify({ error: "Missing fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: inbox, error: inboxError } = await supabase
      .from("temp_mail_inboxes")
      .select("id, expires_at")
      .eq("email_address", String(address))
      .maybeSingle();

    if (inboxError) throw inboxError;
    if (!inbox) {
      return new Response(JSON.stringify({ error: "Inbox not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (new Date(inbox.expires_at).getTime() <= Date.now()) {
      return new Response(JSON.stringify({ error: "Inbox expired" }), {
        status: 410,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parsedBody = extractReadableBody(String(body));

    const { error: insertError } = await supabase.from("temp_mail_messages").insert({
      inbox_id: inbox.id,
      from_address: String(from),
      subject: String(subject),
      body: parsedBody || "(empty message)",
    });

    if (insertError) throw insertError;

    await broadcastNewMail({ supabaseUrl, serviceKey, topic: `inbox:${String(address)}` });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
