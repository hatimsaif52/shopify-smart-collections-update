import MiniSearch from 'minisearch';

const storeCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

const SYNONYM_MAP = {
  'tuxedo': ['suit', 'tux'],
  'tux': ['suit', 'tuxedo'],
  'suit': ['tuxedo', 'tux'],
  'pants': ['trousers', 'slacks'],
  'trousers': ['pants', 'slacks'],
  'boot': ['boots', 'footwear'],
  'boots': ['boot', 'footwear']
};

function sanitizeStoreDomain(domain) {
  return domain.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

async function getMiniSearchInstanceForStore(storeDomain) {
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
    throw new Error(`Failed to load collections for store "${storeDomain}" (HTTP ${resp.status})`);
  }

  const rawCollections = await resp.json();

  const collectionsWithId = rawCollections.map((col, index) => ({
    id: col.handle || `idx-${index}`,
    title: col.title,
    handle: col.handle
  }));

  const miniSearch = new MiniSearch({
    fields: ['title'],       
    storeFields: ['title', 'handle'], 
    // Global options used during index construction
    tokenize: string => string.toLowerCase().split(/[^a-z0-9]+/)
  });

  miniSearch.addAll(collectionsWithId);

  storeCache.set(sanitizedStore, {
    instance: miniSearch,
    timestamp: now
  });

  return miniSearch;
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
    return res.status(400).json({ redirect: false, reason: 'Missing store parameter' });
  }

  try {
    const miniSearch = await getMiniSearchInstanceForStore(store);
    const cleanQuery = query.trim().toLowerCase();
    const queryWords = cleanQuery.split(/[^a-z0-9]+/).filter(w => w.length > 0);

    const baseSearchOptions = {
      fields: ['title'],
      boost: { title: 2 },
      fuzzy: 0.2,
      prefix: true
    };

    // 1. PASS 1: Strict 'AND' Search 
    let results = miniSearch.search(cleanQuery, { ...baseSearchOptions, combineWith: 'AND' });

    // 2. PASS 2: Programmatic Synonym Expansion Object Pass
    if (results.length === 0) {
      const structuredQuery = {
        combineWith: 'AND',
        queries: queryWords.map(word => {
          const synonyms = SYNONYM_MAP[word] || [];
          const terms = [word, ...synonyms];
          return {
            combineWith: 'OR',
            queries: terms.map(t => ({ ...baseSearchOptions, term: t }))
          };
        })
      };
      results = miniSearch.search(structuredQuery);
    }

    // 3. PASS 3: Fallback 'OR' Search with high matching criteria
    if (results.length === 0) {
      results = miniSearch.search(cleanQuery, { ...baseSearchOptions, combineWith: 'OR' });
    }

    if (!results || results.length === 0) {
      return res.status(200).json({ redirect: false, reason: 'No match found' });
    }

    let bestMatch = results[0];

    // 4. FIX: STABLE NOUN VALIDATION USING MINISEARCH'S TOKEN ENGINE
    if (queryWords.length > 1) {
      const primaryNoun = queryWords[queryWords.length - 1];
      const validNouns = [primaryNoun, ...(SYNONYM_MAP[primaryNoun] || [])];

      // Perform a localized verification match purely for our trusted nouns
      const verificationResults = miniSearch.search({
        combineWith: 'OR',
        queries: validNouns.map(noun => ({ ...baseSearchOptions, term: noun }))
      });
      
      const verifiedIds = new Set(verificationResults.map(r => r.id));

      // Attempt to find the top scoring candidate that satisfies our category noun requirement
      const strictMatch = results.find(res => verifiedIds.has(res.id));

      if (strictMatch) {
        bestMatch = strictMatch;
      } else {
        return res.status(200).json({
          redirect: false,
          reason: `No collection found matching primary category term: '${primaryNoun}'`
        });
      }
    }

    // Dynamic threshold: Reject only absolute baseline noise scores
    if (bestMatch.score >= 0.2) {
      return res.status(200).json({
        redirect: true,
        handle: bestMatch.handle,
        matchedTitle: bestMatch.title,
        confidenceScore: Number(bestMatch.score.toFixed(2))
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
