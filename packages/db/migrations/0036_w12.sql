CREATE TYPE "public"."credit_sharing_reviews_decision" AS ENUM('ok', 'warned', 'sharing_disabled');--> statement-breakpoint
CREATE TYPE "public"."credit_sharing_reviews_rule" AS ENUM('many_guests', 'guest_hopping');--> statement-breakpoint
CREATE TABLE "credit_sharing_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule" "credit_sharing_reviews_rule" NOT NULL,
	"grant_id" uuid,
	"guest_person_id" uuid,
	"guest_person_ids" uuid[] NOT NULL,
	"decision" "credit_sharing_reviews_decision" NOT NULL,
	"note" text,
	"reviewed_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_sharing_reviews_subject_ck" CHECK (("credit_sharing_reviews"."rule" = 'many_guests' and "credit_sharing_reviews"."grant_id" is not null and "credit_sharing_reviews"."guest_person_id" is null) or ("credit_sharing_reviews"."rule" = 'guest_hopping' and "credit_sharing_reviews"."guest_person_id" is not null and "credit_sharing_reviews"."grant_id" is null)),
	CONSTRAINT "credit_sharing_reviews_note_ck" CHECK ("credit_sharing_reviews"."note" is null or length("credit_sharing_reviews"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "credit_sharing_reviews" ADD CONSTRAINT "credit_sharing_reviews_grant_id_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_sharing_reviews" ADD CONSTRAINT "credit_sharing_reviews_guest_person_id_persons_id_fk" FOREIGN KEY ("guest_person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_sharing_reviews" ADD CONSTRAINT "credit_sharing_reviews_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_sharing_reviews_grant_idx" ON "credit_sharing_reviews" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "credit_sharing_reviews_guest_idx" ON "credit_sharing_reviews" USING btree ("guest_person_id");