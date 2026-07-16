import type { Bulletin, Cyclone, WindSignal } from '@bagyo/db';
import { CATEGORY_LABELS } from '@bagyo/shared';
import { iso } from './schemas.js';

export function serializeCyclone(c: Cyclone) {
  return {
    id: c.id,
    pagasaName: c.pagasaName,
    internationalName: c.internationalName,
    category: c.category,
    categoryLabel: CATEGORY_LABELS[c.category] ?? c.category,
    status: c.status,
    seasonYear: c.seasonYear,
    firstBulletinAt: iso(c.firstBulletinAt),
    lastBulletinAt: iso(c.lastBulletinAt),
  };
}

export function serializeBulletin(b: Bulletin) {
  return {
    id: b.id,
    bulletinNumber: b.bulletinNumber,
    isFinal: b.isFinal,
    issuedAt: iso(b.issuedAt),
    nextBulletinAt: b.nextBulletinAt ? iso(b.nextBulletinAt) : null,
    center:
      b.centerLat !== null && b.centerLng !== null ? { lat: b.centerLat, lng: b.centerLng } : null,
    maxWindsKph: b.maxWindsKph,
    gustinessKph: b.gustinessKph,
    pressureHpa: b.pressureHpa,
    movementDirection: b.movementDirection,
    movementSpeedKph: b.movementSpeedKph,
    sourceUrl: b.sourceUrl,
  };
}

export function serializeSignal(w: WindSignal) {
  return {
    signalLevel: w.signalLevel,
    psgcCode: w.psgcCode,
    locationName: w.locationName,
    locationType: w.locationType,
    partialDescriptor: w.partialDescriptor,
  };
}

export function serializeBulletinWithSignals(b: Bulletin & { windSignals: WindSignal[] }) {
  return { ...serializeBulletin(b), windSignals: b.windSignals.map(serializeSignal) };
}
