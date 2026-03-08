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

async function deleteCatchmailMessage(address: string, messageId: string) {
  const url = `https://api.catchmail.io/api/v1/message/${encodeURIComponent(messageId)}?mailbox=${encodeURIComponent(address)}`;
  const response = await fetch(url, { method: "DELETE" });

  if (!response.ok && response.status !== 204) {
    const details = await response.text().catch(() => "");
    throw new Error(`CatchMail delete failed (${response.status}): ${details || "unknown error"}`);
  }
}

async function deleteMailsacMessage(address: string, messageId: string) {
  const url = `https://mailsac.com/api/addresses/${encodeURIComponent(address)}/messages/${encodeURIComponent(messageId)}`;
  const response = await fetch(url, { method: "DELETE", headers: getMailsacHeaders() });

  if (!response.ok && response.status !== 204) {
    const details = await response.text().catch(() => "");
    throw new Error(`Mailsac delete failed (${response.status}): ${details || "unknown error"}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { address, token, messageId } = await req.json();
    if (!address || !token || !messageId) {
      return new Response(JSON.stringify({ error: "Missing fields" }), {
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
      await deleteCatchmailMessage(String(address), String(messageId));
    } else if (isMailsacAddress(String(address))) {
      await deleteMailsacMessage(String(address), String(messageId));
    } else {
      const { error: delError } = await supabase
        .from("temp_mail_messages")
        .delete()
        .eq("id", String(messageId))
        .eq("inbox_id", inbox.id);

      if (delError) throw delError;
    }

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
