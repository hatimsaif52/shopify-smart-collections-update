// api/process-chunks.js
import { Client } from "@upstash/qstash";

const qstashClient = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // 1. Accept the dryRun flag from the incoming body payload
    const { collectionsJsonlUrl, storeCfg, dryRun = false } = req.body;

    const response = await fetch(collectionsJsonlUrl);
    const text = await response.text();
    const collections = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    
    const chunkSize = 500; 
    const totalChunks = Math.ceil(collections.length / chunkSize);

    console.log(`[DRY RUN: ${dryRun}] Splitting ${collections.length} collections into ${totalChunks} chunks for ${storeCfg.store}`);

    for (let i = 0; i < collections.length; i += chunkSize) {
      const chunk = collections.slice(i, i + chunkSize);

      await qstashClient.publishJSON({
        url: `https://${req.headers.host}/api/update-collection-chunk`,
        body: {
          storeCfg,
          collectionChunk: chunk,
          dryRun // 2. Forward the safety flag to the workers
        }
      });
    }

    return res.status(200).json({ 
      message: `Successfully queued ${totalChunks} chunks. Mode: ${dryRun ? 'DRY RUN (Simulated)' : 'LIVE UPDATE'}` 
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}