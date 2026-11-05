-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ClientService" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "owner" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientServiceKey" (
    "id" TEXT NOT NULL,
    "clientServiceId" TEXT NOT NULL,
    "name" TEXT,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" JSONB,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientServiceKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientServicePolicy" (
    "id" TEXT NOT NULL,
    "clientServiceId" TEXT NOT NULL,
    "pathPattern" TEXT NOT NULL,
    "canRead" BOOLEAN NOT NULL DEFAULT true,
    "canUpload" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,
    "maxUploadBytes" INTEGER,
    "rateLimitPerMin" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientServicePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "sourceApp" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientServiceId" TEXT,
    "clientServiceSlug" TEXT,
    "requestId" TEXT,
    "traceId" TEXT,
    "imageId" INTEGER,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageKey" TEXT NOT NULL,
    "cacheKey" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "format" TEXT,
    "inputBytes" INTEGER,
    "outputBytes" INTEGER,
    "durationMs" DOUBLE PRECISION,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "rawPayload" JSONB NOT NULL,

    CONSTRAINT "TelemetryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryIngestionMetric" (
    "id" TEXT NOT NULL,
    "validationFailureCount" INTEGER NOT NULL DEFAULT 0,
    "insertFailureCount" INTEGER NOT NULL DEFAULT 0,
    "lastConsumedEventAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelemetryIngestionMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientService_slug_key" ON "ClientService"("slug");

-- CreateIndex
CREATE INDEX "ClientService_status_idx" ON "ClientService"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ClientServiceKey_keyPrefix_key" ON "ClientServiceKey"("keyPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "ClientServiceKey_keyHash_key" ON "ClientServiceKey"("keyHash");

-- CreateIndex
CREATE INDEX "ClientServiceKey_clientServiceId_idx" ON "ClientServiceKey"("clientServiceId");

-- CreateIndex
CREATE INDEX "ClientServiceKey_revokedAt_idx" ON "ClientServiceKey"("revokedAt");

-- CreateIndex
CREATE INDEX "ClientServiceKey_expiresAt_idx" ON "ClientServiceKey"("expiresAt");

-- CreateIndex
CREATE INDEX "ClientServicePolicy_clientServiceId_idx" ON "ClientServicePolicy"("clientServiceId");

-- CreateIndex
CREATE INDEX "ClientServicePolicy_pathPattern_idx" ON "ClientServicePolicy"("pathPattern");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryEvent_eventId_key" ON "TelemetryEvent"("eventId");

-- CreateIndex
CREATE INDEX "TelemetryEvent_clientServiceId_occurredAt_idx" ON "TelemetryEvent"("clientServiceId", "occurredAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_clientServiceSlug_occurredAt_idx" ON "TelemetryEvent"("clientServiceSlug", "occurredAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_eventType_occurredAt_idx" ON "TelemetryEvent"("eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_sourceApp_occurredAt_idx" ON "TelemetryEvent"("sourceApp", "occurredAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_status_occurredAt_idx" ON "TelemetryEvent"("status", "occurredAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_imageKey_occurredAt_idx" ON "TelemetryEvent"("imageKey", "occurredAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_requestId_idx" ON "TelemetryEvent"("requestId");

-- CreateIndex
CREATE INDEX "TelemetryEvent_traceId_idx" ON "TelemetryEvent"("traceId");

-- AddForeignKey
ALTER TABLE "ClientServiceKey" ADD CONSTRAINT "ClientServiceKey_clientServiceId_fkey" FOREIGN KEY ("clientServiceId") REFERENCES "ClientService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientServicePolicy" ADD CONSTRAINT "ClientServicePolicy_clientServiceId_fkey" FOREIGN KEY ("clientServiceId") REFERENCES "ClientService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryEvent" ADD CONSTRAINT "TelemetryEvent_clientServiceId_fkey" FOREIGN KEY ("clientServiceId") REFERENCES "ClientService"("id") ON DELETE SET NULL ON UPDATE CASCADE;

