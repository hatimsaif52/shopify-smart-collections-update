// api/finalize-bulk-update.js
import { list, del, get } from '@vercel/blob';
import { uploadJsonl, runBulk } from './shopifyUtils.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { storeCfg, batchId, dryRun = false } = req.body;
    console.log(`[Finalizer] Initializing data assembly for Batch: ${batchId}`);

    // 1. Fetch whatever chunks were uploaded
    const { blobs } = await list({ 
      prefix: `batches/${batchId}/`,
      access: 'private' 
    });
    
    let combinedJsonlLines = [];
    const blobUrlsToDelete = [];

    // 2. If blobs exist, download and combine them
    if (blobs && blobs.length > 0) {
      const sortedBlobs = blobs.sort((a, b) => a.url.localeCompare(b.url));

      for (const blob of sortedBlobs) {
        const response = await get(blob.url, { access: 'private' });
        const text = await response.text();
        if (text.trim()) {
          combinedJsonlLines.push(text.trim());
        }
        blobUrlsToDelete.push(blob.url); // Track URL for deletion
      }
    }

    const masterJsonl = combinedJsonlLines.join('\n');
    const modificationsCount = masterJsonl.split('\n').filter(Boolean).length;

    // --- CLEANUP FUNCTION ---
    const cleanupBlobs = async () => {
      if (blobUrlsToDelete.length > 0) {
        console.log(`[Finalizer] Cleaning up ${blobUrlsToDelete.length} temporary chunk files from storage...`);
        for (const url of blobUrlsToDelete) {
          await del(url, { access: 'private' });
        }
      }
    };

    // --- DRY RUN PATH ---
    if (dryRun) {
      console.log(`[DRY RUN MASTER] Modifications skipped: ${modificationsCount}`);
      await cleanupBlobs(); // Delete blobs after dry run
      return res.status(200).json({
        message: "Dry run finalized. Master file combined successfully.",
        totalModificationsSimulated: modificationsCount
      });
    }

    // --- NO MODIFICATIONS PATH ---
    if (modificationsCount === 0) {
      console.log(`[Finalizer] No adjustments needed across any collections.`);
      await cleanupBlobs(); // Delete any lingering placeholder blobs
      return res.status(200).json({ message: "No updates needed across entire store catalog." });
    }

    // 3. EXECUTE THE SINGLE MASSIVE SHOPIFY MUTATION 
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

    // 4. CLEAN UP BLOBS IMMEDIATELY AFTER SUCCESSFUL EXECUTION
    await cleanupBlobs();

    console.log(`[Finalizer] Completed single massive bulk update for ${storeCfg.store}.`);
    return res.status(200).json({ status: "Complete", modificationsCount, executionResponse });

  } catch (err) {
    console.error("Aggregation Pipeline Failed: ", err);
    return res.status(500).json({ error: err.message });
  }
}