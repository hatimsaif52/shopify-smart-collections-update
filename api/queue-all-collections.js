import { Client } from '@upstash/qstash';

export default async function handler(req, res) {
  try {
    // Validate Authorization
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const stores = JSON.parse(process.env.SHOPIFY_STORES_CONFIG || '[]');
    
    if (stores.length === 0) {
      return res.status(200).json({ message: 'No stores configured' });
    }

    const qstashClient = new Client({
      token: process.env.QSTASH_TOKEN,
    });

    const baseUrl = process.env.VERCEL_URL 
      ? `https://${process.env.VERCEL_URL}` 
      : req.headers.host 
      ? `https://${req.headers.host}` 
      : 'http://localhost:3000';

    // Queue sync job for each store
    const queuePromises = stores.map(store => {
      return qstashClient.publishJSON({
        url: `${baseUrl}/api/sync-collections`,
        body: { store: store.store },
        headers: {
          'Authorization': `Bearer ${process.env.CRON_SECRET}`
        }
      });
    });

    await Promise.all(queuePromises);

    return res.status(200).json({
      success: true,
      queued: stores.length,
      stores: stores.map(s => s.store)
    });

  } catch (error) {
    console.error('[Queue All Collections Error]:', error);
    return res.status(500).json({ error: error.message });
  }
}
