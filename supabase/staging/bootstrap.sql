-- Recepta schema-only bootstrap for a NEW, EMPTY staging database.

-- Snapshot of the existing application structure; contains NO customer rows,

-- provider credentials, billing records, Auth users or phone assignments.

-- Do not add this file to the production migrations directory or run it on live data.

-- A guard refuses populated application schemas instead of dropping/replacing them.

set search_path = public, extensions;

do $bootstrap_guard$ begin

  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace

    where n.nspname='public' and c.relkind in ('r','p','v','m','S'))

    or to_regnamespace('recepta_private') is not null then

    raise exception 'Staging bootstrap requires an empty application schema. No existing schema was changed.';

  end if;

end $bootstrap_guard$;

create schema recepta_private;

create extension if not exists "uuid-ossp" with schema "extensions";

create extension if not exists "pgcrypto" with schema "extensions";

-- Functions may reference other functions declared later, as with pg_dump.

set check_function_bodies = off;

create table public."agent_phone_numbers" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "phone_number" text not null,
  "is_primary" boolean default false not null,
  "source" text default 'manual'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."agent_phone_numbers" add constraint "agent_phone_numbers_e164_check" CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'::text);

alter table public."agent_phone_numbers" add constraint "agent_phone_numbers_phone_number_key" UNIQUE (phone_number);

alter table public."agent_phone_numbers" add constraint "agent_phone_numbers_pkey" PRIMARY KEY (id);

alter table public."agent_phone_numbers" add constraint "agent_phone_numbers_source_check" CHECK (source = ANY (ARRAY['manual'::text, 'retell'::text]));

create table public."agents" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "agent_name" text,
  "phone_number" text,
  "retell_agent_id" text,
  "business_hours" text,
  "status" text default 'setup'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "demo_mode" boolean default false not null
);

alter table public."agents" add constraint "agents_pkey" PRIMARY KEY (id);

alter table public."agents" add constraint "agents_status_check" CHECK (status = ANY (ARRAY['setup'::text, 'testing'::text, 'live'::text, 'paused'::text]));

create table public."ai_models" (
  "id" text not null,
  "display_name" text not null,
  "provider" text not null,
  "retell_model_name" text not null,
  "tier_name" text not null,
  "description" text,
  "best_for" text,
  "customer_price_per_minute_cad" numeric(10,4),
  "is_recommended" boolean default false not null,
  "is_active" boolean default true not null,
  "sort_order" integer default 0 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "advanced_denoising_included" boolean default false not null
);

alter table public."ai_models" add constraint "ai_models_pkey" PRIMARY KEY (id);

create table public."appointment_customer_contacts" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "name" text not null,
  "email" text,
  "phone" text,
  "company_name" text,
  "notes" text,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."appointment_customer_contacts" add constraint "appointment_customer_contacts_pkey" PRIMARY KEY (id);

create table public."appointments" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "call_id" uuid,
  "customer_name" text,
  "customer_phone" text,
  "customer_email" text,
  "service" text,
  "appointment_time" timestamp with time zone,
  "status" text default 'booked'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "employee_id" uuid,
  "appointment_end_time" timestamp with time zone,
  "duration_minutes" integer,
  "company_name" text,
  "notes" text,
  "internal_notes" text,
  "source" text default 'dashboard'::text not null,
  "retell_call_id" text,
  "updated_at" timestamp with time zone default now() not null,
  "requested_date" text,
  "requested_time" text,
  "requested_timezone" text,
  "booking_key" text,
  "booking_version" integer default 1 not null,
  "booking_buffer_minutes" integer default 0 not null,
  "google_calendar_id" text
);

alter table public."appointments" add constraint "appointments_duration_minutes_check" CHECK (duration_minutes >= 5 AND duration_minutes <= 480);

alter table public."appointments" add constraint "appointments_pending_has_no_slot" CHECK (status <> 'pending'::text OR appointment_time IS NULL AND appointment_end_time IS NULL AND duration_minutes IS NULL AND employee_id IS NULL);

alter table public."appointments" add constraint "appointments_pkey" PRIMARY KEY (id);

alter table public."appointments" add constraint "appointments_source_check" CHECK (source = ANY (ARRAY['retell'::text, 'dashboard'::text, 'admin'::text, 'imported'::text]));

alter table public."appointments" add constraint "appointments_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'booked'::text, 'cancelled'::text, 'completed'::text]));

create table public."billing_notifications" (
  "notification_key" text not null,
  "client_id" uuid not null,
  "kind" text not null,
  "payload" jsonb not null,
  "created_at" timestamp with time zone default now() not null,
  "sent_at" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "attempts" integer default 0 not null,
  "last_error" text,
  "delivery_status" text,
  "delivery_event_at" timestamp with time zone,
  "provider_message_id" text,
  "mail_payload" jsonb,
  "first_send_at" timestamp with time zone
);

alter table public."billing_notifications" add constraint "billing_notifications_kind_check" CHECK (kind = ANY (ARRAY['renewal_reminder'::text, 'payment_success'::text, 'payment_failed'::text, 'usage_80'::text, 'usage_100'::text]));

alter table public."billing_notifications" add constraint "billing_notifications_pkey" PRIMARY KEY (notification_key);

create table public."booking_calendar_events" (
  "client_id" uuid not null,
  "calendar_id" text not null,
  "event_id" text not null,
  "starts_at" timestamp with time zone not null,
  "ends_at" timestamp with time zone not null,
  "title" text default 'Calendar appointment'::text not null,
  "html_link" text,
  "local_appointment_id" uuid
);

alter table public."booking_calendar_events" add constraint "booking_calendar_events_check" CHECK (ends_at > starts_at);

alter table public."booking_calendar_events" add constraint "booking_calendar_events_pkey" PRIMARY KEY (client_id, calendar_id, event_id);

create table public."booking_calendar_jobs" (
  "appointment_id" uuid not null,
  "client_id" uuid not null,
  "version" integer not null,
  "calendar_id" text not null,
  "attempts" integer default 0 not null,
  "retry_at" timestamp with time zone default now() not null,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "last_error" text
);

alter table public."booking_calendar_jobs" add constraint "booking_calendar_jobs_pkey" PRIMARY KEY (appointment_id);

create table public."booking_settings" (
  "client_id" uuid not null,
  "enabled" boolean default false not null,
  "capacity" integer default 1 not null,
  "duration_minutes" integer default 30 not null,
  "buffer_minutes" integer default 0 not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."booking_settings" add constraint "booking_settings_buffer_minutes_check" CHECK (buffer_minutes >= 0 AND buffer_minutes <= 120);

alter table public."booking_settings" add constraint "booking_settings_capacity_check" CHECK (capacity >= 1 AND capacity <= 50);

alter table public."booking_settings" add constraint "booking_settings_duration_minutes_check" CHECK (duration_minutes >= 5 AND duration_minutes <= 480);

alter table public."booking_settings" add constraint "booking_settings_pkey" PRIMARY KEY (client_id);

create table public."call_minute_reservations" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "period_start" timestamp with time zone not null,
  "reserved_seconds" integer not null,
  "used_seconds" integer,
  "status" text default 'active'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "completed_at" timestamp with time zone,
  "retell_call_id" text,
  "period_end" timestamp with time zone,
  "retell_agent_id" text,
  "demo_mode" boolean default false not null
);

alter table public."call_minute_reservations" add constraint "call_minute_reservations_pkey" PRIMARY KEY (id);

alter table public."call_minute_reservations" add constraint "call_minute_reservations_reserved_seconds_check" CHECK (reserved_seconds >= 60 AND (retell_call_id IS NULL OR reserved_seconds <=
CASE
    WHEN demo_mode THEN 180
    ELSE 7200
END));

alter table public."call_minute_reservations" add constraint "call_minute_reservations_status_check" CHECK (status = ANY (ARRAY['active'::text, 'completed'::text, 'expired'::text]));

create table public."call_notifications" (
  "notification_key" text not null,
  "client_id" uuid not null,
  "call_record_id" uuid not null,
  "retell_call_id" text not null,
  "plan_name" text not null,
  "status" text default 'queued'::text not null,
  "attempts" integer default 0 not null,
  "next_attempt_at" timestamp with time zone default now() not null,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "first_send_at" timestamp with time zone,
  "mail_payload" jsonb,
  "provider_message_id" text,
  "accepted_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone default now() not null,
  "delivery_status" text,
  "delivery_event_at" timestamp with time zone
);

alter table public."call_notifications" add constraint "call_notifications_pkey" PRIMARY KEY (notification_key);

alter table public."call_notifications" add constraint "call_notifications_plan_name_check" CHECK (plan_name = ANY (ARRAY['Recepta Standard'::text, 'Recepta Pro'::text]));

alter table public."call_notifications" add constraint "call_notifications_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'retrying'::text, 'accepted'::text, 'needs_attention'::text, 'legacy_untracked'::text]));

create table public."callback_requests" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "retell_call_id" text not null,
  "caller_number" text,
  "called_number" text,
  "reason" text not null,
  "status" text default 'pending'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."callback_requests" add constraint "callback_requests_pkey" PRIMARY KEY (id);

alter table public."callback_requests" add constraint "callback_requests_reason_check" CHECK (reason = ANY (ARRAY['outside_answering_hours'::text, 'agent_unavailable'::text, 'allowance_unavailable'::text, 'admission_unavailable'::text]));

alter table public."callback_requests" add constraint "callback_requests_retell_call_id_key" UNIQUE (retell_call_id);

alter table public."callback_requests" add constraint "callback_requests_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'contacted'::text, 'resolved'::text, 'unreachable'::text]));

create table public."calls" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "agent_id" uuid,
  "caller_name" text,
  "caller_number" text,
  "started_at" timestamp with time zone default now() not null,
  "duration_seconds" integer default 0 not null,
  "outcome" text,
  "summary" text,
  "appointment_booked" boolean default false not null,
  "retell_call_id" text,
  "created_at" timestamp with time zone default now() not null,
  "retell_agent_id" text,
  "ended_at" timestamp with time zone,
  "transcript" text,
  "call_status" text,
  "recording_url" text,
  "disconnection_reason" text,
  "user_sentiment" text,
  "call_successful" boolean,
  "updated_at" timestamp with time zone default now() not null,
  "owner_notification_requested" boolean default false not null,
  "lifecycle_rank" smallint default 0 not null,
  "media_redacted" boolean default false not null,
  "content_erased_at" timestamp with time zone,
  "provider_erased_at" timestamp with time zone
);

alter table public."calls" add constraint "calls_lifecycle_rank_check" CHECK (lifecycle_rank >= 0 AND lifecycle_rank <= 3);

alter table public."calls" add constraint "calls_pkey" PRIMARY KEY (id);

alter table public."calls" add constraint "calls_retell_call_id_key" UNIQUE (retell_call_id);

create table public."clients" (
  "id" uuid not null,
  "company_name" text,
  "contact_email" text,
  "status" text default 'setup'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "role" text default 'client'::text not null,
  "owner_name" text,
  "owner_phone" text,
  "deletion_pending" boolean default false not null,
  "call_retention_days" integer default 90 not null
);

alter table public."clients" add constraint "clients_call_retention_days_check" CHECK (call_retention_days >= 7 AND call_retention_days <= 365);

alter table public."clients" add constraint "clients_pkey" PRIMARY KEY (id);

alter table public."clients" add constraint "clients_role_check" CHECK (role = ANY (ARRAY['client'::text, 'admin'::text]));

alter table public."clients" add constraint "clients_status_check" CHECK (status = ANY (ARRAY['setup'::text, 'testing'::text, 'live'::text, 'paused'::text]));

create table public."customer_requests" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "request_type" text default 'other'::text not null,
  "title" text not null,
  "details" text not null,
  "status" text default 'new'::text not null,
  "email_sent_at" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."customer_requests" add constraint "customer_requests_details_check" CHECK (char_length(details) >= 10 AND char_length(details) <= 5000);

alter table public."customer_requests" add constraint "customer_requests_pkey" PRIMARY KEY (id);

alter table public."customer_requests" add constraint "customer_requests_request_type_check" CHECK (request_type = ANY (ARRAY['website_change'::text, 'ai_agent_change'::text, 'question'::text, 'meeting'::text, 'billing'::text, 'other'::text]));

alter table public."customer_requests" add constraint "customer_requests_status_check" CHECK (status = ANY (ARRAY['new'::text, 'in_progress'::text, 'resolved'::text]));

alter table public."customer_requests" add constraint "customer_requests_title_check" CHECK (char_length(title) >= 3 AND char_length(title) <= 160);

create table public."email_delivery_receipts" (
  "event_id" text not null,
  "provider_message_id" text not null,
  "status" text not null,
  "event_at" timestamp with time zone not null,
  "created_at" timestamp with time zone default now() not null
);

alter table public."email_delivery_receipts" add constraint "email_delivery_receipts_pkey" PRIMARY KEY (event_id);

create table public."employee_calendar_blocks" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "employee_id" uuid not null,
  "title" text not null,
  "details" text,
  "block_type" text default 'unavailable'::text not null,
  "starts_at" timestamp with time zone not null,
  "ends_at" timestamp with time zone not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."employee_calendar_blocks" add constraint "employee_calendar_blocks_block_type_check" CHECK (block_type = ANY (ARRAY['unavailable'::text, 'break'::text, 'meeting'::text, 'time_off'::text]));

alter table public."employee_calendar_blocks" add constraint "employee_calendar_blocks_check" CHECK (ends_at > starts_at);

