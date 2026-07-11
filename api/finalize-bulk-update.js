// api/finalize-bulk-update.js
import { list, del } from '@vercel/blob';
import { uploadJsonl, runBulk } from './shopifyUtils.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { storeCfg, batchId, totalChunks, dryRun = false } = req.body;
    console.log(`[Finalizer] Initializing data assembly for Batch: ${batchId}`);

    // 1. Fetch all matching blob files under this batch group prefix path
    const { blobs } = await list({ prefix: `batches/${batchId}/` });
    
    // Safety verification check: Make sure all async workers hit the cloud disk space first
    if (blobs.length < totalChunks) {
      return res.status(422).json({ error: `Missing chunks. Found ${blobs.length}/${totalChunks}. Postponing mutation.` });
    }

    let combinedJsonlLines = [];
    const blobUrlsToDelete = [];

    // 2. Aggregate the contents of all chunks sequentially
    // Sort to keep array patterns uniform 
    const sortedBlobs = blobs.sort((a, b) => a.url.localeCompare(b.url));

    for (const blob of sortedBlobs) {
      const response = await fetch(blob.url);
      const text = await response.text();
      if (text.trim()) {
        combinedJsonlLines.push(text.trim());
      }
      blobUrlsToDelete.push(blob.url);
    }

    const masterJsonl = combinedJsonlLines.join('\n');
    const modificationsCount = masterJsonl.split('\n').filter(Boolean).length;

    // --- DRY RUN OPTION ---
    if (dryRun) {
      console.log(`[DRY RUN MASTER] Completed. Total modifications skipped: ${modificationsCount}`);
      // Clean up blobs immediately
      for (const url of blobUrlsToDelete) await del(url);
      
      return res.status(200).json({
        message: "Dry run finalized. Master file combined successfully.",
        totalModificationsSimulated: modificationsCount
      });
    }

    if (modificationsCount === 0) {
      console.log(`[Finalizer] No adjustments needed across any collections. Skipping Shopify mutation.`);
      for (const url of blobUrlsToDelete) await del(url);
      return res.status(200).json({ message: "No updates needed across entire store catalog." });
    }

    // 3. EXECUTE EXACTLY ONE SINGLE MASTER SHOPIFY MUTATION 
    const mutationSignature = `
      mutation collectionUpdate($input: CollectionInput!) {
        collectionUpdate(input: $input) {
          collection { id }
          userErrors { field message }
        }
      }
    `;

    console.log(`[Finalizer] Uploading ${modificationsCount} collection mutations onto Shopify...`);
    const stagedPath = await uploadJsonl(storeCfg, masterJsonl);
    const executionResponse = await runBulk(storeCfg, stagedPath, mutationSignature);

    // 4. Clean up Vercel Blob storage to free up disk space
    for (const url of blobUrlsToDelete) {
      await del(url);
    }

    console.log(`[Finalizer] Successfully submitted single massive bulk update for ${storeCfg.store}.`);
    return res.status(200).json({ status: "Complete", modificationsCount, executionResponse });

  } catch (err) {
    console.error("Aggregation Pipeline Failed: ", err);
    return res.status(500).json({ error: err.message });
  }
}