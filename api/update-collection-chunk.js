// api/update-collection-chunk.js
import { uploadJsonl, runBulk } from './shopifyUtils.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { storeCfg, collectionChunk, dryRun = false } = req.body;
    let jsonlLines = [];
    let dryRunReport = [];

    const MANDATORY_RULES = [
      { column: "VARIANT_INVENTORY", relation: "GREATER_THAN", condition: "0" }, 
      { column: "VARIANT_PRICE", relation: "GREATER_THAN", condition: "0" }      
    ];

    for (const collection of collectionChunk) {
      const ruleSet = collection.ruleSet || { rules: [], appliedDisjunctively: false };
      
      if (ruleSet.appliedDisjunctively) {
        dryRunReport.push({ id: collection.id, handle: collection.handle, status: "SKIPPED_DISJUNCTIVE" });
        continue;
      }

      const existingRules = ruleSet.rules || [];
      const missingRules = MANDATORY_RULES.filter(mRule => 
        !existingRules.some(eRule => eRule.column === mRule.column && eRule.relation === mRule.relation)
      );

      if (missingRules.length === 0) {
        dryRunReport.push({ id: collection.id, handle: collection.handle, status: "NO_CHANGES_REQUIRED" });
        continue;
      }

      const finalRules = [...existingRules, ...missingRules].map(r => ({
        column: r.column,
        relation: r.relation,
        condition: r.condition
      }));

      // Map out simulation details for logs
      dryRunReport.push({
        id: collection.id,
        handle: collection.handle,
        status: "NEEDS_UPDATE",
        addedRules: missingRules
      });

      const mutationLine = {
        input: {
          id: collection.id,
          ruleSet: { appliedDisjunctively: false, rules: finalRules }
        }
      };

      jsonlLines.push(JSON.stringify(mutationLine));
    }

    // --- DRY RUN EXIT PATH ---
    if (dryRun) {
      const changingCount = dryRunReport.filter(r => r.status === "NEEDS_UPDATE").length;
      console.log(`[DRY RUN REPORT] Store: ${storeCfg.store}. Total evaluated: ${dryRunReport.length}. Modifications needed: ${changingCount}`);
      
      // Log the specific items changing so you can audit them in Vercel logs
      console.log("Simulated changes:", JSON.stringify(dryRunReport.filter(r => r.status === "NEEDS_UPDATE"), null, 2));

      return res.status(200).json({
        message: "Dry run completed successfully. No data was written to Shopify.",
        summary: {
          totalEvaluated: dryRunReport.length,
          willUpdate: changingCount,
          details: dryRunReport
        }
      });
    }

    // --- LIVE ROAD ---
    if (jsonlLines.length === 0) {
      return res.status(200).json({ message: "No adjustments required for this chunk." });
    }

    const bulkInputJsonl = jsonlLines.join('\n');
    const mutationSignature = `
      mutation collectionUpdate($input: CollectionInput!) {
        collectionUpdate(input: $input) {
          collection { id }
          userErrors { field message }
        }
      }
    `;

    const stagedPath = await uploadJsonl(storeCfg, bulkInputJsonl);
    const executionResponse = await runBulk(storeCfg, stagedPath, mutationSignature);

    return res.status(200).json({ status: "Processing Live Bulk Operations", executionResponse });

  } catch (err) {
    console.error("Worker Execution Failure: ", err);
    return res.status(500).json({ error: err.message });
  }
}