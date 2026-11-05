ALTER TABLE "checkouts" DROP CONSTRAINT "checkouts_recovery_message_id_email_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "vouchers" DROP CONSTRAINT "vouchers_email_message_id_email_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_recovery_message_id_email_messages_id_fk" FOREIGN KEY ("recovery_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;