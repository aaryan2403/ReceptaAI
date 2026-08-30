alter table public.subscriptions
  add column if not exists pii_redaction_enabled boolean not null default false,
  add column if not exists safety_guardrails_enabled boolean not null default false,
  add column if not exists extra_phone_numbers integer not null default 0
    check (extra_phone_numbers between 0 and 20);

comment on column public.subscriptions.pii_redaction_enabled is
  'Whether PII Redaction is included in the current Recepta subscription.';

comment on column public.subscriptions.safety_guardrails_enabled is
  'Whether Safety Guardrails are included in the current Recepta subscription.';

comment on column public.subscriptions.extra_phone_numbers is
  'Number of additional C$20/month phone numbers in the subscription.';

alter table public.ai_models
  add column if not exists advanced_denoising_included boolean not null default false;

update public.ai_models
set
  customer_price_per_minute_cad = round(
    customer_price_per_minute_cad::numeric + 0.007,
    3
  ),
  advanced_denoising_included = true
where
  customer_price_per_minute_cad is not null
  and advanced_denoising_included = false;

comment on column public.ai_models.advanced_denoising_included is
  'Prevents the C$0.007/minute advanced-denoising increase from being applied more than once.';
