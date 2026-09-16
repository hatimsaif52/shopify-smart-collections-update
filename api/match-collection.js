import Fuse from 'fuse.js';

const SYNONYM_MAP = {
  'tuxedo': ['suit', 'tux'],
  'tux': ['suit', 'tuxedo'],
  'suit': ['tuxedo', 'tux'],
  'pants': ['trousers', 'slacks'],
  'trousers': ['pants', 'slacks'],
  'shoe': ['footwear', 'sneaker'],
  'boot': ['footwear']
};

// In-memory cache mapping store domains to their Fuse instances and fetch timestamps
// Structure: { [sanitizedStore]: { instance: Fuse, timestamp: number } }
const storeCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache TTL

/**
 * Expands a query string to include interchangeable synonyms
 * e.g., "boot cut tuxedo" -> "boot cut tuxedo suit tux"
 */
function expandQuerySafely(query, synonymMap) {
  const words = query.toLowerCase().trim().split(/\s+/);
  
  return words.map(word => {
    // If exact word has synonyms, group them in Fuse's logical OR syntax
    if (synonymMap[word]) {
      return `(${word} | ${synonymMap[word].join(' | ')})`;
    }
    return word;
  }).join(' ');
}

/**
 * Normalizes store domains into clean string filenames
 * e.g., "my-shop.myshopify.com" -> "my-shop-myshopify-com"
 */
function sanitizeStoreDomain(domain) {
  return domain.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

/**
 * Fetches the collection map for a specific store from Blob Storage 
 * and initializes or returns the cached Fuse.js instance.
 */
async function getFuseInstanceForStore(storeDomain) {
  const sanitizedStore = sanitizeStoreDomain(storeDomain);
  const now = Date.now();

  // Check if warm cache exists and is fresh
  if (storeCache.has(sanitizedStore)) {
    const cached = storeCache.get(sanitizedStore);
    if (now - cached.timestamp < CACHE_TTL_MS) {
      return cached.instance;
    }
  }

  // Construct Vercel Blob CDN URL
  const blobBaseUrl = process.env.VERCEL_BLOB_BASE_URL;
  const blobUrl = `${blobBaseUrl}/${sanitizedStore}-collections.json`;

  const resp = await fetch(blobUrl);
  if (!resp.ok) {
    throw new Error(`Failed to load collection map for store "${storeDomain}" from Blob storage (HTTP ${resp.status})`);
  }

  const collections = await resp.json();

  // Configure Fuse.js algorithm
  const fuseInstance = new Fuse(collections, {
    keys: ['title'],
    includeScore: true,
    threshold: 0.5,       // 0.0 = exact match, 1.0 = matches anything
    ignoreLocation: true,
    useExtendedSearch: true,
    distance: 100,        // Spatial search range for typos
    minMatchCharLength: 3,
    findAllMatches: true
  });

  // Save to in-memory store cache
  storeCache.set(sanitizedStore, {
    instance: fuseInstance,
    timestamp: now
  });

  return fuseInstance;
}

export default async function handler(req, res) {
  // CORS Headers for storefront request flexibility
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Parse body/query params
  const body = req.body || {};
  const query = body.query || req.query.query;
  
  // Extract store domain: passed explicitly, or fallback to the request Host/Origin header
  let store = body.store || req.query.store;
  if (!store && req.headers.origin) {
    try {
      store = new URL(req.headers.origin).hostname;
    } catch (e) {
      // Ignore URL parsing errors
    }
  }

  // 1. Validate inputs
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ redirect: false, reason: 'Empty query parameter' });
  }

  if (!store || typeof store !== 'string') {
    return res.status(400).json({ redirect: false, reason: 'Missing or invalid store parameter' });
  }

  try {
    // 2. Fetch the store-specific Fuse instance
    const fuse = await getFuseInstanceForStore(store);
    const cleanQuery = query.trim();

    // 1. Expand query with synonyms ("boot cut tuxedo" -> "boot cut tuxedo suit tux")
    const expandedQuery = expandQueryWithSynonyms(cleanQuery);
    const queryWords = cleanQuery.split(/\s+/).filter(w => w.length > 2);

    let bestMatch = null;

    // PASS 1: Check 2-word phrase matches using original words
    if (queryWords.length >= 2) {
      for (let i = 0; i < queryWords.length - 1; i++) {
        const pair = `${queryWords[i]} ${queryWords[i+1]}`;
        
        // Also expand synonyms for the phrase pair (e.g., "cut tuxedo" -> "cut tuxedo suit")
        const expandedPair = expandQueryWithSynonyms(pair);
        const pairResults = fuse.search(expandedPair);

        if (pairResults.length > 0 && pairResults[0].score <= 0.38) {
          bestMatch = pairResults[0];
          break;
        }
      }
    }

    // PASS 2: Fall back to full expanded query search
    if (!bestMatch) {
      const fullResults = fuse.search(expandedQuery);
      if (fullResults && fullResults.length > 0) {
        bestMatch = fullResults[0];
      }
    }

    if (!bestMatch) {
      return res.status(200).json({ redirect: false, reason: 'No match found' });
    }

    // Final Score Check
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