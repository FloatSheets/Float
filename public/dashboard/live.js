// Read-only live market adapter. No credentials are included in this script.
(async function loadLiveMarkets(){
  const api = window.__FLOATSHEETS_SERVER_API__;
  if (!api) return;
  async function refreshMarkets(){
   try {
    const storedVersion=localStorage.getItem('floatsheets-contract-version-v1');
    const version=storedVersion==='jaguar'?'jaguar':storedVersion==='legacy-orion'?'legacy-orion':storedVersion==='silverlake'?'silverlake':storedVersion==='copper'?'copper':'goldlake';
    if(version==='goldlake'&&storedVersion!=='goldlake')localStorage.setItem('floatsheets-contract-version-v1','goldlake');
    let payload;
    try { payload = await api.getMarkets(version); }
    catch (error) {
      // Copper isn't deployed yet: fall back to large caps. Other errors keep the user on Copper.
      if (version === 'copper' && /unavailable for this contract version|not deployed|not configured|503/i.test(String(error && error.message || error))) {
        localStorage.setItem('floatsheets-contract-version-v1','goldlake');
        if (typeof toast === 'function') toast('Penny-stock markets are not live yet.');
        window.dispatchEvent(new CustomEvent('floatsheets-contract-version-change',{detail:{version:'goldlake'}}));
        return;
      }
      throw error;
    }
    if (!Array.isArray(payload.markets) || !payload.markets.length) return;
    const liveMarkets = payload.markets.map(function(row){
      const price = Number(row.twap_price_usdg ?? row.spot_price_usdg);
      const status = String(row.status || '').toLowerCase();
      const onchainState=Number(row.onchain_market_state);
      const tradable = row.oracle_tradable === true && status === 'active' && onchainState === 1 && Number.isFinite(price) && price > 0;
      const penny=row.listing_class==='penny';
      const capM=Number(row.market_cap_usd)/1e6;
      return {symbol:String(row.symbol),name:penny&&Number.isFinite(capM)&&capM>0?String(row.symbol)+' · $'+(capM>=1000?(capM/1000).toFixed(2)+'B':Math.round(capM)+'M')+' cap':String(row.symbol)+' equity',
        penny:penny,marketCapUsd:Number(row.market_cap_usd)||null,sourcesUsed:row.sources_used??null,frozenReason:row.frozen_reason??null,price:Number.isFinite(price)?price:0,twapPrice:Number(row.twap_price_usdg)||0,spotPrice:Number(row.spot_price_usdg)||0,change:0,
        band:Number(row.max_half_spread_bps || 0)/10000,max:Number(row.max_leverage || 1),cap:Number(row.max_ticket_usdg || 0),oi:0,
        state:status==='disabled'||onchainState===0?'HALTED':row.exchange_halt?'EXCHANGE_HALT':row.corporate_action&&row.corporate_action.close_only?'CORPORATE_ACTION':row.weekend_band&&row.weekend_band.pool_outside?'WEEKEND_BAND':(tradable?'LIVE':'CLOSE_ONLY'),sector:'Equity',oracleTradable:tradable&&!row.exchange_halt&&!(row.corporate_action&&row.corporate_action.close_only)&&!(row.weekend_band&&row.weekend_band.pool_outside),capacity:row.capacity||null,exchangeHalt:row.exchange_halt||null,weekendBand:row.weekend_band||null};
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
