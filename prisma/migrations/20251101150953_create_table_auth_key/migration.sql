-- CreateTable
CREATE TABLE "auth_keys" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_keys_session_id_category_idx" ON "auth_keys"("session_id", "category");

-- CreateIndex
CREATE INDEX "auth_keys_session_id_category_key_id_idx" ON "auth_keys"("session_id", "category", "key_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_keys_session_id_category_key_id_key" ON "auth_keys"("session_id", "category", "key_id");

-- AddForeignKey
ALTER TABLE "auth_keys" ADD CONSTRAINT "auth_keys_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
