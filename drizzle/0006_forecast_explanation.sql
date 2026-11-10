CREATE TABLE "forecast_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecast_explanation" (
	"workspace_id" uuid NOT NULL,
	"input_hash" char(64) NOT NULL,
	"data" jsonb NOT NULL,
	"mode" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_explanation_workspace_id_input_hash_pk" PRIMARY KEY("workspace_id","input_hash"),
	CONSTRAINT "forecast_explanation_mode_chk" CHECK ("forecast_explanation"."mode" in ('live', 'demo'))
);
--> statement-breakpoint
ALTER TABLE "forecast_call" ADD CONSTRAINT "forecast_call_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_explanation" ADD CONSTRAINT "forecast_explanation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_explanation" ADD CONSTRAINT "forecast_explanation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forecast_call_workspace_at_idx" ON "forecast_call" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE INDEX "forecast_explanation_workspace_created_idx" ON "forecast_explanation" USING btree ("workspace_id","created_at");