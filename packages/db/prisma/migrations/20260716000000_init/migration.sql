-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CycloneCategory" AS ENUM ('TD', 'TS', 'STS', 'TY', 'STY');

-- CreateEnum
CREATE TYPE "CycloneStatus" AS ENUM ('ACTIVE', 'EXITED', 'DISSIPATED');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('PROVINCE', 'MUNICIPALITY', 'CITY', 'ISLAND', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RainfallLevel" AS ENUM ('YELLOW', 'ORANGE', 'RED');

-- CreateEnum
CREATE TYPE "ApiTier" AS ENUM ('FREE', 'HOBBY', 'PRO', 'BUSINESS');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'EXHAUSTED');

-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('RUNNING', 'SUCCESS', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "Cyclone" (
    "id" TEXT NOT NULL,
    "pagasaName" TEXT NOT NULL,
    "internationalName" TEXT,
    "category" "CycloneCategory" NOT NULL,
    "status" "CycloneStatus" NOT NULL DEFAULT 'ACTIVE',
    "seasonYear" INTEGER NOT NULL,
    "firstBulletinAt" TIMESTAMP(3) NOT NULL,
    "lastBulletinAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cyclone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bulletin" (
    "id" TEXT NOT NULL,
    "cycloneId" TEXT NOT NULL,
    "bulletinNumber" INTEGER NOT NULL,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "centerLat" DOUBLE PRECISION,
    "centerLng" DOUBLE PRECISION,
    "maxWindsKph" INTEGER,
    "gustinessKph" INTEGER,
    "movementDirection" TEXT,
    "movementSpeedKph" DOUBLE PRECISION,
    "pressureHpa" DOUBLE PRECISION,
    "nextBulletinAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bulletin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WindSignal" (
    "id" TEXT NOT NULL,
    "bulletinId" TEXT NOT NULL,
    "signalLevel" INTEGER NOT NULL,
    "psgcCode" TEXT,
    "locationName" TEXT NOT NULL,
    "locationType" "LocationType" NOT NULL,
    "partialDescriptor" TEXT,

    CONSTRAINT "WindSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RainfallAdvisory" (
    "id" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "region" TEXT NOT NULL,
    "level" "RainfallLevel" NOT NULL,
    "areas" JSONB NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RainfallAdvisory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "tier" "ApiTier" NOT NULL DEFAULT 'FREE',
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "eventTypes" TEXT[],
    "psgcFilter" TEXT[],
    "minSignalLevel" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "IngestStatus" NOT NULL DEFAULT 'RUNNING',
    "itemsFound" INTEGER NOT NULL DEFAULT 0,
    "itemsChanged" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "IngestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Cyclone_status_idx" ON "Cyclone"("status");

-- CreateIndex
CREATE INDEX "Cyclone_seasonYear_idx" ON "Cyclone"("seasonYear");

-- CreateIndex
CREATE UNIQUE INDEX "Cyclone_pagasaName_seasonYear_key" ON "Cyclone"("pagasaName", "seasonYear");

-- CreateIndex
CREATE UNIQUE INDEX "Bulletin_sourceHash_key" ON "Bulletin"("sourceHash");

-- CreateIndex
CREATE INDEX "Bulletin_issuedAt_idx" ON "Bulletin"("issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Bulletin_cycloneId_bulletinNumber_key" ON "Bulletin"("cycloneId", "bulletinNumber");

-- CreateIndex
CREATE INDEX "WindSignal_bulletinId_idx" ON "WindSignal"("bulletinId");

-- CreateIndex
CREATE INDEX "WindSignal_psgcCode_idx" ON "WindSignal"("psgcCode");

-- CreateIndex
CREATE INDEX "WindSignal_signalLevel_idx" ON "WindSignal"("signalLevel");

-- CreateIndex
CREATE UNIQUE INDEX "RainfallAdvisory_sourceHash_key" ON "RainfallAdvisory"("sourceHash");

-- CreateIndex
CREATE INDEX "RainfallAdvisory_issuedAt_idx" ON "RainfallAdvisory"("issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX "WebhookSubscription_userId_idx" ON "WebhookSubscription"("userId");

-- CreateIndex
CREATE INDEX "WebhookSubscription_active_idx" ON "WebhookSubscription"("active");

-- CreateIndex
CREATE INDEX "WebhookDelivery_subscriptionId_idx" ON "WebhookDelivery"("subscriptionId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_idx" ON "WebhookDelivery"("status");

-- CreateIndex
CREATE INDEX "IngestRun_source_startedAt_idx" ON "IngestRun"("source", "startedAt");

-- AddForeignKey
ALTER TABLE "Bulletin" ADD CONSTRAINT "Bulletin_cycloneId_fkey" FOREIGN KEY ("cycloneId") REFERENCES "Cyclone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WindSignal" ADD CONSTRAINT "WindSignal_bulletinId_fkey" FOREIGN KEY ("bulletinId") REFERENCES "Bulletin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

