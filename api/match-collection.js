import Fuse from 'fuse.js';

const storeCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

// Controlled, whole-word synonym map for equivalent terms
const SYNONYM_MAP = {
  'tuxedo': ['suit', 'tux'],
  'tux': ['suit', 'tuxedo'],
  'suit': ['tuxedo', 'tux'],
  'pants': ['trousers', 'slacks'],
  'trousers': ['pants', 'slacks']
};

function sanitizeStoreDomain(domain) {
  return domain.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

/**
 * Expands whole words safely using Fuse extended search syntax:
 * "boot cut tuxedo" -> "boot cut (tuxedo | suit | tux)"
 */
function buildExtendedQuery(query) {
  const words = query.toLowerCase().trim().split(/\s+/);
  
  return words.map(word => {
    if (SYNONYM_MAP[word]) {
      return `(${word} | ${SYNONYM_MAP[word].join(' | ')})`;
    }
    return word;
  }).join(' ');
}

async function getFuseInstanceForStore(storeDomain) {
  const sanitizedStore = sanitizeStoreDomain(storeDomain);
  const now = Date.now();

  if (storeCache.has(sanitizedStore)) {
    const cached = storeCache.get(sanitizedStore);
    if (now - cached.timestamp < CACHE_TTL_MS) {
      return cached.instance;
    }
  }

  const blobBaseUrl = process.env.VERCEL_BLOB_BASE_URL;
  const blobUrl = `${blobBaseUrl}/${sanitizedStore}-collections.json`;

  const resp = await fetch(blobUrl);
  if (!resp.ok) {
    throw new Error(`Failed to load collection map for store "${storeDomain}" (HTTP ${resp.status})`);
  }

  const collections = await resp.json();

  // Configure Fuse to search directly against collection titles
  const fuseInstance = new Fuse(collections, {
    keys: ['title'],
    includeScore: true,
    threshold: 0.5,
    ignoreLocation: true,    // Evaluates words regardless of position in the title
    useExtendedSearch: true, // Enables (termA | termB) OR logic
    minMatchCharLength: 2
  });

  storeCache.set(sanitizedStore, {
    instance: fuseInstance,
    timestamp: now
  });

  return fuseInstance;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const body = req.body || {};
  const query = body.query || req.query.query;
  
  let store = body.store || req.query.store;
  if (!store && req.headers.origin) {
    try {
      store = new URL(req.headers.origin).hostname;
    } catch (e) {}
  }

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ redirect: false, reason: 'Empty query parameter' });
  }

  if (!store || typeof store !== 'string') {
    return res.status(400).json({ redirect: false, reason: 'Missing or invalid store parameter' });
  }

  try {
    const fuse = await getFuseInstanceForStore(store);
    const cleanQuery = query.trim();
    const queryWords = cleanQuery.split(/\s+/).filter(w => w.length > 0);
    const extendedQuery = buildExtendedQuery(cleanQuery);
    let results = fuse.search(extendedQuery);
    if (!results || results.length === 0) {
      results = fuse.search(cleanQuery);
    }
    if (!results || results.length === 0) {
      return res.status(200).json({ redirect: false, reason: 'No match found' });
    }
    let bestMatch = results[0];
    if (queryWords.length > 1) {
      const primaryNoun = queryWords[queryWords.length - 1].toLowerCase();
      const nounMatch = results.slice(0, 5).find(res => {
        const title = res.item.title.toLowerCase();
        return title.includes(primaryNoun) || 
               (SYNONYM_MAP[primaryNoun] && SYNONYM_MAP[primaryNoun].some(syn => title.includes(syn)));
      });
      if (nounMatch && nounMatch.score <= 0.45) {
        bestMatch = nounMatch;
      }
    }

    // Evaluate confidence threshold
    if (bestMatch.score <= 0.5) {
      return res.status(200).json({
        redirect: true,
        handle: bestMatch.item.handle,
        matchedTitle: bestMatch.item.title,
        confidenceScore: Number((1 - bestMatch.score).toFixed(2))
      });
    }

    return res.status(200).json({ 
      redirect: false, 
      reason: 'Best match confidence score fell below acceptable threshold',
      score: bestMatch.score
    });

  } catch (error) {
    console.error(`[Match Error] Store: ${store} | Error:`, error);
    return res.status(500).json({ redirect: false, error: error.message });
  }
}