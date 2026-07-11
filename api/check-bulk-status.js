// api/check-bulk-status.js
import { shopifyGraphql } from './shopifyUtils.js';
import { Client } from "@upstash/qstash";

const qstashClient = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // 1. Grab dryRun flag out of the QStash request body
    const { storeCfg, operationId, dryRun = false } = req.body;

    console.log(`Checking bulk status for: ${storeCfg.store}. Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

    const statusQuery = `
      query {
        node(id: "${operationId}") {
          ... on BulkOperation { id status url errorCode }
        }
      }
    `;

    const response = await shopifyGraphql(storeCfg.store, storeCfg.token, storeCfg.api_version, statusQuery);
    const operation = response?.data?.node;

    if (!operation) {
      return res.status(404).json({ error: "Bulk operation context missing from Shopify response." });
    }

    if (operation.status === 'COMPLETED') {
      if (!operation.url) {
        return res.status(200).json({ message: "Operation completed, but no data was returned." });
      }

      // 2. Forward dryRun flag into your chunking engine
      await fetch(`https://${req.headers.host}/api/process-chunks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectionsJsonlUrl: operation.url,
          storeCfg,
          dryRun
        })
      });

      return res.status(200).json({ message: "Bulk operation finished. Sent to chunk processor." });
    } 
    
    if (operation.status === 'RUNNING' || operation.status === 'CREATED') {
      // 3. Keep the dryRun context intact across retry loops
      await qstashClient.publishJSON({
        url: `https://${req.headers.host}/api/check-bulk-status`,
        delay: "5m",
        body: { storeCfg, operationId, dryRun }
      });

      return res.status(200).json({ message: "Operation still processing. Rescheduled." });
    }

    return res.status(500).json({ 
      error: `Shopify bulk task stopped prematurely. Status: ${operation.status}.` 
    });

  } catch (err) {
    console.error("Status Checker Error: ", err);
    return res.status(500).json({ error: err.message });
  }
}