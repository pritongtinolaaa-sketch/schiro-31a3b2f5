// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function extractBearerToken(authHeader: string | null) {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.trim().split(/\s+/, 2);
  if (!scheme || !token) return null;
  return scheme.toLowerCase() === "bearer" ? token.trim() : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const bearerToken = extractBearerToken(req.headers.get("Authorization"));
    if (!bearerToken) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
    });

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser(bearerToken);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    const { data, error } = await supabase
      .from("temp_mail_inboxes")
      .select("id, email_address, created_at, expires_at")
      .eq("owner_profile_id", user.id)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw error;

    const inboxRows = data ?? [];
    const inboxIds = inboxRows.map((row) => row.id);
    const latestByInboxId: Record<string, string> = {};

    if (inboxIds.length > 0) {
      const { data: messageRows, error: messageError } = await supabase
        .from("temp_mail_messages")
        .select("inbox_id, received_at")
        .in("inbox_id", inboxIds)
        .order("received_at", { ascending: false })
        .limit(1000);

      if (messageError) throw messageError;

      for (const message of messageRows ?? []) {
        if (!latestByInboxId[message.inbox_id]) {
          latestByInboxId[message.inbox_id] = message.received_at;
        }
      }
    }

    const inboxes = inboxRows.map((row) => ({
      address: row.email_address,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      latestReceivedAt: latestByInboxId[row.id] ?? null,
    }));

    return new Response(JSON.stringify({ inboxes }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