alter table public."employee_calendar_blocks" add constraint "employee_calendar_blocks_pkey" PRIMARY KEY (id);

create table public."employee_schedule_overrides" (
  "id" uuid default gen_random_uuid() not null,
  "employee_id" uuid not null,
  "schedule_date" date not null,
  "is_working" boolean default true not null,
  "start_time" time without time zone,
  "end_time" time without time zone,
  "note" text,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."employee_schedule_overrides" add constraint "employee_schedule_overrides_employee_id_schedule_date_key" UNIQUE (employee_id, schedule_date);

alter table public."employee_schedule_overrides" add constraint "employee_schedule_overrides_pkey" PRIMARY KEY (id);

create table public."employee_schedules" (
  "id" uuid default gen_random_uuid() not null,
  "employee_id" uuid not null,
  "day_of_week" integer not null,
  "is_working" boolean default true not null,
  "start_time" time without time zone,
  "end_time" time without time zone,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."employee_schedules" add constraint "employee_schedules_day_of_week_check" CHECK (day_of_week >= 0 AND day_of_week <= 6);

alter table public."employee_schedules" add constraint "employee_schedules_employee_id_day_of_week_key" UNIQUE (employee_id, day_of_week);

alter table public."employee_schedules" add constraint "employee_schedules_pkey" PRIMARY KEY (id);

create table public."employees" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "name" text not null,
  "email" text,
  "phone" text,
  "role" text,
  "is_active" boolean default true not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."employees" add constraint "employees_pkey" PRIMARY KEY (id);

create table public."google_calendar_connections" (
  "client_id" uuid not null,
  "encrypted_refresh_token" text not null,
  "selected_calendars" jsonb default '[]'::jsonb not null,
  "write_calendar_id" text,
  "synced_at" timestamp with time zone,
  "sync_error" text,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."google_calendar_connections" add constraint "google_calendar_connections_pkey" PRIMARY KEY (client_id);

create table public."google_calendar_oauth_states" (
  "state_hash" text not null,
  "client_id" uuid not null,
  "browser_hash" text not null,
  "expires_at" timestamp with time zone not null
);

alter table public."google_calendar_oauth_states" add constraint "google_calendar_oauth_states_pkey" PRIMARY KEY (state_hash);

create table public."integration_settings" (
  "key" text not null,
  "value" jsonb not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."integration_settings" add constraint "integration_settings_pkey" PRIMARY KEY (key);

create table public."onboarding" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "business_phone" text,
  "business_hours" text,
  "services" text,
  "pricing_notes" text,
  "service_area" text,
  "faqs" text,
  "transfer_number" text,
  "emergency_rules" text,
  "appointment_types" text,
  "appointment_lengths" text,
  "cancellation_rules" text,
  "tone_preference" text,
  "voice_preference" text,
  "forbidden_topics" text,
  "notification_preferences" text,
  "onboarding_notes" text,
  "completed" boolean default false not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table public."onboarding" add constraint "onboarding_client_id_key" UNIQUE (client_id);

alter table public."onboarding" add constraint "onboarding_pkey" PRIMARY KEY (id);

create table public."recepta_demo_links" (
  "id" uuid default gen_random_uuid() not null,
  "token_hash" text not null,
  "label" text not null,
  "retell_agent_id" text not null,
  "agent_version" integer not null,
  "created_at" timestamp with time zone default now() not null,
  "expires_at" timestamp with time zone default (now() + '7 days'::interval) not null,
  "max_attempts" integer default 3 not null,
  "attempts" integer default 0 not null,
  "revoked" boolean default false not null
);

alter table public."recepta_demo_links" add constraint "recepta_demo_links_agent_version_check" CHECK (agent_version >= 0);

alter table public."recepta_demo_links" add constraint "recepta_demo_links_check" CHECK (attempts >= 0 AND attempts <= max_attempts);

alter table public."recepta_demo_links" add constraint "recepta_demo_links_label_check" CHECK (char_length(label) >= 1 AND char_length(label) <= 100);

alter table public."recepta_demo_links" add constraint "recepta_demo_links_max_attempts_check" CHECK (max_attempts >= 1 AND max_attempts <= 5);

alter table public."recepta_demo_links" add constraint "recepta_demo_links_pkey" PRIMARY KEY (id);

alter table public."recepta_demo_links" add constraint "recepta_demo_links_token_hash_check" CHECK (token_hash ~ '^[a-f0-9]{64}$'::text);

alter table public."recepta_demo_links" add constraint "recepta_demo_links_token_hash_key" UNIQUE (token_hash);

create table public."service_jobs" (
  "job_key" text not null,
  "client_id" uuid,
  "kind" text not null,
  "payload" jsonb default '{}'::jsonb not null,
  "status" text default 'queued'::text not null,
  "attempts" integer default 0 not null,
  "next_attempt_at" timestamp with time zone default now() not null,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "mail_payload" jsonb,
  "first_send_at" timestamp with time zone,
  "provider_message_id" text,
  "delivery_status" text,
  "delivery_event_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone default now() not null,
  "completed_at" timestamp with time zone
);

alter table public."service_jobs" add constraint "service_jobs_kind_check" CHECK (kind = ANY (ARRAY['callback_email'::text, 'delete_client'::text, 'retention_call'::text]));

alter table public."service_jobs" add constraint "service_jobs_pkey" PRIMARY KEY (job_key);

alter table public."service_jobs" add constraint "service_jobs_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'running'::text, 'complete'::text, 'needs_attention'::text]));

create table public."subscriptions" (
  "id" uuid default gen_random_uuid() not null,
  "client_id" uuid not null,
  "plan_name" text,
  "monthly_price" numeric(10,2),
  "status" text default 'pending'::text not null,
  "next_billing_date" timestamp with time zone,
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "created_at" timestamp with time zone default now() not null,
  "monthly_minutes" integer default 300 not null,
  "ai_model_id" text,
  "stripe_plan_item_id" text,
  "stripe_minutes_item_id" text,
  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "pii_redaction_enabled" boolean default false not null,
  "safety_guardrails_enabled" boolean default false not null,
  "extra_phone_numbers" integer default 0 not null,
  "rollover_seconds" bigint default 0 not null,
  "cancel_at_period_end" boolean default false not null,
  "pending_configuration" jsonb,
  "configuration_revision" bigint default 0 not null
);

alter table public."subscriptions" add constraint "active_subscription_requires_payment" CHECK (status <> 'active'::text OR NULLIF(btrim(stripe_subscription_id), ''::text) IS NOT NULL);

alter table public."subscriptions" add constraint "subscriptions_extra_phone_numbers_check" CHECK (extra_phone_numbers >= 0 AND extra_phone_numbers <= 20);

alter table public."subscriptions" add constraint "subscriptions_pkey" PRIMARY KEY (id);

alter table public."subscriptions" add constraint "subscriptions_rollover_seconds_check" CHECK (rollover_seconds >= 0);

alter table public."subscriptions" add constraint "subscriptions_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'active'::text, 'past_due'::text, 'cancelled'::text]));

alter table public."agent_phone_numbers" add constraint "agent_phone_numbers_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."agents" add constraint "agents_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."appointment_customer_contacts" add constraint "appointment_customer_contacts_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."appointments" add constraint "appointments_call_id_fkey" FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE SET NULL;

alter table public."appointments" add constraint "appointments_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."appointments" add constraint "appointments_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;

alter table public."billing_notifications" add constraint "billing_notifications_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."booking_calendar_events" add constraint "booking_calendar_events_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."booking_calendar_events" add constraint "booking_calendar_events_local_appointment_id_fkey" FOREIGN KEY (local_appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;

alter table public."booking_calendar_jobs" add constraint "booking_calendar_jobs_appointment_id_fkey" FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE;

alter table public."booking_calendar_jobs" add constraint "booking_calendar_jobs_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."booking_settings" add constraint "booking_settings_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."call_minute_reservations" add constraint "call_minute_reservations_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."call_notifications" add constraint "call_notifications_call_record_id_fkey" FOREIGN KEY (call_record_id) REFERENCES calls(id) ON DELETE CASCADE;

alter table public."call_notifications" add constraint "call_notifications_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."callback_requests" add constraint "callback_requests_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."calls" add constraint "calls_agent_id_fkey" FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

alter table public."calls" add constraint "calls_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."clients" add constraint "clients_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public."customer_requests" add constraint "customer_requests_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."employee_calendar_blocks" add constraint "employee_calendar_blocks_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."employee_calendar_blocks" add constraint "employee_calendar_blocks_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;

alter table public."employee_schedule_overrides" add constraint "employee_schedule_overrides_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;

alter table public."employee_schedules" add constraint "employee_schedules_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;

alter table public."employees" add constraint "employees_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."google_calendar_connections" add constraint "google_calendar_connections_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."google_calendar_oauth_states" add constraint "google_calendar_oauth_states_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."onboarding" add constraint "onboarding_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

alter table public."subscriptions" add constraint "subscriptions_ai_model_id_fkey" FOREIGN KEY (ai_model_id) REFERENCES ai_models(id);

alter table public."subscriptions" add constraint "subscriptions_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION recepta_private.account_available()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.clients where id=(select auth.uid()) and not deletion_pending);
$function$;

CREATE OR REPLACE FUNCTION recepta_private.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.clients where id=(select auth.uid()) and role='admin');
$function$;

CREATE OR REPLACE FUNCTION public.activate_recepta_checkout(p_client_id uuid, p_stripe_subscription_id text, p_customer_id text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_configuration jsonb, p_replaces_subscription_id text DEFAULT NULL::text)
 RETURNS SETOF subscriptions
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_old public.subscriptions%rowtype;
  v_next public.subscriptions%rowtype;
  v_used bigint := 0;
  v_monthly bigint := 0;
  v_rollover bigint := 0;
begin
  if p_period_end <= p_period_start then raise exception 'Invalid billing period'; end if;
  select * into v_old from public.subscriptions where client_id = p_client_id for update;
  if not found then return; end if;
  if exists(select 1 from public.clients where id=p_client_id and deletion_pending) then return; end if;
  if v_old.stripe_subscription_id = p_stripe_subscription_id then
    if v_old.current_period_start = p_period_start and v_old.status = 'active' then
      return next v_old;
    end if;
    return;
  end if;
  if p_replaces_subscription_id is not null then
    if v_old.stripe_subscription_id is distinct from p_replaces_subscription_id then return; end if;
  elsif v_old.status = 'active' and v_old.stripe_subscription_id is not null then
    return;
  end if;
  v_next := jsonb_populate_record(v_old, p_configuration);
  if p_replaces_subscription_id is not null and v_old.status = 'active'
    and v_old.current_period_start <= p_period_start and v_old.current_period_end > p_period_start then
    v_used := public.recepta_committed_usage(p_client_id,
      v_old.current_period_start,p_period_start);
    v_monthly := greatest(coalesce(v_old.monthly_minutes, 0), 0)::bigint * 60;
    v_rollover := least(
      greatest(v_monthly - greatest(v_used - least(coalesce(v_old.rollover_seconds, 0), v_monthly), 0), 0),
      greatest(coalesce(v_next.monthly_minutes, 0), 0)::bigint * 60
    );
  end if;
  -- A confirmed paid Checkout converts the prospect to normal customer calls.
  -- Replay guards above return before this, preserving a later admin demo choice.
  update public.agents set demo_mode=false where client_id=p_client_id;
  return query update public.subscriptions set
    plan_name = v_next.plan_name, monthly_price = v_next.monthly_price,
    monthly_minutes = v_next.monthly_minutes, ai_model_id = v_next.ai_model_id,
    pii_redaction_enabled = v_next.pii_redaction_enabled,
    safety_guardrails_enabled = v_next.safety_guardrails_enabled,
    extra_phone_numbers = v_next.extra_phone_numbers,
    status = 'active', rollover_seconds = v_rollover,
    pending_configuration = case when p_configuration->>'quote_revision' = v_old.configuration_revision::text then null else v_old.pending_configuration end,
    current_period_start = p_period_start, current_period_end = p_period_end,
    next_billing_date = p_period_end, stripe_subscription_id = p_stripe_subscription_id,
    stripe_customer_id = p_customer_id, cancel_at_period_end = false
    where client_id = p_client_id returning *;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apply_recepta_email_delivery(p_provider_id text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_event public.email_delivery_receipts%rowtype; v_table text;
begin
  select * into v_event from public.email_delivery_receipts where provider_message_id=p_provider_id
    order by event_at desc,case status when 'complained' then 5 when 'bounced' then 4 when 'failed' then 3 when 'delivered' then 2 else 1 end desc limit 1;
  if not found then return; end if;
  foreach v_table in array array['call_notifications','billing_notifications','service_jobs'] loop
    execute format('update public.%I set delivery_status=$1,delivery_event_at=$2 where provider_message_id=$3 and (delivery_event_at is null or delivery_event_at<=$2)',v_table)
      using v_event.status,v_event.event_at,p_provider_id;
  end loop;
end $function$;

CREATE OR REPLACE FUNCTION public.cancel_recepta_booking(p_client_id uuid, p_id uuid, p_version integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,419));
  update public.appointments set status='cancelled',booking_version=booking_version+1,updated_at=now()
    where client_id=p_client_id and id=p_id and booking_version=p_version and status in ('booked','pending');
  if not found then raise exception 'This booking changed. Refresh before cancelling.'; end if;
end $function$;

CREATE OR REPLACE FUNCTION public.capture_recepta_appointment_request(p_client_id uuid, p_call_id text, p_details jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
begin
  if nullif(btrim(p_call_id), '') is null then
    raise exception 'A provider call ID is required.';
  end if;
  insert into public.appointments (
    client_id, retell_call_id, customer_name, customer_email, customer_phone,
    company_name, service, notes, requested_date, requested_time, requested_timezone,
    status, source, appointment_time, appointment_end_time, duration_minutes, employee_id
  ) values (
    p_client_id, p_call_id, p_details->>'customer_name', p_details->>'customer_email',
    p_details->>'customer_phone', p_details->>'company_name', p_details->>'service',
    p_details->>'notes', p_details->>'requested_date', p_details->>'requested_time',
    p_details->>'requested_timezone', 'pending', 'retell', null, null, null, null
  ) on conflict (retell_call_id) where retell_call_id is not null do update set
    customer_name = coalesce(excluded.customer_name, appointments.customer_name),
    customer_email = coalesce(excluded.customer_email, appointments.customer_email),
    customer_phone = coalesce(excluded.customer_phone, appointments.customer_phone),
    company_name = coalesce(excluded.company_name, appointments.company_name),
    service = coalesce(excluded.service, appointments.service),
    notes = excluded.notes,
    requested_date = coalesce(excluded.requested_date, appointments.requested_date),
    requested_time = coalesce(excluded.requested_time, appointments.requested_time),
    requested_timezone = coalesce(excluded.requested_timezone, appointments.requested_timezone),
    updated_at = now()
  where appointments.client_id = p_client_id and appointments.status = 'pending'
  returning jsonb_build_object('id', id, 'status', status) into v_result;

  if v_result is null then
    select jsonb_build_object('id', id, 'status', status) into v_result
      from public.appointments where client_id = p_client_id and retell_call_id = p_call_id;
  end if;
  if v_result is null then
    raise exception 'Could not capture this appointment request.';
  end if;
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.claim_recepta_billing_notifications(p_limit integer DEFAULT 5)
 RETURNS SETOF billing_notifications
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  update public.billing_notifications set last_error='Automatic retries paused; provider delivery must be reviewed.' where sent_at is null and first_send_at<now()-interval '23 hours';
  return query update public.billing_notifications set last_attempt_at=now(),attempts=attempts+1
    where notification_key in(select notification_key from public.billing_notifications
      where sent_at is null and (last_attempt_at is null or last_attempt_at<now()-interval '10 minutes')
      and (first_send_at is null or first_send_at>now()-interval '23 hours')
      order by coalesce(last_attempt_at,created_at),created_at for update skip locked limit least(greatest(p_limit,1),5)) returning *;
end $function$;

CREATE OR REPLACE FUNCTION public.claim_recepta_calendar_jobs(p_client_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF booking_calendar_jobs
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  update public.booking_calendar_jobs set lease_token=gen_random_uuid(),lease_expires_at=now()+interval '90 seconds',attempts=attempts+1
  where appointment_id in (select appointment_id from public.booking_calendar_jobs where retry_at<=now()
    and (p_client_id is null or client_id=p_client_id) and (lease_expires_at is null or lease_expires_at<now())
    order by retry_at for update skip locked limit 5) returning *;
$function$;

CREATE OR REPLACE FUNCTION public.claim_recepta_call_notifications(p_limit integer DEFAULT 5, p_key text DEFAULT NULL::text)
 RETURNS SETOF call_notifications
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- Resend retains keys for 24h. Pause ambiguous late retries instead of risking
  -- a duplicate after the provider's retention window. The notice stays visible.
  update public.call_notifications set status='needs_attention',lease_token=null,lease_expires_at=null,
    last_error='Automatic retries paused; delivery needs review.'
    where status in ('queued','retrying') and first_send_at < now()-interval '23 hours'
      and (lease_expires_at is null or lease_expires_at <= now());
  return query update public.call_notifications n set
    status='retrying',attempts=n.attempts+1,lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes'
    where n.notification_key in (
      select q.notification_key from public.call_notifications q
      where q.status in ('queued','retrying') and q.next_attempt_at<=now()
        and (q.lease_expires_at is null or q.lease_expires_at<=now())
        and (p_key is null or q.notification_key=p_key)
      order by q.next_attempt_at,q.created_at for update skip locked
      limit least(greatest(p_limit,1),5)
    ) returning n.*;
end; $function$;

CREATE OR REPLACE FUNCTION public.claim_recepta_demo(p_token_hash text)
 RETURNS TABLE(id uuid, retell_agent_id text, agent_version integer)
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  update public.recepta_demo_links as d
  set attempts = d.attempts + 1
  where d.token_hash = p_token_hash and not d.revoked
    and d.expires_at > now() and d.attempts < d.max_attempts
    and not exists (
      select 1 from public.agents as a where a.retell_agent_id = d.retell_agent_id
    )
  returning d.id, d.retell_agent_id, d.agent_version;
$function$;

CREATE OR REPLACE FUNCTION public.claim_recepta_service_jobs(p_limit integer DEFAULT 2, p_key text DEFAULT NULL::text)
 RETURNS SETOF service_jobs
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  update public.service_jobs set status='needs_attention',lease_token=null,lease_expires_at=null,
    last_error='Automatic email retries paused before the provider idempotency window expired.'
    where kind='callback_email' and status in ('queued','running') and first_send_at<now()-interval '23 hours'
    and (lease_expires_at is null or lease_expires_at<=now());
  return query update public.service_jobs j set status='running',attempts=j.attempts+1,
    lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes'
    where j.job_key in(select q.job_key from public.service_jobs q where q.status in ('queued','running')
      and q.next_attempt_at<=now() and (q.lease_expires_at is null or q.lease_expires_at<=now())
      and (p_key is null or q.job_key=p_key) order by q.next_attempt_at,q.created_at
      for update skip locked limit least(greatest(p_limit,1),5)) returning j.*;
end $function$;

CREATE OR REPLACE FUNCTION public.configure_recepta_subscription(p_client_id uuid, p_configuration jsonb)
 RETURNS SETOF subscriptions
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_old public.subscriptions%rowtype;
  v_next public.subscriptions%rowtype;
  v_configuration jsonb;
  v_current jsonb;
begin
  select * into v_old from public.subscriptions where client_id=p_client_id for update;
  if not found then raise exception 'Subscription is not configured'; end if;
  if exists(select 1 from public.clients where id=p_client_id and deletion_pending) then raise exception 'Client is awaiting deletion'; end if;
  if jsonb_typeof(p_configuration) is distinct from 'object' or exists (
    select 1 from jsonb_object_keys(p_configuration) k where k not in
      ('plan_name','monthly_price','monthly_minutes','ai_model_id','pii_redaction_enabled',
       'safety_guardrails_enabled','extra_phone_numbers','phone_number_country','phone_number_area_code')
  ) then raise exception 'Only billing configuration may be changed'; end if;
  v_next := jsonb_populate_record(v_old,p_configuration);
  if v_next.plan_name not in ('Recepta Standard','Recepta Pro') or v_next.plan_name is null
    or v_next.monthly_minutes is null or v_next.monthly_minutes<1 or v_next.monthly_minutes>100000000
    or nullif(btrim(v_next.ai_model_id),'') is null or v_next.monthly_price is null or v_next.monthly_price<0
    or v_next.extra_phone_numbers is null or v_next.extra_phone_numbers<0 or v_next.extra_phone_numbers>20
    or v_next.pii_redaction_enabled is null or v_next.safety_guardrails_enabled is null
    then raise exception 'Invalid billing configuration'; end if;
  v_configuration := jsonb_build_object('plan_name',v_next.plan_name,'monthly_price',v_next.monthly_price,
    'monthly_minutes',v_next.monthly_minutes,'ai_model_id',v_next.ai_model_id,
    'pii_redaction_enabled',v_next.pii_redaction_enabled,'safety_guardrails_enabled',v_next.safety_guardrails_enabled,
    'extra_phone_numbers',v_next.extra_phone_numbers);
  v_current := jsonb_build_object('plan_name',v_old.plan_name,'monthly_price',v_old.monthly_price,
    'monthly_minutes',v_old.monthly_minutes,'ai_model_id',v_old.ai_model_id,
    'pii_redaction_enabled',v_old.pii_redaction_enabled,'safety_guardrails_enabled',v_old.safety_guardrails_enabled,
    'extra_phone_numbers',v_old.extra_phone_numbers);
  if p_configuration ? 'phone_number_country' then
    if p_configuration->>'phone_number_country' not in ('CA','US') then raise exception 'Invalid phone country'; end if;
    v_configuration := v_configuration || jsonb_build_object('phone_number_country',p_configuration->>'phone_number_country',
      'phone_number_area_code',p_configuration->>'phone_number_area_code');
  end if;
  if nullif(btrim(v_old.stripe_subscription_id),'') is null then
    return query update public.subscriptions set plan_name=v_next.plan_name,monthly_price=v_next.monthly_price,
      monthly_minutes=v_next.monthly_minutes,ai_model_id=v_next.ai_model_id,
      pii_redaction_enabled=v_next.pii_redaction_enabled,safety_guardrails_enabled=v_next.safety_guardrails_enabled,
      extra_phone_numbers=v_next.extra_phone_numbers,status='pending',rollover_seconds=0,
      current_period_start=null,current_period_end=null,next_billing_date=null,
      pending_configuration=v_configuration,configuration_revision=configuration_revision+1
      where client_id=p_client_id returning *;
  else
    -- Keep the original subscription, paid period and allowance intact, including
    -- cancelled/past-due state. Renewal cannot accidentally apply this quote.
    return query update public.subscriptions set
      pending_configuration=case when (v_configuration-'phone_number_country'-'phone_number_area_code')=v_current then null else v_configuration end,
      configuration_revision=configuration_revision+1
      where client_id=p_client_id returning *;
  end if;
end; $function$;

CREATE OR REPLACE FUNCTION public.disconnect_recepta_calendar(p_client_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,419));
  update public.booking_settings set enabled=false,updated_at=now() where client_id=p_client_id;
  delete from public.google_calendar_connections where client_id=p_client_id;
  delete from public.booking_calendar_events where client_id=p_client_id;
  delete from public.booking_calendar_jobs where client_id=p_client_id;
end $function$;

CREATE OR REPLACE FUNCTION public.enqueue_recepta_call_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_plan text;
begin
  if not new.owner_notification_requested or new.retell_call_id is null then return new; end if;
  select plan_name into v_plan from public.subscriptions
    where client_id=new.client_id and status='active';
  if v_plan in ('Recepta Standard','Recepta Pro') then
    insert into public.call_notifications(notification_key,client_id,call_record_id,retell_call_id,plan_name)
    values ('owner-call:' || new.client_id::text || ':' || new.retell_call_id,
      new.client_id,new.id,new.retell_call_id,v_plan)
    on conflict(notification_key) do nothing;
  end if;
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public.erase_recepta_call_content(p_call_id uuid, p_client_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_retell_id text;
begin
  update public.calls set content_erased_at=now(),provider_erased_at=now()
    where id=p_call_id and client_id=p_client_id returning retell_call_id into v_retell_id;
  update public.appointments set customer_name='Deleted caller',customer_email=null,customer_phone=null,
    company_name=null,service=null,notes=null where client_id=p_client_id and retell_call_id=v_retell_id;
  update public.call_notifications set mail_payload=null where client_id=p_client_id and retell_call_id=v_retell_id;
end $function$;

CREATE OR REPLACE FUNCTION public.finish_recepta_call_notification(p_key text, p_lease uuid, p_provider_id text DEFAULT NULL::text, p_error text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  update public.call_notifications set
    status=case when p_provider_id is not null then 'accepted' else 'queued' end,
    accepted_at=case when p_provider_id is not null then now() else null end,
    provider_message_id=p_provider_id,last_error=p_error,next_attempt_at=now()+interval '5 minutes',
    lease_token=null,lease_expires_at=null
  where notification_key=p_key and lease_token=p_lease and status='retrying';
  return found;
end; $function$;

CREATE OR REPLACE FUNCTION public.finish_recepta_service_job(p_key text, p_lease uuid, p_error text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  update public.service_jobs set status=case when p_error is null then 'complete' when attempts>=12 then 'needs_attention' else 'queued' end,
    completed_at=case when p_error is null then now() else null end,last_error=left(p_error,500),
    next_attempt_at=now()+interval '5 minutes',lease_token=null,lease_expires_at=null,
    payload=case when p_error is null and kind='delete_client' then '{}'::jsonb else payload end
    where job_key=p_key and lease_token=p_lease and status='running';
  return found;
end $function$;

CREATE OR REPLACE FUNCTION public.guard_recepta_booking()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_settings public.booking_settings; v_remaining integer; v_calendar public.google_calendar_connections;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.client_id::text,419));
  -- External changes reflect actual Google events even when a human exceeded capacity.
  -- Only server-only sync RPCs set this transaction-local flag.
  if current_setting('recepta.google_import',true)='on' then return new; end if;
  if new.status<>'booked' then return new; end if;
  if tg_op='UPDATE' and old.status='booked' and new.appointment_time is not distinct from old.appointment_time
    and new.appointment_end_time is not distinct from old.appointment_end_time
    and new.employee_id is not distinct from old.employee_id then return new; end if;
  select * into v_settings from public.booking_settings where client_id=new.client_id;
  if not found then raise exception 'Save your booking rules first.'; end if;
  if new.source='retell' and not v_settings.enabled then raise exception 'AI booking is not enabled for this account.'; end if;
  if not exists(select 1 from public.subscriptions where client_id=new.client_id and plan_name='Recepta Pro' and status='active'
    and stripe_subscription_id is not null and current_period_start<=now() and current_period_end>now()) then
    raise exception 'An active paid Recepta Pro plan is required to book.';
  end if;
  if new.appointment_time is null or new.appointment_end_time is null or new.appointment_end_time<=new.appointment_time
    or new.appointment_time<now() or new.appointment_time>now()+interval '90 days'
    or new.duration_minutes is null or new.duration_minutes not between 5 and 480 then raise exception 'Choose a valid future appointment within 90 days.'; end if;
  select * into v_calendar from public.google_calendar_connections where client_id=new.client_id;
  if found and (v_calendar.write_calendar_id is null or jsonb_array_length(v_calendar.selected_calendars)=0
    or v_calendar.sync_error is not null or v_calendar.synced_at is null or v_calendar.synced_at<now()-interval '60 seconds') then
    raise exception 'Google Calendar availability must be refreshed before booking.';
  end if;
  new.booking_buffer_minutes:=v_settings.buffer_minutes;
  v_remaining:=public.recepta_booking_remaining(new.client_id,
    new.appointment_time-make_interval(mins=>new.booking_buffer_minutes),
    new.appointment_end_time+make_interval(mins=>new.booking_buffer_minutes),new.id);
  if v_remaining<1 then raise exception 'That time is full. Choose another time.'; end if;
  if new.employee_id is not null and exists(select 1 from public.appointments a where a.client_id=new.client_id
    and a.employee_id=new.employee_id and a.id<>new.id and a.status='booked'
    and a.appointment_time-make_interval(mins=>a.booking_buffer_minutes)<new.appointment_end_time+make_interval(mins=>new.booking_buffer_minutes)
    and coalesce(a.appointment_end_time,a.appointment_time+make_interval(mins=>coalesce(a.duration_minutes,30)))+make_interval(mins=>a.booking_buffer_minutes)>new.appointment_time-make_interval(mins=>new.booking_buffer_minutes)) then
    raise exception 'The selected employee is already booked.';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.guard_recepta_deleting_client()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if exists(select 1 from public.clients where id=new.client_id and deletion_pending) then
    if tg_table_name='agents' then new.status:='paused';
    elsif new.status='active' then new.status:='cancelled'; end if;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.guard_recepta_deleting_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_deleting boolean;
begin
  -- Serialize insertion with deletion's client lock so a purchased number
  -- cannot appear after the deletion snapshot was taken.
  select deletion_pending into v_deleting from public.clients where id=new.client_id for share;
  if v_deleting then raise exception 'Client is awaiting deletion'; end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select recepta_private.is_admin();
$function$;

CREATE OR REPLACE FUNCTION public.prepare_recepta_call_notification(p_key text, p_lease uuid, p_payload jsonb)
 RETURNS SETOF call_notifications
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  update public.call_notifications set mail_payload=coalesce(mail_payload,p_payload),
    first_send_at=coalesce(first_send_at,now())
  where notification_key=p_key and lease_token=p_lease and status='retrying' and lease_expires_at>now()
  returning *;
$function$;

CREATE OR REPLACE FUNCTION public.protect_recepta_call_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_incoming_rank smallint;
begin
  if tg_op = 'UPDATE' and old.retell_call_id is not null and
    (new.client_id is distinct from old.client_id or new.retell_call_id is distinct from old.retell_call_id) then
    raise exception 'A Retell call cannot be reassigned to another client or call ID';
  end if;
  if new.retell_call_id is null then return new; end if;

  -- Infer a minimum rank too, so older writers cannot bypass the status guard.
  v_incoming_rank := case
    when new.call_status = 'registered' then 0
    when new.call_status = 'ongoing' then 1
    else greatest(new.lifecycle_rank, case
      when new.lifecycle_rank = 0 and (new.summary is not null or new.user_sentiment is not null or new.call_successful is not null) then 3
      when new.call_status in ('ended','error','not_connected') or new.ended_at is not null then 2
      else 0 end) end;

  if tg_op = 'UPDATE' then
    if v_incoming_rank < old.lifecycle_rank then
      new.call_status := old.call_status;
      new.outcome := coalesce(old.outcome,new.outcome);
      new.appointment_booked := old.appointment_booked;
      new.caller_name := coalesce(old.caller_name,new.caller_name);
      new.caller_number := coalesce(old.caller_number,new.caller_number);
      new.disconnection_reason := coalesce(old.disconnection_reason,new.disconnection_reason);
      new.summary := coalesce(old.summary,new.summary);
      new.user_sentiment := coalesce(old.user_sentiment,new.user_sentiment);
      new.call_successful := coalesce(old.call_successful,new.call_successful);
    else
      new.caller_name := coalesce(new.caller_name,old.caller_name);
      new.caller_number := coalesce(new.caller_number,old.caller_number);
      new.disconnection_reason := coalesce(new.disconnection_reason,old.disconnection_reason);
      new.summary := coalesce(new.summary,old.summary);
      new.user_sentiment := coalesce(new.user_sentiment,old.user_sentiment);
      new.call_successful := coalesce(new.call_successful,old.call_successful);
      new.outcome := coalesce(new.outcome,old.outcome);
    end if;

    -- Terminal calls and connected calls never return to an earlier state, even
    -- when an old writer omits lifecycle_rank and inherits the stored value.
    if old.call_status in ('ended','error','not_connected') then
      new.call_status := old.call_status;
    elsif old.call_status = 'ongoing' and new.call_status = 'registered' then
      new.call_status := old.call_status;
    end if;
    new.lifecycle_rank := greatest(old.lifecycle_rank,v_incoming_rank);
    new.duration_seconds := greatest(old.duration_seconds,new.duration_seconds,0);
    new.started_at := least(old.started_at,new.started_at);
    new.ended_at := greatest(old.ended_at,new.ended_at);
    new.retell_agent_id := coalesce(old.retell_agent_id,new.retell_agent_id);
    new.owner_notification_requested := old.owner_notification_requested or new.owner_notification_requested;
    new.updated_at := greatest(old.updated_at,new.updated_at);

    -- Null/missing media on a sparse replay cannot erase known media. Enabling
    -- redaction is the exception: discard raw data even if scrubbed data is absent.
    if old.media_redacted and not new.media_redacted then
      new.transcript := old.transcript;
      new.recording_url := old.recording_url;
    elsif new.media_redacted and not old.media_redacted then
      null; -- Keep only the incoming scrubbed values, including null.
    elsif v_incoming_rank < old.lifecycle_rank then
      new.transcript := coalesce(old.transcript,new.transcript);
      new.recording_url := coalesce(old.recording_url,new.recording_url);
    else
      new.transcript := coalesce(new.transcript,old.transcript);
      new.recording_url := coalesce(new.recording_url,old.recording_url);
    end if;
    new.media_redacted := old.media_redacted or new.media_redacted;
  else
    new.lifecycle_rank := v_incoming_rank;
  end if;

  if new.lifecycle_rank >= 2 then
    if new.call_status is null or new.call_status not in ('ended','error','not_connected') then
      new.call_status := 'ended';
    end if;
    if new.call_successful is not null then
      new.outcome := case when new.call_successful then 'Successful' else 'Unsuccessful' end;
    elsif new.outcome is null or new.outcome = 'In progress' then
      new.outcome := coalesce(new.disconnection_reason,'Completed');
    end if;
  end if;
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public.protect_recepta_erased_appointment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if exists(select 1 from public.calls where client_id=new.client_id and retell_call_id=new.retell_call_id and content_erased_at is not null) then
    new.customer_name:='Deleted caller';new.customer_email:=null;new.customer_phone:=null;
    new.company_name:=null;new.service:=null;new.notes:=null;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.protect_recepta_erased_content()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if (tg_op='UPDATE' and old.content_erased_at is not null) or new.content_erased_at is not null then
    new.caller_name:=null;new.caller_number:=null;new.transcript:=null;new.recording_url:=null;new.summary:=null;
    new.outcome:=null;new.content_erased_at:=case when tg_op='UPDATE' then coalesce(old.content_erased_at,new.content_erased_at,now()) else coalesce(new.content_erased_at,now()) end;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.queue_recepta_calendar_booking()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_calendar text;
begin
  if current_setting('recepta.google_import',true)='on' then return new; end if;
  if tg_op='UPDATE' and new.booking_version=old.booking_version then return new; end if;
  if new.status not in ('booked','cancelled') or new.appointment_time is null then return new; end if;
  select write_calendar_id into v_calendar from public.google_calendar_connections where client_id=new.client_id;
  if v_calendar is null then return new; end if;
  insert into public.booking_calendar_jobs(appointment_id,client_id,version,calendar_id) values(new.id,new.client_id,new.booking_version,v_calendar)
  on conflict(appointment_id) do update set version=excluded.version,retry_at=now(),last_error=null;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.queue_recepta_retention()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_count integer;
begin
  insert into public.service_jobs(job_key,client_id,kind,payload)
    select 'retention:'||c.id::text,c.client_id,'retention_call',jsonb_build_object('call_id',c.id,'retell_call_id',c.retell_call_id)
    from public.calls c join public.clients owner on owner.id=c.client_id
    where c.provider_erased_at is null and c.call_status in ('ended','error','not_connected')
      and c.started_at<now()-make_interval(days=>owner.call_retention_days) and not owner.deletion_pending
    order by c.started_at limit 100 on conflict(job_key) do nothing;
  get diagnostics v_count=row_count;
  delete from public.callback_requests r using public.clients c where r.client_id=c.id and r.created_at<now()-make_interval(days=>c.call_retention_days);
  update public.service_jobs j set status='complete',mail_payload=null,payload='{}',completed_at=now(),
    last_error='Callback content expired under the retention policy.',lease_token=null,lease_expires_at=null
    from public.clients c where j.client_id=c.id and j.kind='callback_email' and j.status<>'complete'
      and j.created_at<now()-make_interval(days=>c.call_retention_days);
  update public.service_jobs set mail_payload=null,payload='{}' where kind='callback_email' and status='complete' and completed_at<now()-interval '30 days';
  update public.billing_notifications set mail_payload=null,payload='{}' where sent_at<now()-interval '30 days';
  update public.call_notifications set mail_payload=null where accepted_at<now()-interval '30 days';
  delete from public.email_delivery_receipts where created_at<now()-interval '30 days';
  delete from public.service_jobs where status='complete' and completed_at<now()-interval '30 days';
  return v_count;
end $function$;

CREATE OR REPLACE FUNCTION public.recepta_book_employee_appointment(p_client_id uuid, p_employee_id uuid, p_start timestamp with time zone, p_duration_minutes integer, p_customer_name text, p_customer_email text DEFAULT NULL::text, p_customer_phone text DEFAULT NULL::text, p_company_name text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_internal_notes text DEFAULT NULL::text, p_source text DEFAULT 'dashboard'::text, p_retell_call_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_end timestamptz;
  v_appointment_id uuid;
begin
  if auth.uid() is not null and auth.uid() <> p_client_id then
    raise exception 'You cannot book an appointment for another account.';
  end if;

  if p_duration_minutes < 5 or p_duration_minutes > 480 then
    raise exception 'Appointment duration must be between 5 and 480 minutes.';
  end if;

  if not exists (
    select 1
    from public.employees
    where id = p_employee_id
      and client_id = p_client_id
      and is_active = true
  ) then
    raise exception 'The selected employee is not active for this account.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text, 0));
  v_end := p_start + make_interval(mins => p_duration_minutes);

  if exists (
    select 1
    from public.appointments
    where employee_id = p_employee_id
      and status = 'booked'
      and appointment_time < v_end
      and coalesce(
        appointment_end_time,
        appointment_time + make_interval(mins => greatest(duration_minutes, 1))
      ) > p_start
  ) then
    raise exception 'That employee already has an appointment during this time.';
  end if;

  if exists (
    select 1
    from public.employee_calendar_blocks
    where employee_id = p_employee_id
      and starts_at < v_end
      and ends_at > p_start
  ) then
    raise exception 'That employee is unavailable during this time.';
  end if;

  insert into public.appointments (
    client_id,
    employee_id,
    customer_name,
    customer_email,
    customer_phone,
    company_name,
    service,
    notes,
    internal_notes,
    appointment_time,
    appointment_end_time,
    duration_minutes,
    status,
    source,
    retell_call_id,
    updated_at
  ) values (
    p_client_id,
    p_employee_id,
    nullif(trim(p_customer_name), ''),
    nullif(trim(coalesce(p_customer_email, '')), ''),
    nullif(trim(coalesce(p_customer_phone, '')), ''),
    nullif(trim(coalesce(p_company_name, '')), ''),
    nullif(trim(coalesce(p_service, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    nullif(trim(coalesce(p_internal_notes, '')), ''),
    p_start,
    v_end,
    p_duration_minutes,
    'booked',
    p_source,
    nullif(trim(coalesce(p_retell_call_id, '')), ''),
    now()
  )
  returning id into v_appointment_id;

  return v_appointment_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.recepta_booking_remaining(p_client_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_exclude uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with settings as (select coalesce((select capacity from public.booking_settings where client_id=p_client_id),1) as capacity),
  occupied as (
    select a.appointment_time-make_interval(mins=>a.booking_buffer_minutes) as s,
      coalesce(a.appointment_end_time,a.appointment_time+make_interval(mins=>coalesce(a.duration_minutes,30)))+make_interval(mins=>a.booking_buffer_minutes) as e
    from public.appointments a where a.client_id=p_client_id and a.status='booked' and (p_exclude is null or a.id<>p_exclude)
    union all
    select e.starts_at,e.ends_at from public.booking_calendar_events e where e.client_id=p_client_id
      and not exists(select 1 from public.appointments a where a.id=e.local_appointment_id and a.client_id=p_client_id and a.status='booked')
  ), relevant as (select * from occupied where s<p_end and e>p_start),
  probes as (select p_start as t union select s from relevant where s>=p_start),
  peak as (select coalesce(max((select count(*) from relevant where s<=t and e>t)),0)::integer as n from probes)
  select settings.capacity-peak.n from settings,peak;
$function$;

CREATE OR REPLACE FUNCTION public.recepta_committed_usage(p_client_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(sum(amount),0)::bigint from (
    select greatest(c.duration_seconds,0)::bigint as amount
    from public.calls c left join public.call_minute_reservations r
      on r.client_id=c.client_id and r.retell_call_id=c.retell_call_id
    where c.client_id=p_client_id and (
      r.period_start=p_period_start or (r.id is null and
        c.started_at >= p_period_start and c.started_at < p_period_end))
    union all
    select greatest(greatest(r.reserved_seconds,coalesce(r.used_seconds,0))
      - greatest(coalesce(c.duration_seconds,0),0),0)::bigint
    from public.call_minute_reservations r left join public.calls c
      on c.client_id=r.client_id and c.retell_call_id=r.retell_call_id
    where r.client_id=p_client_id and r.period_start=p_period_start
      and (c.call_status is null or c.call_status not in ('ended','error','not_connected'))
  ) commitments;
$function$;

CREATE OR REPLACE FUNCTION public.recepta_create_employee_block(p_client_id uuid, p_employee_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_title text, p_details text DEFAULT NULL::text, p_block_type text DEFAULT 'unavailable'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_block_id uuid;
begin
  if auth.uid() is not null and auth.uid() <> p_client_id then
    raise exception 'You cannot block time for another account.';
  end if;

  if p_end <= p_start then
    raise exception 'The blocked time must end after it starts.';
  end if;

  if p_block_type not in ('unavailable', 'break', 'meeting', 'time_off') then
    raise exception 'Choose a valid blocked-time type.';
  end if;

  if not exists (
    select 1
    from public.employees
    where id = p_employee_id
      and client_id = p_client_id
  ) then
    raise exception 'The selected employee does not belong to this account.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text, 0));

  if exists (
    select 1
    from public.appointments
    where employee_id = p_employee_id
      and status = 'booked'
      and appointment_time < p_end
      and coalesce(
        appointment_end_time,
        appointment_time + make_interval(mins => greatest(duration_minutes, 1))
      ) > p_start
  ) then
    raise exception 'This blocked time overlaps an existing appointment.';
  end if;

  if exists (
    select 1
    from public.employee_calendar_blocks
    where employee_id = p_employee_id
      and starts_at < p_end
      and ends_at > p_start
  ) then
    raise exception 'This blocked time overlaps another calendar block.';
  end if;

  insert into public.employee_calendar_blocks (
    client_id,
    employee_id,
    title,
    details,
    block_type,
    starts_at,
    ends_at,
    updated_at
  ) values (
    p_client_id,
    p_employee_id,
    trim(p_title),
    nullif(trim(coalesce(p_details, '')), ''),
    p_block_type,
    p_start,
    p_end,
    now()
  )
  returning id into v_block_id;

  return v_block_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.recepta_period_usage(p_client_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(sum(greatest(c.duration_seconds,0)),0)::bigint
  from public.calls c left join public.call_minute_reservations r
    on r.client_id=c.client_id and r.retell_call_id=c.retell_call_id
  where c.client_id=p_client_id and (
    r.period_start=p_period_start or (r.id is null and
      c.started_at >= p_period_start and c.started_at < p_period_end));
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_recepta_email_delivery()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.provider_message_id is not null and (tg_op='INSERT' or old.provider_message_id is distinct from new.provider_message_id) then
    perform public.apply_recepta_email_delivery(new.provider_message_id);
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.record_recepta_callback(p_client_id uuid, p_call_id text, p_from text, p_to text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_id uuid;
begin
  if not exists(select 1 from public.clients where id=p_client_id and not deletion_pending) then return; end if;
  insert into public.callback_requests(client_id,retell_call_id,caller_number,called_number,reason)
    values(p_client_id,p_call_id,p_from,p_to,p_reason) on conflict(retell_call_id) do nothing returning id into v_id;
  if v_id is not null then
    insert into public.service_jobs(job_key,client_id,kind,payload)
      values('callback:'||p_client_id::text||':'||p_call_id,p_client_id,'callback_email',jsonb_build_object('callback_id',v_id));
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.renew_recepta_subscription(p_stripe_subscription_id text, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS SETOF subscriptions
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_subscription public.subscriptions%rowtype;
  v_used bigint := 0;
  v_monthly bigint := 0;
  v_rollover bigint := 0;
begin
  if p_period_end <= p_period_start then
    raise exception 'Invalid billing period';
  end if;
  select * into v_subscription from public.subscriptions
    where stripe_subscription_id = p_stripe_subscription_id for update;
  if not found then return; end if;
  if exists(select 1 from public.clients where id=v_subscription.client_id and deletion_pending) then return; end if;
  if v_subscription.current_period_start > p_period_start then return; end if;
  if v_subscription.current_period_start = p_period_start
    and v_subscription.current_period_end <> p_period_end then return; end if;

  v_monthly := greatest(coalesce(v_subscription.monthly_minutes, 0), 0)::bigint * 60;
  v_rollover := least(greatest(coalesce(v_subscription.rollover_seconds, 0), 0), v_monthly);
  if v_subscription.current_period_start < p_period_start then
    -- A gap in paid cycles forfeits the old allowance. Only a consecutive
    -- paid renewal can carry minutes into the new cycle.
    if v_subscription.current_period_end = p_period_start then
      v_used := public.recepta_committed_usage(v_subscription.client_id,
        v_subscription.current_period_start,p_period_start);
      v_rollover := greatest(v_monthly - greatest(v_used - v_rollover, 0), 0);
    else
      v_rollover := 0;
    end if;
  elsif v_subscription.current_period_start is null then
    v_rollover := 0;
  end if;

  return query update public.subscriptions set
    status = 'active', rollover_seconds = v_rollover,
    current_period_start = p_period_start, current_period_end = p_period_end,
    next_billing_date = p_period_end
    where client_id = v_subscription.client_id returning *;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_recepta_agent_call(p_client_id uuid, p_call_id text, p_agent_id text)
 RETURNS TABLE(reservation_id uuid, reserved_seconds integer, demo_mode boolean)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_subscription public.subscriptions%rowtype;
  v_existing public.call_minute_reservations%rowtype;
  v_monthly bigint;
  v_allowance bigint;
  v_remaining bigint;
  v_seconds integer;
  v_id uuid;
  v_now timestamptz;
  v_demo boolean;
begin
  if p_call_id is null or btrim(p_call_id)='' or length(p_call_id)>512 then return; end if;
  -- This also serializes admission with paid renewals and Checkout activation.
  select * into v_subscription from public.subscriptions where client_id=p_client_id for update;
  if not found then return; end if;
  v_now := clock_timestamp();
  if v_subscription.status is distinct from 'active' or nullif(btrim(v_subscription.stripe_subscription_id),'') is null or v_subscription.current_period_start is null
    or v_subscription.current_period_end is null or v_subscription.current_period_start>v_now
    or v_subscription.current_period_end<=v_now or coalesce(v_subscription.monthly_minutes,0)<1 then return; end if;

  select a.demo_mode into v_demo from public.agents a
    where a.client_id=p_client_id and a.retell_agent_id=p_agent_id and a.status in ('live','active');
  if not found then return; end if;

  select * into v_existing from public.call_minute_reservations where retell_call_id=p_call_id;
  if found then
    if v_existing.client_id<>p_client_id then raise exception 'Retell call belongs to another client'; end if;
    if v_existing.period_start=v_subscription.current_period_start and v_existing.status='active'
      and (v_existing.retell_agent_id is null or v_existing.retell_agent_id=p_agent_id)
      and not exists(select 1 from public.calls where client_id=p_client_id and retell_call_id=p_call_id
        and call_status in ('ended','error','not_connected')) then
      return query select v_existing.id,v_existing.reserved_seconds,v_existing.demo_mode;
    end if;
    return;
  end if;
  if exists(select 1 from public.calls where retell_call_id=p_call_id
    and (client_id<>p_client_id or call_status in ('ended','error','not_connected'))) then return; end if;

  v_monthly := v_subscription.monthly_minutes::bigint*60;
  v_allowance := v_monthly + least(greatest(coalesce(v_subscription.rollover_seconds,0),0),v_monthly);
  v_remaining := greatest(v_allowance-public.recepta_committed_usage(p_client_id,
    v_subscription.current_period_start,v_subscription.current_period_end),0);
  -- Demo agents get 3 minutes. Customer calls have no Recepta 3-minute timer;
  -- their bound is remaining paid time and Retell's 2-hour technical maximum.
  v_seconds := least(v_remaining,case when v_demo then 180 else 7200 end,floor(extract(epoch from v_subscription.current_period_end-v_now))::bigint)::integer;
  if v_seconds<60 then return; end if;
  insert into public.call_minute_reservations(client_id,retell_call_id,period_start,period_end,reserved_seconds,retell_agent_id,demo_mode)
    values(p_client_id,p_call_id,v_subscription.current_period_start,v_subscription.current_period_end,v_seconds,p_agent_id,v_demo)
    returning id into v_id;
  return query select v_id,v_seconds,v_demo;
end; $function$;

CREATE OR REPLACE FUNCTION public.reserve_recepta_booking(p_client_id uuid, p_booking_key text, p_details jsonb, p_id uuid DEFAULT NULL::uuid, p_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare a public.appointments; v_start timestamptz; v_duration integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,419));
  if nullif(btrim(p_booking_key),'') is null then raise exception 'A booking request key is required.'; end if;
  insert into public.booking_settings(client_id) values(p_client_id) on conflict(client_id) do nothing;
  if p_id is null then
    select * into a from public.appointments where client_id=p_client_id and
      (booking_key=p_booking_key or (p_details->>'retell_call_id' is not null and retell_call_id=p_details->>'retell_call_id'));
    if found and a.status<>'pending' then return to_jsonb(a); end if;
  else
    select * into a from public.appointments where client_id=p_client_id and id=p_id;
    if not found then raise exception 'Booking not found.'; end if;
    if a.status='cancelled' or a.booking_version is distinct from p_version then raise exception 'This booking changed. Refresh before editing.'; end if;
  end if;
  if nullif(btrim(p_details->>'customer_name'),'') is null then raise exception 'Customer name is required.'; end if;
  v_start:=(p_details->>'start')::timestamptz;
  v_duration:=(p_details->>'duration_minutes')::integer;
  if a.id is null then
    insert into public.appointments(client_id,booking_key,customer_name,customer_phone,customer_email,service,notes,employee_id,
      appointment_time,appointment_end_time,duration_minutes,status,source,retell_call_id)
    values(p_client_id,p_booking_key,p_details->>'customer_name',p_details->>'customer_phone',p_details->>'customer_email',
      p_details->>'service',p_details->>'notes',nullif(p_details->>'employee_id','')::uuid,
      v_start,v_start+make_interval(mins=>v_duration),v_duration,'booked',coalesce(p_details->>'source','dashboard'),p_details->>'retell_call_id') returning * into a;
  else
    update public.appointments set booking_key=coalesce(booking_key,p_booking_key),customer_name=p_details->>'customer_name',
      customer_phone=p_details->>'customer_phone',customer_email=p_details->>'customer_email',service=p_details->>'service',notes=p_details->>'notes',
      employee_id=nullif(p_details->>'employee_id','')::uuid,appointment_time=v_start,appointment_end_time=v_start+make_interval(mins=>v_duration),
      duration_minutes=v_duration,status='booked',booking_version=booking_version+1,updated_at=now()
    where id=a.id returning * into a;
  end if;
  return to_jsonb(a);
end $function$;

CREATE OR REPLACE FUNCTION public.reserve_recepta_call(p_client_id uuid, p_monthly_seconds bigint, p_period_start timestamp with time zone)
 RETURNS TABLE(reservation_id uuid, reserved_seconds integer)
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select null::uuid,null::integer where false;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_recepta_inbound_call(p_client_id uuid, p_call_id text)
 RETURNS TABLE(reservation_id uuid, reserved_seconds integer)
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select null::uuid,null::integer where false;
$function$;

CREATE OR REPLACE FUNCTION public.settle_recepta_call_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.retell_call_id is not null and new.call_status in ('ended','error','not_connected') then
    update public.call_minute_reservations set status='completed',
      used_seconds=greatest(coalesce(used_seconds,0),new.duration_seconds,0),
      completed_at=coalesce(completed_at,new.ended_at,now())
    where client_id=new.client_id and retell_call_id=new.retell_call_id;
  end if;
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public.start_recepta_client_deletion(p_client_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_job text:='delete-client:'||p_client_id::text; v_client public.clients%rowtype; v_payload jsonb;
begin
  select * into v_client from public.clients where id=p_client_id for update;
  if not found then
    if exists(select 1 from public.service_jobs where job_key=v_job) then return v_job; end if;
    raise exception 'Client not found';
  end if;
  if v_client.role='admin' then raise exception 'An admin account cannot be deleted here'; end if;
  perform 1 from public.subscriptions where client_id=p_client_id for update;
  select jsonb_build_object('stripe_customer_id',s.stripe_customer_id,'stripe_subscription_id',s.stripe_subscription_id,
    'agent_id',a.retell_agent_id,'numbers',coalesce((select jsonb_agg(jsonb_build_object('number',n.phone_number,'source',n.source)) from public.agent_phone_numbers n where n.client_id=p_client_id),'[]'::jsonb))
    into v_payload from public.clients c left join public.subscriptions s on s.client_id=c.id
    left join public.agents a on a.client_id=c.id where c.id=p_client_id;
  v_payload:=jsonb_set(v_payload,'{numbers}',coalesce(v_payload->'numbers','[]'::jsonb)||coalesce((
    select jsonb_agg(jsonb_build_object('number',a.phone_number,'source','manual')) from public.agents a
    where a.client_id=p_client_id and a.phone_number is not null and not exists(
      select 1 from public.agent_phone_numbers n where n.client_id=p_client_id and n.phone_number=a.phone_number)
  ),'[]'::jsonb));
  insert into public.service_jobs(job_key,client_id,kind,payload) values(v_job,p_client_id,'delete_client',v_payload)
    on conflict(job_key) do nothing;
  update public.clients set deletion_pending=true,status='paused' where id=p_client_id;
  update public.agents set status='paused' where client_id=p_client_id;
  return v_job;
end $function$;

CREATE OR REPLACE FUNCTION public.sync_recepta_calendar_snapshot(p_client_id uuid, p_events jsonb, p_synced_at timestamp with time zone, p_connection_version timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare e jsonb; v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,419));
  if p_connection_version is not null and not exists(select 1 from public.google_calendar_connections where client_id=p_client_id and updated_at=p_connection_version) then
    raise exception 'Google Calendar connection changed. Refresh availability again.';
  end if;
  perform set_config('recepta.google_import','on',true);
  delete from public.booking_calendar_events where client_id=p_client_id;
  for e in select * from jsonb_array_elements(p_events) loop
    v_id:=null;
    if e->>'event_id' ~ '^recepta[0-9a-f]{32}$' then
      select id into v_id from public.appointments where client_id=p_client_id and google_calendar_id=e->>'calendar_id'
        and 'recepta'||replace(id::text,'-','')=e->>'event_id'
        and not exists(select 1 from public.booking_calendar_jobs where appointment_id=appointments.id);
    end if;
    if v_id is not null then
      if (e->>'cancelled')::boolean then
        update public.appointments set status='cancelled',booking_version=booking_version+1,updated_at=now() where id=v_id and status='booked';
      elsif (e->>'ends_at')::timestamptz-(e->>'starts_at')::timestamptz between interval '5 minutes' and interval '480 minutes' then
        update public.appointments set appointment_time=(e->>'starts_at')::timestamptz,appointment_end_time=(e->>'ends_at')::timestamptz,
          duration_minutes=extract(epoch from ((e->>'ends_at')::timestamptz-(e->>'starts_at')::timestamptz))/60,
          booking_version=booking_version+1,updated_at=now()
        where id=v_id and status='booked' and (appointment_time is distinct from (e->>'starts_at')::timestamptz or appointment_end_time is distinct from (e->>'ends_at')::timestamptz);
      else v_id:=null;
      end if;
    end if;
    if not coalesce((e->>'cancelled')::boolean,false) then
      insert into public.booking_calendar_events(client_id,calendar_id,event_id,starts_at,ends_at,title,html_link,local_appointment_id)
      values(p_client_id,e->>'calendar_id',e->>'event_id',(e->>'starts_at')::timestamptz,(e->>'ends_at')::timestamptz,
        coalesce(e->>'title','Calendar appointment'),e->>'html_link',v_id);
    end if;
  end loop;
  update public.google_calendar_connections set synced_at=p_synced_at,sync_error=null where client_id=p_client_id;
end $function$;

CREATE OR REPLACE FUNCTION public.update_recepta_booking_settings(p_client_id uuid, p_enabled boolean, p_capacity integer, p_duration integer, p_buffer integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,419));
  insert into public.booking_settings(client_id,enabled,capacity,duration_minutes,buffer_minutes)
    values(p_client_id,p_enabled,p_capacity,p_duration,p_buffer)
  on conflict(client_id) do update set enabled=p_enabled,capacity=p_capacity,duration_minutes=p_duration,buffer_minutes=p_buffer,updated_at=now();
end $function$;

CREATE INDEX agent_phone_numbers_client_id_idx ON public.agent_phone_numbers USING btree (client_id);

CREATE UNIQUE INDEX agent_phone_numbers_one_primary_idx ON public.agent_phone_numbers USING btree (client_id) WHERE is_primary;

alter table public."agent_phone_numbers" enable row level security;

create policy "account_available" on public."agent_phone_numbers" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

create policy "recepta_clients_read_own_phone_numbers" on public."agent_phone_numbers" as PERMISSIVE for SELECT to "authenticated" using ((client_id = auth.uid()));

CREATE UNIQUE INDEX agents_retell_agent_id_key ON public.agents USING btree (retell_agent_id) WHERE (retell_agent_id IS NOT NULL);

CREATE UNIQUE INDEX agents_retell_agent_id_unique ON public.agents USING btree (retell_agent_id) WHERE (retell_agent_id IS NOT NULL);

CREATE INDEX idx_agents_retell_agent_id ON public.agents USING btree (retell_agent_id);

alter table public."agents" enable row level security;

create policy "Admins can update agents" on public."agents" as PERMISSIVE for UPDATE to "authenticated" using ((EXISTS ( SELECT 1
   FROM clients me
  WHERE ((me.id = auth.uid()) AND (me.role = 'admin'::text))))) with check ((EXISTS ( SELECT 1
   FROM clients me
  WHERE ((me.id = auth.uid()) AND (me.role = 'admin'::text)))));

create policy "Clients can view their own agents" on public."agents" as PERMISSIVE for SELECT to "authenticated" using ((client_id = auth.uid()));

create policy "account_available" on public."agents" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

alter table public."ai_models" enable row level security;

create policy "Authenticated users can view active AI models" on public."ai_models" as PERMISSIVE for SELECT to "authenticated" using ((is_active = true));

CREATE INDEX appointment_customer_contacts_client_idx ON public.appointment_customer_contacts USING btree (client_id, name);

alter table public."appointment_customer_contacts" enable row level security;

create policy "account_available" on public."appointment_customer_contacts" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

create policy "recepta_clients_manage_own_appointment_contacts" on public."appointment_customer_contacts" as PERMISSIVE for ALL to "authenticated" using ((client_id = auth.uid())) with check ((client_id = auth.uid()));

create policy "recepta_clients_read_own_appointment_contacts" on public."appointment_customer_contacts" as PERMISSIVE for SELECT to "authenticated" using ((client_id = auth.uid()));

CREATE UNIQUE INDEX appointments_booking_key_idx ON public.appointments USING btree (client_id, booking_key) WHERE (booking_key IS NOT NULL);

CREATE INDEX appointments_client_booked_time_idx ON public.appointments USING btree (client_id, appointment_time) WHERE (status = 'booked'::text);

CREATE INDEX appointments_employee_time_idx ON public.appointments USING btree (employee_id, appointment_time) WHERE (status = 'booked'::text);

CREATE UNIQUE INDEX appointments_retell_call_id_key ON public.appointments USING btree (retell_call_id) WHERE (retell_call_id IS NOT NULL);

alter table public."appointments" enable row level security;

create policy "Clients can view their own appointments" on public."appointments" as PERMISSIVE for SELECT to "authenticated" using ((client_id = auth.uid()));

create policy "account_available" on public."appointments" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

CREATE INDEX billing_notifications_pending_idx ON public.billing_notifications USING btree (created_at) WHERE (sent_at IS NULL);

CREATE INDEX billing_notifications_provider_idx ON public.billing_notifications USING btree (provider_message_id) WHERE (provider_message_id IS NOT NULL);

alter table public."billing_notifications" enable row level security;

create policy "service_only" on public."billing_notifications" as PERMISSIVE for ALL to "service_role" using (true) with check (true);

CREATE INDEX booking_calendar_events_local_idx ON public.booking_calendar_events USING btree (local_appointment_id);

CREATE INDEX booking_calendar_events_time_idx ON public.booking_calendar_events USING btree (client_id, starts_at, ends_at);

alter table public."booking_calendar_events" enable row level security;

CREATE INDEX booking_calendar_jobs_client_idx ON public.booking_calendar_jobs USING btree (client_id);

CREATE INDEX booking_calendar_jobs_retry_idx ON public.booking_calendar_jobs USING btree (retry_at);

alter table public."booking_calendar_jobs" enable row level security;

alter table public."booking_settings" enable row level security;

CREATE INDEX call_minute_reservations_client_status_idx ON public.call_minute_reservations USING btree (client_id, status, period_start);

CREATE UNIQUE INDEX call_minute_reservations_retell_call_id_key ON public.call_minute_reservations USING btree (retell_call_id) WHERE (retell_call_id IS NOT NULL);

alter table public."call_minute_reservations" enable row level security;

create policy "service_only" on public."call_minute_reservations" as PERMISSIVE for ALL to "service_role" using (true) with check (true);

CREATE INDEX call_notifications_client_idx ON public.call_notifications USING btree (client_id, retell_call_id);

CREATE INDEX call_notifications_due_idx ON public.call_notifications USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'retrying'::text]));

CREATE INDEX call_notifications_provider_idx ON public.call_notifications USING btree (provider_message_id) WHERE (provider_message_id IS NOT NULL);

alter table public."call_notifications" enable row level security;

create policy "service_only" on public."call_notifications" as PERMISSIVE for ALL to "service_role" using (true) with check (true);

CREATE INDEX callback_requests_client_idx ON public.callback_requests USING btree (client_id, created_at DESC);

alter table public."callback_requests" enable row level security;

create policy "service_only" on public."callback_requests" as PERMISSIVE for ALL to "service_role" using (true) with check (true);

CREATE INDEX calls_client_period_idx ON public.calls USING btree (client_id, started_at);

CREATE INDEX calls_retention_due_idx ON public.calls USING btree (started_at) WHERE (provider_erased_at IS NULL);

CREATE INDEX idx_calls_retell_call_id ON public.calls USING btree (retell_call_id);

alter table public."calls" enable row level security;

create policy "Clients can view their own calls" on public."calls" as PERMISSIVE for SELECT to "authenticated" using ((client_id = auth.uid()));

create policy "account_available" on public."calls" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

create policy "recepta_clients_read_own_calls" on public."calls" as PERMISSIVE for SELECT to "authenticated" using ((client_id = auth.uid()));

alter table public."clients" enable row level security;

create policy "Admins can update clients" on public."clients" as PERMISSIVE for UPDATE to "authenticated" using (is_admin()) with check (is_admin());

create policy "Admins can view all clients" on public."clients" as PERMISSIVE for SELECT to "authenticated" using (is_admin());

create policy "Clients can view their own profile" on public."clients" as PERMISSIVE for SELECT to "authenticated" using ((( SELECT auth.uid() AS uid) = id));

create policy "account_available" on public."clients" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

CREATE INDEX customer_requests_client_id_idx ON public.customer_requests USING btree (client_id, created_at DESC);

CREATE INDEX customer_requests_status_idx ON public.customer_requests USING btree (status, created_at DESC);

alter table public."customer_requests" enable row level security;

create policy "account_available" on public."customer_requests" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

create policy "recepta_clients_create_own_requests" on public."customer_requests" as PERMISSIVE for INSERT to "authenticated" with check ((client_id = auth.uid()));

create policy "recepta_clients_read_own_requests" on public."customer_requests" as PERMISSIVE for SELECT to "authenticated" using ((client_id = auth.uid()));

CREATE INDEX email_delivery_receipts_provider_idx ON public.email_delivery_receipts USING btree (provider_message_id, event_at DESC);

alter table public."email_delivery_receipts" enable row level security;

create policy "service_only" on public."email_delivery_receipts" as PERMISSIVE for ALL to "service_role" using (true) with check (true);

CREATE INDEX employee_calendar_blocks_lookup_idx ON public.employee_calendar_blocks USING btree (employee_id, starts_at, ends_at);

alter table public."employee_calendar_blocks" enable row level security;

create policy "account_available" on public."employee_calendar_blocks" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

create policy "recepta_clients_manage_own_calendar_blocks" on public."employee_calendar_blocks" as PERMISSIVE for ALL to "authenticated" using ((client_id = auth.uid())) with check ((client_id = auth.uid()));

create policy "recepta_clients_read_own_calendar_blocks" on public."employee_calendar_blocks" as PERMISSIVE for SELECT to "authenticated" using ((client_id = auth.uid()));

CREATE INDEX employee_schedule_overrides_employee_date_idx ON public.employee_schedule_overrides USING btree (employee_id, schedule_date);

CREATE INDEX idx_employee_schedule_overrides_employee_id ON public.employee_schedule_overrides USING btree (employee_id);

alter table public."employee_schedule_overrides" enable row level security;

create policy "Clients can delete own employee schedule overrides" on public."employee_schedule_overrides" as PERMISSIVE for DELETE to PUBLIC using ((EXISTS ( SELECT 1
   FROM employees
  WHERE ((employees.id = employee_schedule_overrides.employee_id) AND (employees.client_id = auth.uid())))));

create policy "Clients can insert own employee schedule overrides" on public."employee_schedule_overrides" as PERMISSIVE for INSERT to PUBLIC with check ((EXISTS ( SELECT 1
   FROM employees
  WHERE ((employees.id = employee_schedule_overrides.employee_id) AND (employees.client_id = auth.uid())))));

create policy "Clients can update own employee schedule overrides" on public."employee_schedule_overrides" as PERMISSIVE for UPDATE to PUBLIC using ((EXISTS ( SELECT 1
   FROM employees
  WHERE ((employees.id = employee_schedule_overrides.employee_id) AND (employees.client_id = auth.uid()))))) with check ((EXISTS ( SELECT 1
   FROM employees
  WHERE ((employees.id = employee_schedule_overrides.employee_id) AND (employees.client_id = auth.uid())))));

create policy "Clients can view own employee schedule overrides" on public."employee_schedule_overrides" as PERMISSIVE for SELECT to PUBLIC using ((EXISTS ( SELECT 1
   FROM employees
  WHERE ((employees.id = employee_schedule_overrides.employee_id) AND (employees.client_id = auth.uid())))));

create policy "account_available" on public."employee_schedule_overrides" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

create policy "clients can manage own schedule overrides" on public."employee_schedule_overrides" as PERMISSIVE for ALL to PUBLIC using ((EXISTS ( SELECT 1
   FROM employees
  WHERE ((employees.id = employee_schedule_overrides.employee_id) AND (employees.client_id = auth.uid()))))) with check ((EXISTS ( SELECT 1
   FROM employees
  WHERE ((employees.id = employee_schedule_overrides.employee_id) AND (employees.client_id = auth.uid())))));

create policy "clients can view own schedule overrides" on public."employee_schedule_overrides" as PERMISSIVE for SELECT to PUBLIC using ((EXISTS ( SELECT 1
   FROM employees
  WHERE ((employees.id = employee_schedule_overrides.employee_id) AND (employees.client_id = auth.uid())))));

CREATE INDEX idx_employee_schedules_employee_id ON public.employee_schedules USING btree (employee_id);

alter table public."employee_schedules" enable row level security;

create policy "account_available" on public."employee_schedules" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

create policy "clients can manage own employee schedules" on public."employee_schedules" as PERMISSIVE for ALL to PUBLIC using ((EXISTS ( SELECT 1
   FROM employees
  WHERE ((employees.id = employee_schedules.employee_id) AND (employees.client_id = auth.uid()))))) with check ((EXISTS ( SELECT 1
   FROM employees
  WHERE ((employees.id = employee_schedules.employee_id) AND (employees.client_id = auth.uid())))));

create policy "clients can view own employee schedules" on public."employee_schedules" as PERMISSIVE for SELECT to PUBLIC using ((EXISTS ( SELECT 1
   FROM employees
  WHERE ((employees.id = employee_schedules.employee_id) AND (employees.client_id = auth.uid())))));

CREATE INDEX idx_employees_client_id ON public.employees USING btree (client_id);

alter table public."employees" enable row level security;

create policy "account_available" on public."employees" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

create policy "clients can delete own employees" on public."employees" as PERMISSIVE for DELETE to PUBLIC using ((client_id = auth.uid()));

create policy "clients can insert own employees" on public."employees" as PERMISSIVE for INSERT to PUBLIC with check ((client_id = auth.uid()));

create policy "clients can update own employees" on public."employees" as PERMISSIVE for UPDATE to PUBLIC using ((client_id = auth.uid())) with check ((client_id = auth.uid()));

create policy "clients can view own employees" on public."employees" as PERMISSIVE for SELECT to PUBLIC using ((client_id = auth.uid()));

alter table public."google_calendar_connections" enable row level security;

CREATE INDEX google_calendar_oauth_client_idx ON public.google_calendar_oauth_states USING btree (client_id);

alter table public."google_calendar_oauth_states" enable row level security;

alter table public."integration_settings" enable row level security;

create policy "service_only" on public."integration_settings" as PERMISSIVE for ALL to "service_role" using (true) with check (true);

alter table public."onboarding" enable row level security;

create policy "Admins can manage onboarding" on public."onboarding" as PERMISSIVE for ALL to "authenticated" using ((EXISTS ( SELECT 1
   FROM clients me
  WHERE ((me.id = auth.uid()) AND (me.role = 'admin'::text))))) with check ((EXISTS ( SELECT 1
   FROM clients me
  WHERE ((me.id = auth.uid()) AND (me.role = 'admin'::text)))));

create policy "Admins can view all onboarding" on public."onboarding" as PERMISSIVE for SELECT to "authenticated" using ((EXISTS ( SELECT 1
   FROM clients me
  WHERE ((me.id = auth.uid()) AND (me.role = 'admin'::text)))));

create policy "Clients can view their own onboarding" on public."onboarding" as PERMISSIVE for SELECT to "authenticated" using ((client_id = auth.uid()));

create policy "account_available" on public."onboarding" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

alter table public."recepta_demo_links" enable row level security;

create policy "service_only" on public."recepta_demo_links" as PERMISSIVE for ALL to "service_role" using (true) with check (true);

CREATE INDEX service_jobs_client_idx ON public.service_jobs USING btree (client_id);

CREATE INDEX service_jobs_due_idx ON public.service_jobs USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

CREATE INDEX service_jobs_provider_idx ON public.service_jobs USING btree (provider_message_id) WHERE (provider_message_id IS NOT NULL);

alter table public."service_jobs" enable row level security;

create policy "service_only" on public."service_jobs" as PERMISSIVE for ALL to "service_role" using (true) with check (true);

alter table public."subscriptions" enable row level security;

create policy "Clients can view their own subscription" on public."subscriptions" as PERMISSIVE for SELECT to "authenticated" using ((client_id = auth.uid()));

create policy "account_available" on public."subscriptions" as RESTRICTIVE for ALL to "authenticated" using ((recepta_private.is_admin() OR recepta_private.account_available())) with check ((recepta_private.is_admin() OR recepta_private.account_available()));

CREATE TRIGGER guard_deleting_number BEFORE INSERT OR UPDATE ON agent_phone_numbers FOR EACH ROW EXECUTE FUNCTION guard_recepta_deleting_number();

CREATE TRIGGER guard_deleting_agent BEFORE INSERT OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION guard_recepta_deleting_client();

CREATE TRIGGER zz_protect_erased_appointment BEFORE INSERT OR UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION protect_recepta_erased_appointment();

CREATE TRIGGER reconcile_billing_delivery AFTER INSERT OR UPDATE OF provider_message_id ON billing_notifications FOR EACH ROW EXECUTE FUNCTION reconcile_recepta_email_delivery();

CREATE TRIGGER reconcile_call_delivery AFTER INSERT OR UPDATE OF provider_message_id ON call_notifications FOR EACH ROW EXECUTE FUNCTION reconcile_recepta_email_delivery();

CREATE TRIGGER enqueue_recepta_call_notification AFTER INSERT OR UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION enqueue_recepta_call_notification();

CREATE TRIGGER protect_recepta_call_lifecycle BEFORE INSERT OR UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION protect_recepta_call_lifecycle();

CREATE TRIGGER settle_recepta_call_reservation AFTER INSERT OR UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION settle_recepta_call_reservation();

CREATE TRIGGER zz_protect_erased_content BEFORE INSERT OR UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION protect_recepta_erased_content();

CREATE TRIGGER reconcile_callback_delivery AFTER INSERT OR UPDATE OF provider_message_id ON service_jobs FOR EACH ROW EXECUTE FUNCTION reconcile_recepta_email_delivery();

CREATE TRIGGER guard_deleting_subscription BEFORE INSERT OR UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION guard_recepta_deleting_client();

revoke all on schema public, recepta_private from PUBLIC, anon, authenticated, service_role;

grant USAGE on schema "public" to PUBLIC;

grant USAGE on schema "public" to "anon";

grant USAGE on schema "public" to "authenticated";

grant USAGE on schema "public" to "service_role";

grant USAGE on schema "recepta_private" to "authenticated";

grant USAGE on schema "recepta_private" to "service_role";

revoke all on all tables in schema public from PUBLIC, anon, authenticated, service_role;

grant SELECT on table public."agent_phone_numbers" to "authenticated";

grant DELETE on table public."agent_phone_numbers" to "service_role";

grant INSERT on table public."agent_phone_numbers" to "service_role";

grant REFERENCES on table public."agent_phone_numbers" to "service_role";

grant SELECT on table public."agent_phone_numbers" to "service_role";

grant TRIGGER on table public."agent_phone_numbers" to "service_role";

grant TRUNCATE on table public."agent_phone_numbers" to "service_role";

grant UPDATE on table public."agent_phone_numbers" to "service_role";

grant SELECT on table public."agents" to "authenticated";

grant DELETE on table public."agents" to "service_role";

grant INSERT on table public."agents" to "service_role";

grant REFERENCES on table public."agents" to "service_role";

grant SELECT on table public."agents" to "service_role";

grant TRIGGER on table public."agents" to "service_role";

grant TRUNCATE on table public."agents" to "service_role";

grant UPDATE on table public."agents" to "service_role";

grant SELECT on table public."ai_models" to "authenticated";

grant DELETE on table public."ai_models" to "service_role";

grant INSERT on table public."ai_models" to "service_role";

grant REFERENCES on table public."ai_models" to "service_role";

grant SELECT on table public."ai_models" to "service_role";

grant TRIGGER on table public."ai_models" to "service_role";

grant TRUNCATE on table public."ai_models" to "service_role";

grant UPDATE on table public."ai_models" to "service_role";

grant SELECT on table public."appointment_customer_contacts" to "authenticated";

grant DELETE on table public."appointment_customer_contacts" to "service_role";

grant INSERT on table public."appointment_customer_contacts" to "service_role";

grant REFERENCES on table public."appointment_customer_contacts" to "service_role";

grant SELECT on table public."appointment_customer_contacts" to "service_role";

grant TRIGGER on table public."appointment_customer_contacts" to "service_role";

grant TRUNCATE on table public."appointment_customer_contacts" to "service_role";

grant UPDATE on table public."appointment_customer_contacts" to "service_role";

grant SELECT on table public."appointments" to "authenticated";

grant DELETE on table public."appointments" to "service_role";

grant INSERT on table public."appointments" to "service_role";

grant REFERENCES on table public."appointments" to "service_role";

grant SELECT on table public."appointments" to "service_role";

grant TRIGGER on table public."appointments" to "service_role";

grant TRUNCATE on table public."appointments" to "service_role";

grant UPDATE on table public."appointments" to "service_role";

grant DELETE on table public."billing_notifications" to "service_role";

grant INSERT on table public."billing_notifications" to "service_role";

grant REFERENCES on table public."billing_notifications" to "service_role";

grant SELECT on table public."billing_notifications" to "service_role";

grant TRIGGER on table public."billing_notifications" to "service_role";

grant TRUNCATE on table public."billing_notifications" to "service_role";

grant UPDATE on table public."billing_notifications" to "service_role";

grant DELETE on table public."call_minute_reservations" to "service_role";

grant INSERT on table public."call_minute_reservations" to "service_role";

grant REFERENCES on table public."call_minute_reservations" to "service_role";

grant SELECT on table public."call_minute_reservations" to "service_role";

grant TRIGGER on table public."call_minute_reservations" to "service_role";

grant TRUNCATE on table public."call_minute_reservations" to "service_role";

grant UPDATE on table public."call_minute_reservations" to "service_role";

grant DELETE on table public."call_notifications" to "service_role";

grant INSERT on table public."call_notifications" to "service_role";

grant REFERENCES on table public."call_notifications" to "service_role";

grant SELECT on table public."call_notifications" to "service_role";

grant TRIGGER on table public."call_notifications" to "service_role";

grant TRUNCATE on table public."call_notifications" to "service_role";

grant UPDATE on table public."call_notifications" to "service_role";

grant DELETE on table public."callback_requests" to "service_role";

grant INSERT on table public."callback_requests" to "service_role";

grant REFERENCES on table public."callback_requests" to "service_role";

grant SELECT on table public."callback_requests" to "service_role";

grant TRIGGER on table public."callback_requests" to "service_role";

grant TRUNCATE on table public."callback_requests" to "service_role";

grant UPDATE on table public."callback_requests" to "service_role";

grant SELECT on table public."calls" to "authenticated";

grant DELETE on table public."calls" to "service_role";

grant INSERT on table public."calls" to "service_role";

grant REFERENCES on table public."calls" to "service_role";

grant SELECT on table public."calls" to "service_role";

grant TRIGGER on table public."calls" to "service_role";

grant TRUNCATE on table public."calls" to "service_role";

grant UPDATE on table public."calls" to "service_role";

grant SELECT on table public."clients" to "authenticated";

grant DELETE on table public."clients" to "service_role";

grant INSERT on table public."clients" to "service_role";

grant REFERENCES on table public."clients" to "service_role";

grant SELECT on table public."clients" to "service_role";

grant TRIGGER on table public."clients" to "service_role";

grant TRUNCATE on table public."clients" to "service_role";

grant UPDATE on table public."clients" to "service_role";

grant SELECT on table public."customer_requests" to "authenticated";

grant DELETE on table public."customer_requests" to "service_role";

grant INSERT on table public."customer_requests" to "service_role";

grant REFERENCES on table public."customer_requests" to "service_role";

grant SELECT on table public."customer_requests" to "service_role";

grant TRIGGER on table public."customer_requests" to "service_role";

grant TRUNCATE on table public."customer_requests" to "service_role";

grant UPDATE on table public."customer_requests" to "service_role";

grant DELETE on table public."email_delivery_receipts" to "service_role";

grant INSERT on table public."email_delivery_receipts" to "service_role";

grant REFERENCES on table public."email_delivery_receipts" to "service_role";

grant SELECT on table public."email_delivery_receipts" to "service_role";

grant TRIGGER on table public."email_delivery_receipts" to "service_role";

grant TRUNCATE on table public."email_delivery_receipts" to "service_role";

grant UPDATE on table public."email_delivery_receipts" to "service_role";

grant SELECT on table public."employee_calendar_blocks" to "authenticated";

grant DELETE on table public."employee_calendar_blocks" to "service_role";

grant INSERT on table public."employee_calendar_blocks" to "service_role";

grant REFERENCES on table public."employee_calendar_blocks" to "service_role";

grant SELECT on table public."employee_calendar_blocks" to "service_role";

grant TRIGGER on table public."employee_calendar_blocks" to "service_role";

grant TRUNCATE on table public."employee_calendar_blocks" to "service_role";

grant UPDATE on table public."employee_calendar_blocks" to "service_role";

grant DELETE on table public."employee_schedule_overrides" to "authenticated";

grant INSERT on table public."employee_schedule_overrides" to "authenticated";

grant SELECT on table public."employee_schedule_overrides" to "authenticated";

grant UPDATE on table public."employee_schedule_overrides" to "authenticated";

grant DELETE on table public."employee_schedule_overrides" to "service_role";

grant INSERT on table public."employee_schedule_overrides" to "service_role";

grant REFERENCES on table public."employee_schedule_overrides" to "service_role";

grant SELECT on table public."employee_schedule_overrides" to "service_role";

grant TRIGGER on table public."employee_schedule_overrides" to "service_role";

grant TRUNCATE on table public."employee_schedule_overrides" to "service_role";

grant UPDATE on table public."employee_schedule_overrides" to "service_role";

grant DELETE on table public."employee_schedules" to "authenticated";

grant INSERT on table public."employee_schedules" to "authenticated";

grant SELECT on table public."employee_schedules" to "authenticated";

grant UPDATE on table public."employee_schedules" to "authenticated";

grant DELETE on table public."employee_schedules" to "service_role";

grant INSERT on table public."employee_schedules" to "service_role";

grant REFERENCES on table public."employee_schedules" to "service_role";

grant SELECT on table public."employee_schedules" to "service_role";

grant TRIGGER on table public."employee_schedules" to "service_role";

grant TRUNCATE on table public."employee_schedules" to "service_role";

grant UPDATE on table public."employee_schedules" to "service_role";

grant DELETE on table public."employees" to "authenticated";

grant INSERT on table public."employees" to "authenticated";

grant SELECT on table public."employees" to "authenticated";

grant UPDATE on table public."employees" to "authenticated";

grant DELETE on table public."employees" to "service_role";

grant INSERT on table public."employees" to "service_role";

grant REFERENCES on table public."employees" to "service_role";

grant SELECT on table public."employees" to "service_role";

grant TRIGGER on table public."employees" to "service_role";

grant TRUNCATE on table public."employees" to "service_role";

grant UPDATE on table public."employees" to "service_role";

grant DELETE on table public."integration_settings" to "service_role";

grant INSERT on table public."integration_settings" to "service_role";

grant REFERENCES on table public."integration_settings" to "service_role";

grant SELECT on table public."integration_settings" to "service_role";

grant TRIGGER on table public."integration_settings" to "service_role";

grant TRUNCATE on table public."integration_settings" to "service_role";

grant UPDATE on table public."integration_settings" to "service_role";

grant DELETE on table public."onboarding" to "authenticated";

grant INSERT on table public."onboarding" to "authenticated";

grant SELECT on table public."onboarding" to "authenticated";

grant UPDATE on table public."onboarding" to "authenticated";

grant DELETE on table public."onboarding" to "service_role";

grant INSERT on table public."onboarding" to "service_role";

grant REFERENCES on table public."onboarding" to "service_role";

grant SELECT on table public."onboarding" to "service_role";

grant TRIGGER on table public."onboarding" to "service_role";

grant TRUNCATE on table public."onboarding" to "service_role";

grant UPDATE on table public."onboarding" to "service_role";

grant DELETE on table public."recepta_demo_links" to "service_role";

grant INSERT on table public."recepta_demo_links" to "service_role";

grant REFERENCES on table public."recepta_demo_links" to "service_role";

grant SELECT on table public."recepta_demo_links" to "service_role";

grant TRIGGER on table public."recepta_demo_links" to "service_role";

grant TRUNCATE on table public."recepta_demo_links" to "service_role";

grant UPDATE on table public."recepta_demo_links" to "service_role";

grant DELETE on table public."service_jobs" to "service_role";

grant INSERT on table public."service_jobs" to "service_role";

grant REFERENCES on table public."service_jobs" to "service_role";

grant SELECT on table public."service_jobs" to "service_role";

grant TRIGGER on table public."service_jobs" to "service_role";

grant TRUNCATE on table public."service_jobs" to "service_role";

grant UPDATE on table public."service_jobs" to "service_role";

grant SELECT on table public."subscriptions" to "authenticated";

grant DELETE on table public."subscriptions" to "service_role";

grant INSERT on table public."subscriptions" to "service_role";

grant REFERENCES on table public."subscriptions" to "service_role";

grant SELECT on table public."subscriptions" to "service_role";

grant TRIGGER on table public."subscriptions" to "service_role";

grant TRUNCATE on table public."subscriptions" to "service_role";

grant UPDATE on table public."subscriptions" to "service_role";

revoke all on function "public"."activate_recepta_checkout"(p_client_id uuid, p_stripe_subscription_id text, p_customer_id text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_configuration jsonb, p_replaces_subscription_id text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."apply_recepta_email_delivery"(p_provider_id text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."cancel_recepta_booking"(p_client_id uuid, p_id uuid, p_version integer) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."capture_recepta_appointment_request"(p_client_id uuid, p_call_id text, p_details jsonb) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."claim_recepta_billing_notifications"(p_limit integer) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."claim_recepta_calendar_jobs"(p_client_id uuid) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."claim_recepta_call_notifications"(p_limit integer, p_key text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."claim_recepta_demo"(p_token_hash text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."claim_recepta_service_jobs"(p_limit integer, p_key text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."configure_recepta_subscription"(p_client_id uuid, p_configuration jsonb) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."disconnect_recepta_calendar"(p_client_id uuid) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."enqueue_recepta_call_notification"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."erase_recepta_call_content"(p_call_id uuid, p_client_id uuid) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."finish_recepta_call_notification"(p_key text, p_lease uuid, p_provider_id text, p_error text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."finish_recepta_service_job"(p_key text, p_lease uuid, p_error text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."guard_recepta_booking"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."guard_recepta_deleting_client"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."guard_recepta_deleting_number"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."is_admin"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."prepare_recepta_call_notification"(p_key text, p_lease uuid, p_payload jsonb) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."protect_recepta_call_lifecycle"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."protect_recepta_erased_appointment"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."protect_recepta_erased_content"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."queue_recepta_calendar_booking"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."queue_recepta_retention"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."recepta_book_employee_appointment"(p_client_id uuid, p_employee_id uuid, p_start timestamp with time zone, p_duration_minutes integer, p_customer_name text, p_customer_email text, p_customer_phone text, p_company_name text, p_service text, p_notes text, p_internal_notes text, p_source text, p_retell_call_id text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."recepta_booking_remaining"(p_client_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_exclude uuid) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."recepta_committed_usage"(p_client_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."recepta_create_employee_block"(p_client_id uuid, p_employee_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_title text, p_details text, p_block_type text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."recepta_period_usage"(p_client_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."reconcile_recepta_email_delivery"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."record_recepta_callback"(p_client_id uuid, p_call_id text, p_from text, p_to text, p_reason text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."renew_recepta_subscription"(p_stripe_subscription_id text, p_period_start timestamp with time zone, p_period_end timestamp with time zone) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."reserve_recepta_agent_call"(p_client_id uuid, p_call_id text, p_agent_id text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."reserve_recepta_booking"(p_client_id uuid, p_booking_key text, p_details jsonb, p_id uuid, p_version integer) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."reserve_recepta_call"(p_client_id uuid, p_monthly_seconds bigint, p_period_start timestamp with time zone) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."reserve_recepta_inbound_call"(p_client_id uuid, p_call_id text) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."settle_recepta_call_reservation"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."start_recepta_client_deletion"(p_client_id uuid) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."sync_recepta_calendar_snapshot"(p_client_id uuid, p_events jsonb, p_synced_at timestamp with time zone, p_connection_version timestamp with time zone) from PUBLIC, anon, authenticated, service_role;

revoke all on function "public"."update_recepta_booking_settings"(p_client_id uuid, p_enabled boolean, p_capacity integer, p_duration integer, p_buffer integer) from PUBLIC, anon, authenticated, service_role;

grant EXECUTE on function "public"."activate_recepta_checkout"(p_client_id uuid, p_stripe_subscription_id text, p_customer_id text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_configuration jsonb, p_replaces_subscription_id text) to "service_role";

grant EXECUTE on function "public"."apply_recepta_email_delivery"(p_provider_id text) to "service_role";

grant EXECUTE on function "public"."capture_recepta_appointment_request"(p_client_id uuid, p_call_id text, p_details jsonb) to "service_role";

grant EXECUTE on function "public"."claim_recepta_billing_notifications"(p_limit integer) to "service_role";

grant EXECUTE on function "public"."claim_recepta_call_notifications"(p_limit integer, p_key text) to "service_role";

grant EXECUTE on function "public"."claim_recepta_demo"(p_token_hash text) to "service_role";

grant EXECUTE on function "public"."claim_recepta_service_jobs"(p_limit integer, p_key text) to "service_role";

grant EXECUTE on function "public"."configure_recepta_subscription"(p_client_id uuid, p_configuration jsonb) to "service_role";

grant EXECUTE on function "public"."enqueue_recepta_call_notification"() to "service_role";

grant EXECUTE on function "public"."erase_recepta_call_content"(p_call_id uuid, p_client_id uuid) to "service_role";

grant EXECUTE on function "public"."finish_recepta_call_notification"(p_key text, p_lease uuid, p_provider_id text, p_error text) to "service_role";

grant EXECUTE on function "public"."finish_recepta_service_job"(p_key text, p_lease uuid, p_error text) to "service_role";

grant EXECUTE on function "public"."guard_recepta_deleting_client"() to "service_role";

grant EXECUTE on function "public"."guard_recepta_deleting_number"() to "service_role";

grant EXECUTE on function "public"."is_admin"() to "authenticated";

grant EXECUTE on function "public"."is_admin"() to "service_role";

grant EXECUTE on function "public"."prepare_recepta_call_notification"(p_key text, p_lease uuid, p_payload jsonb) to "service_role";

grant EXECUTE on function "public"."protect_recepta_call_lifecycle"() to "service_role";

grant EXECUTE on function "public"."protect_recepta_erased_appointment"() to "service_role";

grant EXECUTE on function "public"."protect_recepta_erased_content"() to "service_role";

grant EXECUTE on function "public"."queue_recepta_retention"() to "service_role";

grant EXECUTE on function "public"."recepta_book_employee_appointment"(p_client_id uuid, p_employee_id uuid, p_start timestamp with time zone, p_duration_minutes integer, p_customer_name text, p_customer_email text, p_customer_phone text, p_company_name text, p_service text, p_notes text, p_internal_notes text, p_source text, p_retell_call_id text) to "service_role";

grant EXECUTE on function "public"."recepta_committed_usage"(p_client_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) to "service_role";

grant EXECUTE on function "public"."recepta_create_employee_block"(p_client_id uuid, p_employee_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_title text, p_details text, p_block_type text) to "service_role";

grant EXECUTE on function "public"."recepta_period_usage"(p_client_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) to "service_role";

grant EXECUTE on function "public"."reconcile_recepta_email_delivery"() to "service_role";

grant EXECUTE on function "public"."record_recepta_callback"(p_client_id uuid, p_call_id text, p_from text, p_to text, p_reason text) to "service_role";

grant EXECUTE on function "public"."renew_recepta_subscription"(p_stripe_subscription_id text, p_period_start timestamp with time zone, p_period_end timestamp with time zone) to "service_role";

grant EXECUTE on function "public"."reserve_recepta_agent_call"(p_client_id uuid, p_call_id text, p_agent_id text) to "service_role";

grant EXECUTE on function "public"."reserve_recepta_call"(p_client_id uuid, p_monthly_seconds bigint, p_period_start timestamp with time zone) to "service_role";

grant EXECUTE on function "public"."reserve_recepta_inbound_call"(p_client_id uuid, p_call_id text) to "service_role";

grant EXECUTE on function "public"."settle_recepta_call_reservation"() to "service_role";

grant EXECUTE on function "public"."start_recepta_client_deletion"(p_client_id uuid) to "service_role";

revoke all on function "recepta_private"."account_available"() from PUBLIC, anon, authenticated, service_role;

revoke all on function "recepta_private"."is_admin"() from PUBLIC, anon, authenticated, service_role;

grant EXECUTE on function "recepta_private"."is_admin"() to "authenticated";

grant EXECUTE on function "recepta_private"."is_admin"() to "service_role";

grant EXECUTE on function "recepta_private"."account_available"() to "authenticated";

grant EXECUTE on function "recepta_private"."account_available"() to "service_role";

set check_function_bodies = on;

reset search_path;
