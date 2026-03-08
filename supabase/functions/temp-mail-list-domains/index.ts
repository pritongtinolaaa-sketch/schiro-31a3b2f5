// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const LOCAL_DOMAINS = [
  "dollicons.com",
  "tinola.eu.cc",
  "schiro.qzz.io",
  "schiro.dpdns.org",
  "schiro.indevs.in",
] as const;

const BLOCKED_DOMAINS = new Set<string>([
  "mailshed.dev",
  "inboxfwd.net",
  "tempbox.one",
  "schhiro.store",
  "schiro.store",
]);

type MailTmDomain = {
  domain?: string;
  isActive?: boolean;
  isPrivate?: boolean;
};

async function fetchMailTmDomains(): Promise<string[]> {
  try {
    const response = await fetch("https://api.mail.tm/domains?page=1", { method: "GET" });
    if (!response.ok) return [];
    const payload = await response.json();
    const members: MailTmDomain[] = Array.isArray(payload?.["hydra:member"]) ? payload["hydra:member"] : [];
    return members
      .filter((item) => item?.isActive !== false && item?.isPrivate !== true)
      .map((item) => String(item.domain ?? "").trim().toLowerCase())
      .filter((value) => value.length > 0 && !BLOCKED_DOMAINS.has(value));
  } catch {
    return [];
  }
}

function extractDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

async function fetchOwnedDomains(supabase: any, requesterUserId: string | null): Promise<string[]> {
  if (!requesterUserId) return [];

  const { data, error } = await supabase
    .from("temp_mail_inboxes")
    .select("email_address, created_at")
    .eq("owner_profile_id", requesterUserId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error || !Array.isArray(data)) return [];

  const seen = new Set<string>();
  const ownedDomains: string[] = [];

  for (const row of data) {
    const domain = extractDomain(String(row?.email_address ?? ""));
    if (!domain || BLOCKED_DOMAINS.has(domain) || seen.has(domain)) continue;
    seen.add(domain);
    ownedDomains.push(domain);
  }

  return ownedDomains;
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

    const [external, ownedDomains] = await Promise.all([
      fetchMailTmDomains(),
      fetchOwnedDomains(supabase, requesterUserId),
    ]);

    const localSet = new Set<string>(LOCAL_DOMAINS.map((d) => d.toLowerCase()));
    const ownedSet = new Set<string>(ownedDomains);

    const localOnly = LOCAL_DOMAINS.filter((d) => !ownedSet.has(d.toLowerCase()));

    const externalOnly = Array.from(new Set(external))
      .filter((domain) => !localSet.has(domain) && !ownedSet.has(domain) && !BLOCKED_DOMAINS.has(domain))
      .sort((a, b) => a.localeCompare(b));

    const domains = [...ownedDomains, ...localOnly, ...externalOnly];

    return new Response(JSON.stringify({ domains }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
