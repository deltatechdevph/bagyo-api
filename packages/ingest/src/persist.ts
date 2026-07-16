import { createHash } from 'node:crypto';
import type { PrismaClient, Cyclone, Bulletin } from '@bagyo/db';
import type { DomainEvent, ParsedBulletin } from '@bagyo/shared';
import { detectChanges, type SignalSnapshotArea } from './change-detector.js';

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface PersistResult {
  outcome: 'created' | 'updated' | 'unchanged';
  cyclone: Cyclone;
  bulletin: Bulletin | null;
  events: DomainEvent[];
}

/** Season year uses PH wall-clock time of issuance. */
export function seasonYearOf(issuedAtIso: string): number {
  const d = new Date(issuedAtIso);
  return new Date(d.getTime() + 8 * 3600_000).getUTCFullYear();
}

/**
 * Persist a parsed bulletin idempotently.
 *  - sourceHash duplicate → no-op ("the same bulletin must NEVER create duplicate rows")
 *  - (cyclone, bulletinNumber) duplicate with different hash → correction: replace
 *  - otherwise create, diff against the previous bulletin, and return domain events
 */
export async function persistBulletin(
  prisma: PrismaClient,
  parsed: ParsedBulletin,
  raw: { sourceUrl: string; sourceHash: string; parserVersion: string; rawDocument?: string },
): Promise<PersistResult> {
  const existingByHash = await prisma.bulletin.findUnique({
    where: { sourceHash: raw.sourceHash },
    include: { cyclone: true },
  });
  if (existingByHash) {
    return {
      outcome: 'unchanged',
      cyclone: existingByHash.cyclone,
      bulletin: existingByHash,
      events: [],
    };
  }

  const seasonYear = seasonYearOf(parsed.issuedAt);
  const issuedAt = new Date(parsed.issuedAt);

  // Category on the Cyclone row is its latest known TC category; a post-cyclone
  // "(formerly)" bulletin keeps the last real category.
  const cycloneStatus = parsed.isFinal
    ? parsed.category === null
      ? 'DISSIPATED'
      : 'EXITED'
    : 'ACTIVE';

  let isNewCyclone = false;
  let cyclone = await prisma.cyclone.findUnique({
    where: { pagasaName_seasonYear: { pagasaName: parsed.pagasaName, seasonYear } },
  });
  if (!cyclone) {
    if (parsed.category === null) {
      // A "(formerly X)" bulletin for a cyclone we never tracked — create as TD floor.
      isNewCyclone = true;
      cyclone = await prisma.cyclone.create({
        data: {
          pagasaName: parsed.pagasaName,
          internationalName: parsed.internationalName,
          category: 'TD',
          status: 'DISSIPATED',
          seasonYear,
          firstBulletinAt: issuedAt,
          lastBulletinAt: issuedAt,
        },
      });
    } else {
      isNewCyclone = true;
      cyclone = await prisma.cyclone.create({
        data: {
          pagasaName: parsed.pagasaName,
          internationalName: parsed.internationalName,
          category: parsed.category,
          status: cycloneStatus,
          seasonYear,
          firstBulletinAt: issuedAt,
          lastBulletinAt: issuedAt,
        },
      });
    }
  } else {
    // Status/category reflect the cyclone's NEWEST bulletin — backfilling an
    // older bulletin (e.g. re-parsing history) must never regress them.
    const isNewest = issuedAt >= cyclone.lastBulletinAt;
    cyclone = await prisma.cyclone.update({
      where: { id: cyclone.id },
      data: {
        ...(isNewest && parsed.category !== null ? { category: parsed.category } : {}),
        ...(parsed.internationalName ? { internationalName: parsed.internationalName } : {}),
        ...(isNewest ? { status: cycloneStatus } : {}),
        lastBulletinAt: issuedAt > cyclone.lastBulletinAt ? issuedAt : cyclone.lastBulletinAt,
        firstBulletinAt: issuedAt < cyclone.firstBulletinAt ? issuedAt : cyclone.firstBulletinAt,
      },
    });
  }

  // Previous state for change detection = the latest earlier bulletin's signals.
  const previous = await prisma.bulletin.findFirst({
    where: { cycloneId: cyclone.id, issuedAt: { lt: issuedAt } },
    orderBy: { issuedAt: 'desc' },
    include: { windSignals: true },
  });
  const previousAreas: SignalSnapshotArea[] = (previous?.windSignals ?? []).map((w) => ({
    psgcCode: w.psgcCode,
    locationName: w.locationName,
    signalLevel: w.signalLevel,
  }));

  const bulletinData = {
    isFinal: parsed.isFinal,
    issuedAt,
    sourceUrl: raw.sourceUrl,
    sourceHash: raw.sourceHash,
    parserVersion: raw.parserVersion,
    rawPayload: {
      parsed: parsed as unknown,
      sourceDocument: raw.rawDocument ?? null,
    } as object,
    centerLat: parsed.center?.lat ?? null,
    centerLng: parsed.center?.lng ?? null,
    maxWindsKph: parsed.maxWindsKph,
    gustinessKph: parsed.gustinessKph,
    movementDirection: parsed.movementDirection,
    movementSpeedKph: parsed.movementSpeedKph,
    pressureHpa: parsed.pressureHpa,
    nextBulletinAt: parsed.nextBulletinAt ? new Date(parsed.nextBulletinAt) : null,
  };
  const signalRows = parsed.signals.flatMap((s) =>
    s.areas.map((a) => ({
      signalLevel: s.signalLevel,
      psgcCode: a.psgcCode,
      locationName: a.locationName,
      locationType: a.locationType,
      partialDescriptor: a.partialDescriptor,
    })),
  );

  const existingByNumber = await prisma.bulletin.findUnique({
    where: {
      cycloneId_bulletinNumber: { cycloneId: cyclone.id, bulletinNumber: parsed.bulletinNumber },
    },
  });

  let bulletin: Bulletin;
  let outcome: 'created' | 'updated';
  if (existingByNumber) {
    // Same bulletin number, different content hash: PAGASA issued a correction.
    outcome = 'updated';
    [, bulletin] = await prisma.$transaction([
      prisma.windSignal.deleteMany({ where: { bulletinId: existingByNumber.id } }),
      prisma.bulletin.update({
        where: { id: existingByNumber.id },
        data: { ...bulletinData, windSignals: { create: signalRows } },
      }),
    ]);
  } else {
    outcome = 'created';
    bulletin = await prisma.bulletin.create({
      data: {
        cycloneId: cyclone.id,
        bulletinNumber: parsed.bulletinNumber,
        ...bulletinData,
        windSignals: { create: signalRows },
      },
    });
  }

  // Corrections re-state the same bulletin — only genuinely new bulletins emit events.
  const events =
    outcome === 'created'
      ? detectChanges({
          cyclone: {
            id: cyclone.id,
            pagasaName: cyclone.pagasaName,
            internationalName: cyclone.internationalName,
            category: parsed.category,
          },
          bulletin: {
            id: bulletin.id,
            bulletinNumber: bulletin.bulletinNumber,
            issuedAt: parsed.issuedAt,
          },
          previousAreas,
          isNewCyclone,
          parsed,
        })
      : [];

  return { outcome, cyclone, bulletin, events };
}
