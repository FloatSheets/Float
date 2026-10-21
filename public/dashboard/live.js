// Read-only live market adapter. No credentials are included in this script.
(async function loadLiveMarkets(){
  const api = window.__FLOATSHEETS_SERVER_API__;
  if (!api) return;
  async function refreshMarkets(){
   try {
    const version=localStorage.getItem('floatsheets-contract-version-v1')==='legacy-orion'?'legacy-orion':'meadow';
    const payload = await api.getMarkets(version);
    if (!Array.isArray(payload.markets) || !payload.markets.length) return;
    const liveMarkets = payload.markets.map(function(row){
      const price = Number(row.twap_price_usdg ?? row.spot_price_usdg);
      const status = String(row.status || '').toLowerCase();
      const onchainState=Number(row.onchain_market_state);
      const tradable = row.oracle_tradable === true && status === 'active' && onchainState === 1 && Number.isFinite(price) && price > 0;
      return {symbol:String(row.symbol),name:String(row.symbol)+' equity',price:Number.isFinite(price)?price:0,change:0,
        band:Number(row.max_half_spread_bps || 0)/10000,max:Number(row.max_leverage || 1),cap:Number(row.max_ticket_usdg || 0),oi:0,
        state:status==='disabled'||onchainState===0?'HALTED':(tradable?'LIVE':'CLOSE_ONLY'),sector:'Equity',oracleTradable:tradable};
    }).filter(function(row){return row.price>0;});
    if (!liveMarkets.length) return;
    markets=liveMarkets;
    window.__FLOATSHEETS_LIVE_MARKETS__=true;
    const detailSymbol=location.pathname.match(/^\/dashboard\/([A-Za-z0-9.-]+)\/?$/)?.[1]?.toUpperCase();
    selected=markets.find(function(m){return m.symbol===detailSymbol})||markets[0];
    stale=!selected.oracleTradable; render();
    if (typeof toast === 'function') toast('Live Robinhood Chain market data loaded.');
   } catch (error) { console.error('FloatSheets live market load failed', error); }
  }
  window.__FLOATSHEETS_REFRESH_MARKETS__=refreshMarkets;
  window.addEventListener('floatsheets-contract-version-change',function(){void refreshMarkets();});
  await refreshMarkets();
})();
