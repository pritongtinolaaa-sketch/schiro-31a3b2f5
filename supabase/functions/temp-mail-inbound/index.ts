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

function extractReadableBody(raw: string) {
  const normalized = String(raw ?? "").replace(/\r\n/g, "\n");

  const boundaryMatch = normalized.match(/boundary="?([^"\n;]+)"?/i);
  if (boundaryMatch) {
    const boundary = `--${boundaryMatch[1]}`;
    const parts = normalized.split(boundary);

    for (const part of parts) {
      if (!/content-type:\s*text\/plain/i.test(part)) continue;

      const plain = part
        .replace(/^[\s\S]*?\n\n/, "")
        .replace(/\n--\s*$/, "")
        .trim();

      if (!plain) continue;
      return decodeQuotedPrintable(plain).trim();
    }
  }

  // Fallback for full RFC822 payloads: remove transport headers and keep content.
  const sections = normalized.split(/\n\n/);
  if (sections.length > 1) {
    const maybeContent = sections.slice(1).join("\n\n").trim();
    if (maybeContent) return maybeContent;
  }

  return normalized.trim();
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
