CREATE POLICY "Users can view own temp inboxes"
ON public.temp_mail_inboxes
FOR SELECT
TO authenticated
USING (owner_profile_id = auth.uid());

CREATE POLICY "Users can view own temp inbox messages"
ON public.temp_mail_messages
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.temp_mail_inboxes i
    WHERE i.id = temp_mail_messages.inbox_id
      AND i.owner_profile_id = auth.uid()
  )
);