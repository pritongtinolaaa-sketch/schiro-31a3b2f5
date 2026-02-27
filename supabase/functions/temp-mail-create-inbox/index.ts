// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DOMAINS = ["mailshed.dev", "inboxfwd.net", "tempbox.one"] as const;

type Domain = (typeof DOMAINS)[number];

function randomLocalPart() {
  const adjectives = ["quiet", "mint", "rapid", "paper", "neon", "civic", "lunar", "pixel", "soft", "delta"];
  const nouns = ["fox", "relay", "atlas", "spark", "window", "signal", "orbit", "thread", "vault", "kite"];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const num = String(Math.floor(Math.random() * 9000) + 1000);
  return `${a}.${n}${num}`;
}

function randomDomain(): Domain {
  return DOMAINS[Math.floor(Math.random() * DOMAINS.length)];
}

function isAllowedDomain(input: unknown): input is Domain {
  return typeof input === "string" && (DOMAINS as readonly string[]).includes(input);
}

function base64Url(bytes: Uint8Array) {
  const str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(digest));
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, serviceKey);

    let chosenDomain: Domain | null = null;
    let chosenLocalPart: string | null = null;

    try {
      const body = await req.json().catch(() => ({}));
      if (isAllowedDomain(body?.domain)) chosenDomain = body.domain;
      if (typeof body?.localPart === "string") chosenLocalPart = body.localPart.trim() || null;
    } catch {
      // ignore
    }

    if (!chosenDomain) {
      return new Response(JSON.stringify({ error: "Domain is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Allow user-chosen name with safe chars.
    if (chosenLocalPart) {
      const ok = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/i.test(chosenLocalPart);
      if (!ok) {
        return new Response(
          JSON.stringify({
            error:
              "Invalid email name. Use letters/numbers plus . _ - (3–32 chars), and start/end with a letter or number.",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // Try a few times to avoid unique collisions.
    for (let i = 0; i < 5; i++) {
      const domain = chosenDomain;
      const localPart = chosenLocalPart ?? randomLocalPart();
      const address = `${localPart}@${domain}`;
      const token = randomToken();
      const tokenHash = await sha256Base64Url(token);

      const { data, error } = await supabase
        .from("temp_mail_inboxes")
        .insert({ email_address: address, token_hash: tokenHash })
        .select("email_address, expires_at")
        .single();

      if (!error && data) {
        return new Response(JSON.stringify({ address: data.email_address, token, expiresAt: data.expires_at }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // If collision, retry; otherwise bubble up.
      if (!(String(error?.code) === "23505")) throw error;
    }

    return new Response(JSON.stringify({ error: "Could not allocate address" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

