-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- Shared trigger function for updated_at maintenance
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TABLE "msme_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_name" text NOT NULL,
	"udyam_number" text,
	"gstin" text,
	"udyam_verified" boolean DEFAULT false NOT NULL,
	"gstin_verified" boolean DEFAULT false NOT NULL,
	"sector" text,
	"state" text NOT NULL,
	"city" text,
	"pincode" text,
	"employee_band" text,
	"membership_tier" text DEFAULT 'free' NOT NULL,
	"profile_completeness" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "msme_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "provider_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"account_number_enc" text NOT NULL,
	"ifsc" text NOT NULL,
	"account_holder" text NOT NULL,
	"penny_drop_verified" boolean DEFAULT false NOT NULL,
	"razorpay_route_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "provider_bank_accounts_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE "provider_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"about" text,
	"logo_url" text,
	"gstin" text,
	"pan" text,
	"state" text NOT NULL,
	"city" text,
	"languages" text[] DEFAULT '{en}' NOT NULL,
	"status" text DEFAULT 'pending_kyc' NOT NULL,
	"avg_rating" text DEFAULT '0.0' NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"completed_orders" integer DEFAULT 0 NOT NULL,
	"median_response_minutes" integer,
	"capacity_paused" boolean DEFAULT false NOT NULL,
	"top_rated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "provider_profiles_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "provider_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "provider_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"document_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"rejection_reason" text,
	"api_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"full_name" text,
	"preferred_locale" text DEFAULT 'en' NOT NULL,
	"roles" text[] DEFAULT '{msme}' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"name_i18n" jsonb NOT NULL,
	"description_i18n" jsonb,
	"icon" text,
	"commission_bps" integer DEFAULT 1000 NOT NULL,
	"required_credentials" text[] DEFAULT '{}' NOT NULL,
	"rfq_template" jsonb,
	"sort_order" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title_i18n" jsonb NOT NULL,
	"scope_included" jsonb NOT NULL,
	"scope_excluded" jsonb,
	"deliverables" jsonb NOT NULL,
	"requirements_template" jsonb,
	"price_paise" bigint NOT NULL,
	"discount_bps" integer DEFAULT 0 NOT NULL,
	"member_extra_discount_bps" integer DEFAULT 0 NOT NULL,
	"delivery_days" integer NOT NULL,
	"revision_count" integer DEFAULT 1 NOT NULL,
	"faqs" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"search_tsv" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "packages_provider_slug_uniq" UNIQUE("provider_id","slug"),
	CONSTRAINT "packages_price_positive" CHECK ("packages"."price_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_categories" (
	"provider_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "provider_categories_provider_id_category_id_pk" PRIMARY KEY("provider_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rfq_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"price_paise" bigint NOT NULL,
	"delivery_days" integer NOT NULL,
	"scope" text NOT NULL,
	"message" text,
	"status" text DEFAULT 'submitted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "quotes_rfq_provider_uniq" UNIQUE("rfq_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "rfq_matches" (
	"rfq_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"viewed_at" timestamp with time zone,
	CONSTRAINT "rfq_matches_rfq_id_provider_id_pk" PRIMARY KEY("rfq_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "rfqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"msme_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"details" jsonb NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_min_paise" bigint,
	"budget_max_paise" bigint,
	"needed_by" date,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_quotes" integer DEFAULT 7 NOT NULL,
	"quote_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"raised_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolution_amount_paise" bigint,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "disputes_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "order_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"file_url" text NOT NULL,
	"file_name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"actor_id" uuid,
	"event" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"msme_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"source" text NOT NULL,
	"package_id" uuid,
	"quote_id" uuid,
	"title" text NOT NULL,
	"scope_snapshot" jsonb NOT NULL,
	"price_paise" bigint NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"gst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"commission_bps" integer NOT NULL,
	"commission_paise" bigint NOT NULL,
	"provider_earning_paise" bigint NOT NULL,
	"delivery_days" integer NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'placed' NOT NULL,
	"revision_used" integer DEFAULT 0 NOT NULL,
	"revision_max" integer,
	"cancelled_reason" text,
	"completed_at" timestamp with time zone,
	"auto_accept_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"amount_paise" bigint NOT NULL,
	"method" text,
	"status" text NOT NULL,
	"webhook_payload" jsonb,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "payments_razorpay_order_id_unique" UNIQUE("razorpay_order_id"),
	CONSTRAINT "payments_razorpay_payment_id_unique" UNIQUE("razorpay_payment_id"),
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_for" date,
	"razorpay_transfer_id" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "payouts_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reason" text,
	"razorpay_refund_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "refunds_razorpay_refund_id_unique" UNIQUE("razorpay_refund_id")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_banners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot" text NOT NULL,
	"image_url" text NOT NULL,
	"link" text,
	"locale" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_type" text NOT NULL,
	"context_id" uuid NOT NULL,
	"msme_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "conversations_context_uniq" UNIQUE("context_type","context_id")
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"coupon_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"msme_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redemptions_coupon_id_order_id_pk" PRIMARY KEY("coupon_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"value_bps" integer NOT NULL,
	"max_discount_paise" bigint,
	"category_id" uuid,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"usage_limit" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "coupons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"pdf_url" text,
	"gstin_snapshot" jsonb,
	"totals" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redacted" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title_i18n" jsonb NOT NULL,
	"body_i18n" jsonb NOT NULL,
	"link" text,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"msme_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"text" text,
	"provider_reply" text,
	"status" text DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "reviews_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "saved_providers" (
	"msme_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_providers_msme_id_provider_id_pk" PRIMARY KEY("msme_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "msme_profiles" ADD CONSTRAINT "msme_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_bank_accounts" ADD CONSTRAINT "provider_bank_accounts_provider_id_provider_profiles_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_verifications" ADD CONSTRAINT "provider_verifications_provider_id_provider_profiles_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_verifications" ADD CONSTRAINT "provider_verifications_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_provider_id_provider_profiles_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_categories" ADD CONSTRAINT "provider_categories_provider_id_provider_profiles_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_categories" ADD CONSTRAINT "provider_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_provider_id_provider_profiles_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_matches" ADD CONSTRAINT "rfq_matches_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_matches" ADD CONSTRAINT "rfq_matches_provider_id_provider_profiles_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_msme_id_msme_profiles_id_fk" FOREIGN KEY ("msme_id") REFERENCES "public"."msme_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_documents" ADD CONSTRAINT "order_documents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_documents" ADD CONSTRAINT "order_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_milestones" ADD CONSTRAINT "order_milestones_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_msme_id_msme_profiles_id_fk" FOREIGN KEY ("msme_id") REFERENCES "public"."msme_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_provider_id_provider_profiles_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_provider_id_provider_profiles_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_msme_id_msme_profiles_id_fk" FOREIGN KEY ("msme_id") REFERENCES "public"."msme_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_provider_id_provider_profiles_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_msme_id_msme_profiles_id_fk" FOREIGN KEY ("msme_id") REFERENCES "public"."msme_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_msme_id_msme_profiles_id_fk" FOREIGN KEY ("msme_id") REFERENCES "public"."msme_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_provider_id_provider_profiles_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_providers" ADD CONSTRAINT "saved_providers_msme_id_msme_profiles_id_fk" FOREIGN KEY ("msme_id") REFERENCES "public"."msme_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_providers" ADD CONSTRAINT "saved_providers_provider_id_provider_profiles_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "packages_category_status_idx" ON "packages" USING btree ("category_id","status");--> statement-breakpoint
CREATE INDEX "packages_provider_idx" ON "packages" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "rfqs_msme_status_idx" ON "rfqs" USING btree ("msme_id","status");--> statement-breakpoint
CREATE INDEX "rfqs_category_status_idx" ON "rfqs" USING btree ("category_id","status");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_msme_status_idx" ON "orders" USING btree ("msme_id","status");--> statement-breakpoint
CREATE INDEX "orders_provider_status_idx" ON "orders" USING btree ("provider_id","status");
--> statement-breakpoint

-- FK to auth.users (cross-schema; Drizzle cannot express this in TypeScript)
ALTER TABLE "users" ADD CONSTRAINT "users_id_auth_fk"
  FOREIGN KEY ("id") REFERENCES auth.users("id") ON DELETE CASCADE;
--> statement-breakpoint

-- order_number auto-generation: AMC-YYYY-NNNNNN
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN 'AMC-' || to_char(now(), 'YYYY') || '-' || LPAD(nextval('order_number_seq')::text, 6, '0');
END;
$$;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "order_number" SET DEFAULT generate_order_number();
--> statement-breakpoint

-- packages: tsvector trigger (maintains search_tsv from title_i18n)
CREATE OR REPLACE FUNCTION packages_tsv_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv = to_tsvector('english',
    COALESCE(NEW.title_i18n->>'en', '') || ' ' ||
    COALESCE(NEW.title_i18n->>'hi', '')
  );
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER packages_tsv_trigger
  BEFORE INSERT OR UPDATE ON "packages"
  FOR EACH ROW EXECUTE FUNCTION packages_tsv_update();
--> statement-breakpoint

-- GIN index for packages full-text search
CREATE INDEX "packages_search_tsv_gin_idx" ON "packages" USING gin("search_tsv");
--> statement-breakpoint

-- updated_at triggers (applied to all tables with updated_at column)
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "users"               FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "msme_profiles"       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "provider_profiles"   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "provider_verifications" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "provider_bank_accounts" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "categories"          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "packages"            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "rfqs"                FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "quotes"              FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "orders"              FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "order_milestones"    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "payments"            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "refunds"             FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "payouts"             FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "disputes"            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "reviews"             FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "conversations"       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "coupons"             FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "cms_banners"         FOR EACH ROW EXECUTE FUNCTION set_updated_at();