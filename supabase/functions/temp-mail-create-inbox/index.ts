// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const LOCAL_DOMAINS = [
  "dollicons.com",
  "mailshed.dev",
  "inboxfwd.net",
  "tempbox.one",
  "tinola.eu.cc",
  "schiro.qzz.io",
  "schiro.dpdns.org",
  "schiro.indevs.in",
] as const;

async function fetchMailTmDomains(): Promise<string[]> {
  try {
    const response = await fetch("https://api.mail.tm/domains?page=1", { method: "GET" });
    if (!response.ok) return [];
    const payload = await response.json();
    const members = Array.isArray(payload?.["hydra:member"]) ? payload["hydra:member"] : [];
    return members
      .filter((item: any) => item?.isActive !== false && item?.isPrivate !== true)
      .map((item: any) => String(item?.domain ?? "").trim())
      .filter((value: string) => value.length > 0);
  } catch {
    return [];
  }
}

function randomLocalPart() {
  const adjectives = ["quiet", "mint", "rapid", "paper", "neon", "civic", "lunar", "pixel", "soft", "delta"];
  const nouns = ["fox", "relay", "atlas", "spark", "window", "signal", "orbit", "thread", "vault", "kite"];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const num = String(Math.floor(Math.random() * 9000) + 1000);
  return `${a}.${n}${num}`;
}

async function isOwnedDomain(supabase: any, requesterUserId: string | null, domain: string): Promise<boolean> {
  if (!requesterUserId) return false;

  const pattern = `%@${domain}`;
  const { data, error } = await supabase
    .from("temp_mail_inboxes")
    .select("id")
    .eq("owner_profile_id", requesterUserId)
    .ilike("email_address", pattern)
    .limit(1)
    .maybeSingle();

  if (error) return false;
  return Boolean(data?.id);
}

async function isAllowedDomain(input: unknown, supabase: any, requesterUserId: string | null): Promise<boolean> {
  if (typeof input !== "string") return false;
  const domain = input.trim().toLowerCase();
  if (!domain) return false;

  if ((LOCAL_DOMAINS as readonly string[]).includes(domain)) return true;

  const [mailTmDomains, owned] = await Promise.all([
    fetchMailTmDomains(),
    isOwnedDomain(supabase, requesterUserId, domain),
  ]);

  if (owned) return true;
  return mailTmDomains.includes(domain);
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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabase = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization");
    let requesterUserId: string | null = null;

    if (authHeader) {
      const authClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data } = await authClient.auth.getUser();
      requesterUserId = data.user?.id ?? null;
    }

    let chosenDomain: string | null = null;
    let chosenLocalPart: string | null = null;
    let reclaimToken: string | null = null;

    try {
      const body = await req.json().catch(() => ({}));
      if (await isAllowedDomain(body?.domain, supabase, requesterUserId)) chosenDomain = String(body.domain).trim().toLowerCase();
      if (typeof body?.localPart === "string") chosenLocalPart = body.localPart.trim() || null;
      if (typeof body?.reclaimToken === "string") reclaimToken = body.reclaimToken.trim() || null;
    } catch {
      // ignore
    }

    if (!chosenDomain) {
      return new Response(JSON.stringify({ error: "Domain is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    for (let i = 0; i < 5; i++) {
      const localPart = chosenLocalPart ?? randomLocalPart();
      const address = `${localPart}@${chosenDomain}`;

      const { data: existing, error: existingError } = await supabase
        .from("temp_mail_inboxes")
        .select("id, token_hash, owner_profile_id")
        .eq("email_address", address)
        .maybeSingle();

      if (existingError) throw existingError;

      if (existing) {
        if (!chosenLocalPart) {
          continue;
        }

        if (existing.owner_profile_id) {
          if (requesterUserId !== existing.owner_profile_id) {
            return new Response(JSON.stringify({ error: "That email is reserved by an account" }), {
              status: 409,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        } else {
          if (requesterUserId) {
            return new Response(JSON.stringify({ error: "That email is already taken" }), {
              status: 409,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          if (!reclaimToken) {
            return new Response(JSON.stringify({ error: "That email was used before. Reclaim token required." }), {
              status: 409,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          const reclaimHash = await sha256Base64Url(reclaimToken);
          if (reclaimHash !== existing.token_hash) {
            return new Response(JSON.stringify({ error: "That email is already taken" }), {
              status: 409,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }

        const token = randomToken();
        const tokenHash = await sha256Base64Url(token);
        const updatePayload: Record<string, string | null> = {
          token_hash: tokenHash,
          expires_at: requesterUserId ? "9999-12-31T23:59:59Z" : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          owner_profile_id: requesterUserId,
        };

        const { data, error } = await supabase
          .from("temp_mail_inboxes")
          .update(updatePayload)
          .eq("id", existing.id)
          .select("email_address, expires_at")
          .single();

        if (error) throw error;

        return new Response(JSON.stringify({ address: data.email_address, token, expiresAt: data.expires_at }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const token = randomToken();
      const tokenHash = await sha256Base64Url(token);
      const insertPayload: Record<string, string> = {
        email_address: address,
        token_hash: tokenHash,
      };

      if (requesterUserId) {
        insertPayload.owner_profile_id = requesterUserId;
        insertPayload.expires_at = "9999-12-31T23:59:59Z";
      }

      const { data, error } = await supabase
        .from("temp_mail_inboxes")
        .insert(insertPayload)
        .select("email_address, expires_at")
        .single();

      if (!error && data) {
        return new Response(JSON.stringify({ address: data.email_address, token, expiresAt: data.expires_at }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

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
