const { fetchWithTimeout } = require('../xhs/url');

const BASE_URL = 'https://nominatim.openstreetmap.org/search';
const PLUGIN_UA = 'trek-ai-guide/1.0.0 (self-hosted TREK plugin; itinerary POI search)';
const DEFAULT_LIMIT = 5;
const SEARCH_TIMEOUT_MS = 4000;
const MIN_INTERVAL_MS = 1100;

let lastCallAt = 0;
let minIntervalMs = MIN_INTERVAL_MS;

// Test seam: the suite stubs fetch and cannot pay 1.1s per call.
function setGeoThrottleInterval(ms) {
  minIntervalMs = Math.max(0, Number(ms) || 0);
}

class GeoSearchError extends Error {}

function parseBias(locationBias) {
  if (!locationBias || typeof locationBias !== 'object') return null;
  const lat = Number(locationBias.lat ?? locationBias.latitude);
  const lng = Number(locationBias.lng ?? locationBias.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const radius = Number(locationBias.radius);
  return { lat, lng, radius: Number.isFinite(radius) && radius > 0 ? Math.min(radius, 100000) : 50000 };
}

function toPlace(row, fallbackName) {
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
    types: [row?.type, row?.category].filter(Boolean).map(String),
    source: 'nominatim',
  };
}

async function searchPlaces(query, options = {}) {
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
    // viewbox without bounded=1 soft-biases ranking instead of restricting it.
    const half = Math.min(1, bias.radius / 111320);
    params.set('viewbox', [bias.lng - half, bias.lat + half, bias.lng + half, bias.lat - half]
      .map((value) => value.toFixed(5)).join(','));
  }
  const wait = minIntervalMs - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
  let response;
  try {
    response = await fetchWithTimeout(`${BASE_URL}?${params.toString()}`, {
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
  const places = (Array.isArray(rows) ? rows : []).map((row) => toPlace(row, text)).filter(Boolean);
  return { places, source: 'nominatim' };
}

module.exports = { BASE_URL, GeoSearchError, searchPlaces, setGeoThrottleInterval };
