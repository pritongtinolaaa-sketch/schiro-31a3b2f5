// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function base64Url(bytes: Uint8Array) {
  const str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(digest));
}

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

const CATCHMAIL_DOMAINS = new Set(["catchmail.io", "mailistry.com", "zeppost.com"]);
const MAILSAC_DOMAINS = new Set(["mailsac.com"]);

function domainFromAddress(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).trim().toLowerCase();
}

function isExternalProviderAddress(address: string) {
  const domain = domainFromAddress(address);
  return CATCHMAIL_DOMAINS.has(domain) || MAILSAC_DOMAINS.has(domain);
}

function makeDemoEmail() {
  const senders = [
    "no-reply@streamvault.app",
    "security@cloud-notify.io",
    "newsletter@tinytools.co",
    "team@patchnotes.dev",
  ];
  const subjects = ["Your one-time code", "New login detected", "Welcome — here’s your link", "Weekly digest: 5 small wins"];
  const from = senders[Math.floor(Math.random() * senders.length)];
  const subject = subjects[Math.floor(Math.random() * subjects.length)];
  const code = String(Math.floor(Math.random() * 900000) + 100000);
  const body = `Hi there,\n\nThis is a real stored message in your temporary inbox.\n\nVerification code: ${code}\n\n— schiromail`;
  return { from_address: from, subject, body };
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

    if (isExternalProviderAddress(String(address))) {
      return new Response(JSON.stringify({ error: "Send test is only available for built-in domains. Send a real email to this external mailbox address to test delivery." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const demo = makeDemoEmail();

    const { error: insertError } = await supabase.from("temp_mail_messages").insert({
      inbox_id: inbox.id,
      ...demo,
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
