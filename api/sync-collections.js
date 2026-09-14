import { put } from '@vercel/blob';
import { 
  runBulkQuery, 
  getCurrentBulkOperationStatus, 
  sleep 
} from './shopifyUtils.js';

export default async function handler(req, res) {
  try {
    // 1. Extract query params and auth header
    const { searchParams } = new URL(req.url, `https://${req.headers.get('host') || 'localhost'}`);
    const manualStore = searchParams.get('store');
    const authHeader = req.headers.get('authorization') || req.headers.authorization;

    // 2. Validate Authorization
    if (!manualStore && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 3. Resolve target store configuration
    const stores = JSON.parse(process.env.SHOPIFY_STORES_CONFIG || '[]');
    let storeCfg;

    if (manualStore) {
      storeCfg = stores.find(s => s.store === manualStore);
    } else {
      // Deterministically pick a store based on the current day index
      const dayIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
      storeCfg = stores[dayIndex % stores.length];
    }

    if (!storeCfg) {
      return res.status(404).json({ error: 'Store config not found' });
    }

    // 4. Check if a bulk operation is already running
    const currentOp = await getCurrentBulkOperationStatus(storeCfg);
    if (currentOp && currentOp.status === 'RUNNING') {
      return res.status(409).json({ 
        message: `A bulk query is already in progress for store ${storeCfg.store}` 
      });
    }

    // 5. Start Bulk Query for Collections
    const bulkQuery = `{
      collections {
        edges {
          node {
            title
            handle
          }
        }
      }
    }`;

    const runResult = await runBulkQuery(storeCfg, bulkQuery);
    if (runResult.skipped) {
      return res.status(409).json({ message: 'Bulk query already in progress' });
    }

    // 6. Poll Bulk Operation status
    let bulkStatus = await getCurrentBulkOperationStatus(storeCfg);
    while (bulkStatus.status === 'RUNNING' || bulkStatus.status === 'CREATED') {
      await sleep(3000);
      bulkStatus = await getCurrentBulkOperationStatus(storeCfg);
    }

    if (bulkStatus.status !== 'COMPLETED') {
      throw new Error(`Bulk operation failed with status: ${bulkStatus.status}`);
    }

    if (!bulkStatus.url) {
      return res.status(200).json({ message: 'No collections found in store.' });
    }

    // 7. Parse JSONL output
    const jsonlResponse = await fetch(bulkStatus.url);
    const jsonlText = await jsonlResponse.text();

    const collections = jsonlText
      .trim()
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => {
        const item = JSON.parse(line);
        return {
          title: item.title,
          handle: item.handle
        };
      });

    // 8. Save store-specific map file to Vercel Blob
    // Named per-store (e.g. 'shop-one-myshopify-com-collections.json') to avoid multi-tenant overwrites
    const sanitizedStoreName = storeCfg.store.replace(/[^a-zA-Z0-9]/g, '-');
    const fileName = `${sanitizedStoreName}-collections.json`;

    const blob = await put(fileName, JSON.stringify(collections), {
      access: 'public',
      addRandomSuffix: false
    });

    return res.status(200).json({
      success: true,
      store: storeCfg.store,
      count: collections.length,
      blobUrl: blob.url
    });

  } catch (error) {
    console.error('[Multi-Store Sync Error]:', error);
    return res.status(500).json({ error: error.message });
  }
}