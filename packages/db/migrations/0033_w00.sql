ALTER TABLE "form_submissions" DROP CONSTRAINT "form_submissions_result_email_message_id_email_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_result_email_message_id_email_messages_id_fk" FOREIGN KEY ("result_email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;