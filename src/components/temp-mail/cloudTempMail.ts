import { supabase } from "@/integrations/supabase/client";

export type TempMailMessage = {
  id: string;
  from: string;
  subject: string;
  preview: string;
  receivedAt: number; // epoch ms
  body: string;
};

type CreateInboxResponse = {
  address: string;
  token: string;
  expiresAt: string;
};

type ListMessagesResponse = {
  messages: TempMailMessage[];
  expiresAt: string;
};

const STORAGE_KEY = "temp_mail_inbox_v1";

export function loadSavedInbox(): { address: string; token: string; expiresAt: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { address: string; token: string; expiresAt: string };
    if (!parsed?.address || !parsed?.token || !parsed?.expiresAt) return null;

    // If expired, ignore.
    if (Date.parse(parsed.expiresAt) <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveInbox(input: { address: string; token: string; expiresAt: string }) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(input));
}

export function clearSavedInbox() {
  localStorage.removeItem(STORAGE_KEY);
}

export async function createInbox(): Promise<CreateInboxResponse> {
  const { data, error } = await supabase.functions.invoke<CreateInboxResponse>("temp-mail-create-inbox", {
    body: {},
  });
  if (error) throw error;
  if (!data?.address || !data?.token || !data?.expiresAt) throw new Error("Invalid response");
  return data;
}

export async function listMessages(input: { address: string; token: string }): Promise<ListMessagesResponse> {
  const { data, error } = await supabase.functions.invoke<ListMessagesResponse>("temp-mail-list-messages", {
    body: input,
  });
  if (error) throw error;
  if (!data?.messages) throw new Error("Invalid response");
  return data;
}

export async function sendTestEmail(input: { address: string; token: string }) {
  const { error } = await supabase.functions.invoke("temp-mail-send-test", { body: input });
  if (error) throw error;
}

export function subscribeToInbox(address: string, onNewMail: () => void) {
  const channel = supabase
    .channel(`inbox:${address}`)
    .on("broadcast", { event: "new_mail" }, () => onNewMail())
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
