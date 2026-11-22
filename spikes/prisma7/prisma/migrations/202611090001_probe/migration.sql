CREATE TABLE "spike_probes" (
  "id" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "optional_text" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "spike_probes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "spike_revision_nonnegative" CHECK ("revision" >= 0)
);
CREATE TABLE "spike_snapshots" (
  "id" UUID NOT NULL,
  "probe_id" UUID NOT NULL,
  "number" INTEGER NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "amount" DECIMAL(8,3) NOT NULL,
  "payload" JSONB NOT NULL,
  CONSTRAINT "spike_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "spike_number_positive" CHECK ("number" > 0)
);
CREATE UNIQUE INDEX "spike_snapshots_probe_id_number_key" ON "spike_snapshots"("probe_id", "number");
ALTER TABLE "spike_snapshots" ADD CONSTRAINT "spike_snapshots_probe_id_fkey" FOREIGN KEY ("probe_id") REFERENCES "spike_probes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
