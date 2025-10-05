// Vercel Serverless Function: GET /api/ethusd?k=<TOKEN>
// Public Coinbase ticker → 3 samples (≈1s apart) → median anchor
// Mid fallback if no trade; token gate included; no indexing headers.

const TOKEN = "EMCS_anchor_2025_Ry2gX3D8qPp4Jc9mN7vU6kLt2BQa0wHf";
const TICKER = "https://api.coinbase.com/api/v3/brokerage/market/products/ETH-USD/ticker";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (x) => (x === undefined || x === null || x === "" ? null : Number(x));
const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const median = (arr) => [...arr].sort((a,b)=>a-b)[Math.floor(arr.length/2)];

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (TOKEN && url.searchParams.get("k") !== TOKEN) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      return res.status(403).json({ error: "forbidden" });
    }

    const samples = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(TICKER, {
        headers: { "Cache-Control": "no-cache", "Accept": "application/json" }
      });
      if (!r.ok) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        return res.status(502).json({ error: `coinbase_status_${r.status}` });
      }
      const d = await r.json();
      const price = num(d.price) ?? num(d?.trades?.[0]?.price);
      const bid   = num(d.best_bid) ?? num(d.bid);
      const ask   = num(d.best_ask) ?? num(d.ask);
      const server= d.time ?? d.timestamp ?? null;
      samples.push({ price, bid, ask, server });
      if (i < 2) await sleep(1000);
    }

    const tradePrices = samples.map(s => s.price).filter(isNum);
    let anchor, type;
    if (tradePrices.length) { anchor = median(tradePrices); type = "last_trade"; }
    else {
      const mids = samples.map(s => (isNum(s.bid)&&isNum(s.ask)) ? (s.bid+s.ask)/2 : null).filter(isNum);
      if (!mids.length) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        return res.status(502).json({ error: "no_price" });
      }
      anchor = median(mids); type = "mid_fallback";
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({
      product: "ETH-USD",
      source: "coinbase_rest_public",
      type,
      price: anchor,
      samples,
      request_ts: new Date().toISOString()
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
