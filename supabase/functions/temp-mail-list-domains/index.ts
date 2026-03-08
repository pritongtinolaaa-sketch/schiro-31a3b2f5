// deno-lint-ignore-file no-explicit-any
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
      .map((item) => String(item.domain ?? "").trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const external = await fetchMailTmDomains();
    const set = new Set<string>([...LOCAL_DOMAINS, ...external]);

    return new Response(JSON.stringify({ domains: Array.from(set) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
