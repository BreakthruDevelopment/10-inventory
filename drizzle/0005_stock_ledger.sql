CREATE TABLE "item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"barcode" text,
	"unit" text DEFAULT 'each' NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reorder_point" integer DEFAULT 0 NOT NULL,
	"lead_time_days" integer DEFAULT 0 NOT NULL,
	"pack_size" integer DEFAULT 1 NOT NULL,
	"supplier_name" text DEFAULT '' NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_balance_chk" CHECK ("item"."on_hand" >= 0 and "item"."version" >= 1),
	CONSTRAINT "item_fields_chk" CHECK (char_length("item"."sku") between 1 and 40 and char_length("item"."name") between 1 and 120 and ("item"."barcode" is null or char_length("item"."barcode") between 4 and 64) and char_length("item"."supplier_name") <= 120),
	CONSTRAINT "item_unit_chk" CHECK ("item"."unit" in ('each', 'case', 'kg', 'l')),
	CONSTRAINT "item_reorder_chk" CHECK ("item"."reorder_point" between 0 and 100000 and "item"."lead_time_days" between 0 and 90 and "item"."pack_size" between 1 and 10000 and "item"."unit_cost_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movement" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"delta" integer NOT NULL,
	"on_hand_after" integer NOT NULL,
	"item_version" integer NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"actor_id" text NOT NULL,
	"client_op_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movement_kind_chk" CHECK ("stock_movement"."kind" in ('receive', 'sale', 'adjust', 'count')),
	CONSTRAINT "stock_movement_values_chk" CHECK ("stock_movement"."on_hand_after" >= 0 and "stock_movement"."item_version" >= 2 and char_length("stock_movement"."reason") <= 200 and ("stock_movement"."kind" <> 'receive' or "stock_movement"."delta" > 0) and ("stock_movement"."kind" <> 'sale' or "stock_movement"."delta" < 0) and ("stock_movement"."kind" <> 'adjust' or ("stock_movement"."delta" <> 0 and char_length("stock_movement"."reason") > 0)))
);
--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_id_workspace_uidx" ON "item" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_item_id_workspace_id_item_id_workspace_id_fk" FOREIGN KEY ("item_id","workspace_id") REFERENCES "public"."item"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_workspace_sku_uidx" ON "item" USING btree ("workspace_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "item_workspace_barcode_uidx" ON "item" USING btree ("workspace_id","barcode") WHERE "item"."barcode" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movement_workspace_op_uidx" ON "stock_movement" USING btree ("workspace_id","client_op_id");--> statement-breakpoint
CREATE INDEX "stock_movement_workspace_item_created_idx" ON "stock_movement" USING btree ("workspace_id","item_id","created_at");--> statement-breakpoint
-- Ledger rows cannot be rewritten, including via direct SQL. Only deleting the owning workspace may
-- cascade its ledger (demo replacement/account removal); the parent is already gone in that case.
CREATE FUNCTION inventory_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM workspace WHERE id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Stock movements are append-only' USING ERRCODE = '23514', CONSTRAINT = 'stock_movement_append_only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movement_append_only BEFORE UPDATE OR DELETE ON stock_movement
FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
--> statement-breakpoint
CREATE FUNCTION inventory_ledger_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Stock movements are append-only' USING ERRCODE = '23514', CONSTRAINT = 'stock_movement_append_only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movement_no_truncate BEFORE TRUNCATE ON stock_movement
FOR EACH STATEMENT EXECUTE FUNCTION inventory_ledger_no_truncate();
