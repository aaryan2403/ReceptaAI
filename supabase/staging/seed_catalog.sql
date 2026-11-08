-- Public Recepta product configuration only; no accounts, credentials or subscriptions.
-- Preserve the current catalog. Provider model availability still needs validation.
do $$ begin if exists(select 1 from public.ai_models) then raise exception 'Catalog seed requires an empty model catalog.'; end if; end $$;
insert into public.ai_models(id,display_name,provider,retell_model_name,tier_name,description,best_for,customer_price_per_minute_cad,is_recommended,is_active,sort_order,advanced_denoising_included) values
('gpt-5-6-luna','GPT-5.6 Luna','OpenAI','GPT 5.6 Luna','Essential','Fast and cost-efficient AI for straightforward receptionist conversations.','Straightforward calls, FAQs and information requests','0.1170',false,true,1,true),
('gpt-4-1','GPT-4.1','OpenAI','GPT 4.1','Professional','A strong balance of conversation quality, reliability and cost.','Most businesses and everyday receptionist workflows','0.1670',true,true,2,true),
('gpt-5-6-terra','GPT-5.6 Terra','OpenAI','GPT 5.6 Terra','Advanced','Advanced AI for more complicated conversations and business workflows.','Businesses with detailed call handling requirements','0.1970',false,true,3,true),
('claude-5-sonnet','Claude 5 Sonnet','Anthropic','Claude 5 Sonnet','Premium','Premium conversational AI for nuanced and complex customer interactions.','Complex customer conversations and premium deployments','0.2170',false,true,4,true);
