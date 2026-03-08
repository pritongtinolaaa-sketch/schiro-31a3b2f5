ALTER TABLE public.temp_mail_inboxes
ADD COLUMN IF NOT EXISTS owner_profile_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_temp_mail_inboxes_owner_profile_id
ON public.temp_mail_inboxes(owner_profile_id);