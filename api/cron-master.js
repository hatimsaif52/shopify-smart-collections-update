// api/cron-collections.js
import { shopifyGraphql } from './shopifyUtils.js';
import { Client } from "@upstash/qstash";

const qstashClient = new Client({ token: process.env.QSTASH_TOKEN });
const DEFAULT_API_VERSION = '2024-04';

export default async function handler(req, res) {
  try {
    const { searchParams } = new URL(req.url, `https://${req.headers.host}`);
    const manualStore = searchParams.get('store');
    const authHeader = req.headers.authorization;
    
    // 1. Detect if this is a dry run from the query string (?dryRun=true)
    const dryRun = searchParams.get('dryRun') === 'true';

    if (!manualStore && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const stores = JSON.parse(process.env.SHOPIFY_STORES_CONFIG);
    let storeCfg;

    if (manualStore) {
      storeCfg = stores.find(s => s.store === manualStore);
    } else {
      storeCfg = stores[Math.floor(Date.now() / (1000 * 60 * 60 * 24)) % stores.length];
    }

    if (!storeCfg) return res.status(404).json({ error: 'Store config not found' });
    
    storeCfg.api_version ||= DEFAULT_API_VERSION;
    if (typeof resolveShopifyToken === 'function') {
      storeCfg.token = await resolveShopifyToken(storeCfg);
    }

    console.log(`[DRY RUN: ${dryRun}] Starting bulk extraction for: ${storeCfg.store}`);

    const bulkQuery = `
      mutation {
        bulkOperationRunQuery(
          query: """
            query {
              collections(query: "collection_type:smart") {
                edges {
                  node {
                    id
                    handle
                    ruleSet {
                      appliedDisjunctively
                      rules { column relation condition }
                    }
                  }
                }
              }
            }
          """
        ) {
          bulkOperation { id status }
          userErrors { field message }
        }
      }
    `;

    const response = await shopifyGraphql(storeCfg.store, storeCfg.token, storeCfg.api_version, bulkQuery);
    const result = response?.data?.bulkOperationRunQuery;

    if (result?.userErrors?.length > 0) {
      throw new Error(`Shopify Bulk Extract Error: ${result.userErrors[0].message}`);
    }

    const operationId = result.bulkOperation.id;

    // 2. Forward the dryRun variable flag inside the QStash payload
    await qstashClient.publishJSON({
      url: `https://${req.headers.host}/api/check-bulk-status`,
      delay: "5m", 
      body: {
        storeCfg,
        operationId,
        dryRun
      }
    });

    console.log(`Scheduled status check worker for ${storeCfg.store}. Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

    return res.status(200).json({
      message: `Bulk retrieval started. ${dryRun ? 'DRY RUN simulation' : 'LIVE run'} scheduled in 5 minutes.`,
      store: storeCfg.store,
      operationId,
      dryRun
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}