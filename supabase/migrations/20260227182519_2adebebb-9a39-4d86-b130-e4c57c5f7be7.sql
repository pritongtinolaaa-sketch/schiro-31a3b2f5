-- Explicitly deny all direct access; app uses backend functions with service role.

-- temp_mail_inboxes policies
create policy "deny_select_inboxes" on public.temp_mail_inboxes
for select
using (false);

create policy "deny_insert_inboxes" on public.temp_mail_inboxes
for insert
with check (false);

create policy "deny_update_inboxes" on public.temp_mail_inboxes
for update
using (false);

create policy "deny_delete_inboxes" on public.temp_mail_inboxes
for delete
using (false);

-- temp_mail_messages policies
create policy "deny_select_messages" on public.temp_mail_messages
for select
using (false);

create policy "deny_insert_messages" on public.temp_mail_messages
for insert
with check (false);

create policy "deny_update_messages" on public.temp_mail_messages
for update
using (false);

create policy "deny_delete_messages" on public.temp_mail_messages
for delete
using (false);