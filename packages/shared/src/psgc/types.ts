export interface PsgcProvince {
  code: string;
  name: string;
  regionCode: string;
  islandGroup: string;
}

export interface PsgcMunicipality {
  code: string;
  name: string;
  /** Null only for a handful of independent geographies; NCR cities map to the Metro Manila pseudo-province. */
  provinceCode: string | null;
  type: 'CITY' | 'MUNICIPALITY';
  regionCode: string;
}

export interface PsgcRegion {
  code: string;
  name: string;
}

export type LocationType = 'PROVINCE' | 'MUNICIPALITY' | 'CITY' | 'ISLAND' | 'UNKNOWN';

export interface ResolvedLocation {
  psgcCode: string | null;
  /** Canonical PSGC name when resolved, otherwise the cleaned input name. */
  name: string;
  locationType: LocationType;
  /** How the match was made — useful for logging and tuning. */
  matchType: 'exact' | 'alias' | 'fuzzy' | 'none';
}
