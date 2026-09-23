// Read-only live market adapter. No credentials are included in this script.
(async function loadLiveMarkets(){
  const api = window.__FLOATSHEETS_API_URL__;
  if (!api) return;
  try {
    const response = await fetch(api.replace(/\/$/, '') + '/v1/markets', {headers:{accept:'application/json'}});
    if (!response.ok) throw new Error('market snapshot unavailable');
    const payload = await response.json();
    if (!Array.isArray(payload.markets) || !payload.markets.length) return;
    const liveMarkets = payload.markets.map(function(row){
      const price = Number(row.twap_price_usdg ?? row.spot_price_usdg);
      const status = String(row.status || '').toLowerCase();
      const tradable = row.oracle_tradable === true && status === 'active' && Number.isFinite(price) && price > 0;
      return {symbol:String(row.symbol),name:String(row.symbol)+' equity',price:Number.isFinite(price)?price:0,change:0,
        band:Number(row.max_half_spread_bps || 0)/10000,max:Number(row.max_leverage || 1),cap:Number(row.max_ticket_usdg || 0),oi:0,
        state:tradable?'LIVE':(status==='disabled'?'HALTED':'CLOSE_ONLY'),sector:'Equity',oracleTradable:tradable};
    }).filter(function(row){return row.price>0;});
    if (!liveMarkets.length) return;
    markets=liveMarkets; selected=markets[0]; stale=!selected.oracleTradable; render();
    if (typeof toast === 'function') toast('Live Robinhood Chain market data loaded.');
  } catch (error) { console.error('FloatSheets live market load failed', error); }
})();
