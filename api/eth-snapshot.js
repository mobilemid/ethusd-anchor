// GET /api/eth-snapshot  (Vercel serverless, Node 18+)
// Coinbase Advanced Trade REST: take 3 samples (~1s apart) of last trade -> median.
// If last trade is stale (>10s), fallback to best_bid_ask mid.
// Cross-check against Coinbase Exchange public ticker and flag discrepancy.
// Also returns ETH/BTC ratio.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (x) => (x === undefined || x === null || x === "" ? null : Number(x));
const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const median = (arr) => { const a=[...arr].sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };

async function cbTicker(product) {
  const u = `https://api.coinbase.com/api/v3/brokerage/market/products/${product}/ticker`;
  const r = await fetch(u, { headers:{ "Accept":"application/json","Cache-Control":"no-cache","User-Agent":"emcs-snapshot/1.0" }});
  if (!r.ok) throw new Error(`CB ticker ${product} ${r.status}`);
  return r.json();
}
async function cbBestBidAsk(product) {
  const u = `https://api.coinbase.com/api/v3/brokerage/market/products/${product}/best_bid_ask`;
  const r = await fetch(u, { headers:{ "Accept":"application/json","Cache-Control":"no-cache","User-Agent":"emcs-snapshot/1.0" }});
  if (!r.ok) throw new Error(`CB best_bid_ask ${product} ${r.status}`);
  return r.json();
}
async function cbxTicker(product) {
  const u = `https://api.exchange.coinbase.com/products/${product}/ticker`;
  const r = await fetch(u, { headers:{ "Accept":"application/json","Cache-Control":"no-cache","User-Agent":"emcs-snapshot/1.0" }});
  if (!r.ok) throw new Error(`CBX ticker ${product} ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  const send = (status, body) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-robots-tag", "noindex, nofollow");
    res.setHeader("access-control-allow-origin", "*");
    res.status(status).send(JSON.stringify(body));
  };

  try {
    const tz = "America/Chicago";
    const local_ts = new Date().toLocaleString("en-US", { timeZone: tz });

    // 3-sample median (ETH-USD last trade)
    const samples = [], serverTimestamps = [];
    for (let i=0;i<3;i++){
      const t = await cbTicker("ETH-USD");
      samples.push(num(t.price) ?? num(t?.trades?.[0]?.price));
      serverTimestamps.push(t.time ?? t.trade_time ?? t.timestamp ?? null);
      if (i<2) await sleep(1000);
    }
    const tradePrices = samples.filter(isNum);
    if (!tradePrices.length) throw new Error("no last-trade prices");
    let anchorUsed = "last_trade";
    let anchorPrice = median(tradePrices);

    // age check; if stale use mid
    const ages = serverTimestamps.map(s => (s ? Math.max(0,(Date.now()-new Date(s).getTime())/1000) : null)).filter(v=>v!==null);
    const minAge = ages.length ? Math.min(...ages) : null;
    let anchorAgeSeconds = minAge !== null ? Math.round(minAge) : null;
    if (anchorAgeSeconds !== null && anchorAgeSeconds > 10) {
      const bba = await cbBestBidAsk("ETH-USD");
      const bid = num(bba?.pricebook?.bids?.[0]?.price), ask = num(bba?.pricebook?.asks?.[0]?.price);
      if (isNum(bid) && isNum(ask)) { anchorUsed="mid_bid_ask"; anchorPrice=(bid+ask)/2; }
    }

    // cross-check (Coinbase Exchange)
    const x = await cbxTicker("ETH-USD");
    const crossPrice = num(x.price) ?? num(x.last) ?? num(x.bid) ?? num(x.ask) ?? null;
    const crossTs = x.time ?? x.trade_time ?? x.timestamp ?? null;
    let discrepancy="unavailable", diffPct=null;
    if (isNum(crossPrice)) {
      diffPct = Math.abs(anchorPrice - crossPrice)/((anchorPrice+crossPrice)/2)*100;
      discrepancy = diffPct>0.20 ? "material" : diffPct>0.05 ? "minor" : "none";
    }

    // ETH/BTC ratio
    const [ethT, btcT] = await Promise.all([cbTicker("ETH-USD"), cbTicker("BTC-USD")]);
    const ethUsd = num(ethT.price), btcUsd = num(btcT.price);
    const ethBtc = (isNum(ethUsd) && isNum(btcUsd) && btcUsd!==0) ? ethUsd/btcUsd : null;

    send(200, {
      anchor: {
        venue: "Coinbase Advanced Trade REST",
        product: "ETH-USD",
        used: anchorUsed,
        price: Number(anchorPrice.toFixed(2)),
        local_timestamp: local_ts,
        server_timestamps: serverTimestamps,
        anchor_age_seconds: anchorAgeSeconds
      },
      cross_check: {
        venue: "Coinbase Exchange public ticker",
        product: "ETH-USD",
        price: isNum(crossPrice) ? Number(crossPrice.toFixed(2)) : null,
        server_timestamp: crossTs,
        discrepancy: { level: discrepancy, diff_pct: diffPct }
      },
      ratios: { eth_btc: ethBtc }
    });
  } catch (e) {
    send(500, { error: e?.message || String(e) });
  }
}
