// api/update-collection-chunk.js
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { storeCfg, collectionChunk, dryRun = false, batchId, chunkIndex, totalChunks } = req.body;
    let jsonlLines = [];

    const MANDATORY_RULES = [
      { column: "VARIANT_INVENTORY", relation: "GREATER_THAN", condition: "0" }, 
      { column: "VARIANT_PRICE", relation: "GREATER_THAN", condition: "0" }      
    ];

    for (const collection of collectionChunk) {
      const ruleSet = collection.ruleSet || { rules: [], appliedDisjunctively: false };
      if (ruleSet.appliedDisjunctively) continue;

      const existingRules = ruleSet.rules || [];
      const missingRules = MANDATORY_RULES.filter(mRule => 
        !existingRules.some(eRule => eRule.column === mRule.column && eRule.relation === mRule.relation)
      );

      if (missingRules.length === 0) continue;

      const finalRules = [...existingRules, ...missingRules].map(r => ({
        column: r.column,
        relation: r.relation,
        condition: r.condition
      }));

      jsonlLines.push(JSON.stringify({
        input: {
          id: collection.id,
          ruleSet: { appliedDisjunctively: false, rules: finalRules }
        }
      }));
    }

    // Even if no collections need updating, write an empty file to maintain chunk counting indexes
    const chunkJsonl = jsonlLines.join('\n');
    
    // Save this specific chunk text directly into Vercel Blob
    if(chunkJsonl.trim() !== '') {
      await put(`batches/${batchId}/chunk-${chunkIndex}.jsonl`, chunkJsonl, {
        access: 'public',
        contentType: 'text/jsonl'
      });
    }
    
    console.log(`[Batch ${batchId}] Saved Chunk ${chunkIndex + 1}/${totalChunks} to Blob Storage.`);

    // If this is the absolute final chunk item pushed to execution logs, call finalizer
    if (chunkIndex === totalChunks - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await fetch(`https://${req.headers.host}/api/finalize-bulk-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeCfg, batchId, totalChunks, dryRun })
      });
    }

    return res.status(200).json({ status: `Chunk ${chunkIndex} Saved.` });

  } catch (err) {
    console.error("Worker Execution Failure: ", err);
    return res.status(500).json({ error: err.message });
  }
}