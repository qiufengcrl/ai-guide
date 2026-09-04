const { fetchWithTimeout } = require('../xhs/url');

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';
const PLUGIN_UA = 'trek-ai-guide/1.1.0 (self-hosted TREK plugin; itinerary POI search)';
const SEARCH_TEXT_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.businessStatus';
const DEFAULT_LIMIT = 5;
const SEARCH_TIMEOUT_MS = 4000;
const PLACES_SEARCH_TIMEOUT_MS = 10000;
const MIN_INTERVAL_MS = 1100;

const API_LANG_OVERRIDES = { br: 'pt-BR', gr: 'el', 'el-GR': 'el' };

let lastCallAt = 0;
let minIntervalMs = MIN_INTERVAL_MS;

function setGeoThrottleInterval(ms) {
  minIntervalMs = Math.max(0, Number(ms) || 0);
}

class GeoSearchError extends Error {}

function toApiLang(lang, fallback = 'en') {
  const code = String(lang || '').trim();
  if (!code) return fallback;
  return API_LANG_OVERRIDES[code] ?? code;
}

function parseBias(locationBias) {
  if (!locationBias || typeof locationBias !== 'object') return null;
  const lat = Number(locationBias.lat ?? locationBias.latitude);
  const lng = Number(locationBias.lng ?? locationBias.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const radius = Number(locationBias.radius);
  return { lat, lng, radius: Number.isFinite(radius) && radius > 0 ? Math.min(radius, 500000) : 50000 };
}

function resolvePlacesApi(options = {}) {
  const base = String(options.placesApiBase || '').trim().replace(/\/$/, '');
  const key = String(options.placesApiKey || '').trim();
  if (!base || !key) return null;
  return { base, key };
}

function scoreRow(row) {
  const cls = String(row?.class || row?.category || '').toLowerCase();
  const type = String(row?.type || row?.addresstype || '').toLowerCase();
  let score = Number(row?.importance) || 0;
  if (['tourism', 'historic', 'leisure'].includes(cls)) score += 4;
  if (cls === 'amenity' && ['place_of_worship', 'theatre', 'arts_centre'].includes(type)) score += 3;
  if ([
    'attraction', 'museum', 'gallery', 'temple', 'viewpoint', 'theme_park',
    'artwork', 'monument', 'castle', 'ruins', 'archaeological_site', 'park', 'garden',
  ].includes(type)) score += 3;
  if (cls === 'boundary' || type === 'administrative') score -= 6;
  if (['province', 'state', 'country', 'region', 'municipality', 'county', 'city'].includes(type)) score -= 5;
  return score;
}

function toNominatimPlace(row, fallbackName) {
  const lat = Number(row?.lat);
  const lng = Number(row?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const displayName = String(row?.display_name || '');
  return {
    name: String(row?.name || '').trim() || displayName.split(',')[0].trim() || fallbackName,
    lat,
    lng,
    address: displayName,
    placeId: null,
    osmId: row?.osm_id != null ? String(row.osm_id) : null,
    types: [row?.type, row?.category, row?.class, row?.addresstype].filter(Boolean).map(String),
    source: 'nominatim',
  };
}

function toPlacesApiPlace(row, fallbackName) {
  const lat = Number(row?.location?.latitude);
  const lng = Number(row?.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    name: String(row?.displayName?.text || '').trim() || fallbackName,
    lat,
    lng,
    address: String(row?.formattedAddress || '').trim(),
    placeId: row?.id != null ? String(row.id) : null,
    osmId: null,
    types: Array.isArray(row?.types) ? row.types.map(String) : [],
    source: 'places',
  };
}

async function throttleNominatim() {
  const wait = minIntervalMs - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
}

async function searchPlacesViaNominatim(query, options = {}) {
  const text = String(query || '').trim();
  if (!text) return { places: [], source: 'nominatim' };
  const parsedLimit = Number.parseInt(String(options.limit ?? DEFAULT_LIMIT), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(10, Math.max(1, parsedLimit)) : DEFAULT_LIMIT;
  const params = new URLSearchParams({
    format: 'jsonv2',
    q: text,
    limit: String(limit),
    'accept-language': String(options.lang || 'en').slice(0, 24),
  });
  const bias = parseBias(options.locationBias);
  if (bias) {
    const half = Math.min(5, bias.radius / 111320);
    params.set('viewbox', [bias.lng - half, bias.lat + half, bias.lng + half, bias.lat - half]
      .map((value) => value.toFixed(5)).join(','));
  }
  await throttleNominatim();
  let response;
  try {
    response = await fetchWithTimeout(`${NOMINATIM_BASE_URL}?${params.toString()}`, {
      headers: { 'user-agent': PLUGIN_UA, accept: 'application/json' },
    }, SEARCH_TIMEOUT_MS);
  } catch (error) {
    throw new GeoSearchError(`Place search failed: ${error instanceof Error ? error.message : 'network error'}`);
  }
  if (!response.ok) throw new GeoSearchError(`Place search returned HTTP ${response.status}`);
  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new GeoSearchError('Place search returned invalid JSON');
  }
  const ranked = (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((a, b) => scoreRow(b) - scoreRow(a));
  const places = ranked.map((row) => toNominatimPlace(row, text)).filter(Boolean);
  return { places, source: 'nominatim' };
}

async function searchPlacesViaPlacesApi(query, options = {}, config) {
  const text = String(query || '').trim();
  if (!text) return { places: [], source: 'places' };
  const parsedLimit = Number.parseInt(String(options.limit ?? DEFAULT_LIMIT), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(20, Math.max(1, parsedLimit)) : DEFAULT_LIMIT;
  const body = {
    textQuery: text,
    languageCode: toApiLang(options.lang),
  };
  const bias = parseBias(options.locationBias);
  if (bias) {
    body.locationBias = {
      circle: {
        center: { latitude: bias.lat, longitude: bias.lng },
        radius: bias.radius,
      },
    };
  }
  let response;
  try {
    response = await fetchWithTimeout(`${config.base}/v1/places:searchText`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.key,
        'x-goog-fieldmask': SEARCH_TEXT_FIELD_MASK,
      },
      body: JSON.stringify(body),
    }, PLACES_SEARCH_TIMEOUT_MS);
  } catch (error) {
    throw new GeoSearchError(`Place search failed: ${error instanceof Error ? error.message : 'network error'}`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new GeoSearchError('Place search returned invalid JSON');
  }
  if (!response.ok) {
    throw new GeoSearchError(String(data?.error?.message || `Place search returned HTTP ${response.status}`));
  }
  const places = (Array.isArray(data?.places) ? data.places : [])
    .filter((row) => row?.businessStatus !== 'CLOSED_PERMANENTLY')
    .slice(0, limit)
    .map((row) => toPlacesApiPlace(row, text))
    .filter(Boolean);
  return { places, source: 'places' };
}

async function searchPlaces(query, options = {}) {
  const placesApi = resolvePlacesApi(options);
  if (placesApi) return searchPlacesViaPlacesApi(query, options, placesApi);
  return searchPlacesViaNominatim(query, options);
}

module.exports = {
  BASE_URL: NOMINATIM_BASE_URL,
  GeoSearchError,
  searchPlaces,
  setGeoThrottleInterval,
  scoreRow,
};
