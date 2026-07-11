// api/process-chunks.js
import { Client } from "@upstash/qstash";

const qstashClient = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { collectionsJsonlUrl, storeCfg, dryRun = false } = req.body;

    const response = await fetch(collectionsJsonlUrl);
    const text = await response.text();
    const collections = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    
    const chunkSize = 500; 
    const totalChunks = Math.ceil(collections.length / chunkSize);
    const batchId = `${storeCfg.store.replace(/[^a-zA-Z0-9]/g, '')}-${Date.now()}`;

    console.log(`[Batch: ${batchId}] Enqueueing ${totalChunks} ordered FIFO chunks for ${storeCfg.store}`);

    for (let i = 0; i < collections.length; i += chunkSize) {
      const chunk = collections.slice(i, i + chunkSize);
      const chunkIndex = i / chunkSize;

      // Publish with sequential group ordering
      await qstashClient.publishJSON({
        url: `https://${req.headers.host}/api/update-collection-chunk`,
        group: batchId, 
        body: {
          storeCfg,
          collectionChunk: chunk,
          dryRun,
          batchId,
          chunkIndex,
          totalChunks
        }
      });
    }

    return res.status(200).json({ message: `Successfully queued ordered chunks.`, batchId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}