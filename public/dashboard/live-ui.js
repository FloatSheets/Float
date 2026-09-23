// Live dashboard presentation layer. It removes design-time simulation state,
// decorates assets with the supplied icons, and exposes a persistent dark mode.
(function installLiveDashboardUi(){
  const root = document.getElementById('workspace');
  if (!root || typeof render !== 'function') return;
  const originalRender = render;
  const icon = {USDG:'/usdg_logo.png',ETH:'/eth.jpeg'};

  function decorateAssets(){
    root.querySelectorAll('.ticker-icon').forEach(function(el){
      el.textContent='';
      const image=document.createElement('img'); image.src='/rh-icon.png'; image.alt='Robinhood Chain market'; el.append(image);
    });
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    const nodes=[]; let node;
    while((node=walker.nextNode())) if(/\b(?:USDG|ETH)\b/.test(node.nodeValue||'')) nodes.push(node);
    nodes.forEach(function(textNode){
      // A previous pass may already have turned this unit into an asset reference.
      // Do not nest a second USDG logo/text pair inside it.
      if(textNode.parentElement?.closest('.asset-ref')) return;
      const fragment=document.createDocumentFragment();
      String(textNode.nodeValue).split(/(USDG|ETH)/g).forEach(function(part){
        if(!icon[part]) { fragment.append(document.createTextNode(part)); return; }
        const wrap=document.createElement('span'); wrap.className='asset-ref';
        const image=document.createElement('img'); image.src=icon[part]; image.alt=part; wrap.append(image,document.createTextNode(part)); fragment.append(wrap);
      });
      textNode.parentNode?.replaceChild(fragment,textNode);
    });
  }

  function normalizeMetricNotes(){
    root.querySelectorAll('.metric').forEach(function(metric){
      const label=metric.querySelector(':scope > small')?.textContent?.trim();
      const value=metric.querySelector(':scope > strong');
      const note=metric.querySelector(':scope > span');
      if(!value || !note || !['Available collateral','Portfolio equity','Unrealized PnL'].includes(label||'')) return;
      // The old static template put USDG in a nested <small> in the value,
      // then decorated it again on every render. Keep one semantic unit line.
      value.querySelector('small')?.remove();
      const copy=label==='Available collateral' ? 'wallet collateral' : label==='Portfolio equity' ? 'including unrealized PnL' : 'mark prices';
      note.className='metric-note';
      note.replaceChildren();
      const unit=document.createElement('span'); unit.className='asset-ref';
      const image=document.createElement('img'); image.src='/usdg_logo.png'; image.alt='USDG';
      unit.append(image,document.createTextNode('USDG'));
      note.append(unit,document.createTextNode(' · '+copy));
    });
  }

  function removeSimulationControls(){
    const order=root.querySelector('.order-panel');
    if(order) order.innerHTML='<div class="live-only-panel"><h2>Trading is wallet-backed</h2><p>Connect a wallet above to review live on-chain collateral and signed execution. No local balances or simulated orders are used.</p><a class="secondary-btn" href="/research/risk/">Read execution risk ↗</a></div>';
    root.querySelectorAll('#vault-deposit,#vault-withdraw,#add-funds,#withdraw-funds,#process-orders,#reset-workspace').forEach(function(control){control.remove();});
    root.querySelectorAll('.info-note').forEach(function(note){
      note.textContent=note.textContent.replace(/These are illustrative oracle states\.[^.]*/, 'Oracle state is read from the deployed backend and Robinhood Chain.').replace(/No APY is promised\.[^.]*/, 'Vault actions require a wallet transaction and are not simulated here.');
    });
    root.querySelectorAll('p,span,small').forEach(function(el){
      el.textContent=el.textContent.replace(/fictional markets/gi,'live markets').replace(/virtual (account )?balance/gi,'wallet collateral').replace(/Illustrative equity market/gi,'Robinhood Chain market').replace(/24h change · sample/gi,'24h change · live feed');
    });
  }

  function genuinePageContent(){
    const view=location.hash.slice(1)||'trade';
    const detailSymbol=location.pathname.match(/^\/dashboard\/([A-Za-z0-9.-]+)\/?$/)?.[1]?.toUpperCase();
    if(!detailSymbol && view==='trade') {
      root.innerHTML='<div class="page-heading"><div><h1>Markets.</h1><p>Live synthetic equity markets settled in USDG on Robinhood Chain.</p></div></div><section class="panel markets-panel"><div class="panel-head"><h2>Configured markets</h2><span class="pill">LIVE DATA</span></div><div class="table-scroll"><table><thead><tr><th>Market</th><th>Price</th><th>Spread band</th><th>Leverage</th><th>State</th></tr></thead><tbody>'+markets.map(function(m){return '<tr class="market-link-row" tabindex="0" data-market-href="/dashboard/'+encodeURIComponent(m.symbol)+'/" role="link"><td><a class="market-link" href="/dashboard/'+encodeURIComponent(m.symbol)+'/">'+m.symbol+'</a></td><td>$'+money(m.price)+'</td><td>±'+money(m.band*100)+'%</td><td>'+m.max+'×</td><td>'+stateBadge(m.state)+'</td></tr>';}).join('')+'</tbody></table></div></section>';
      root.querySelectorAll('[data-market-href]').forEach(function(row){row.addEventListener('click',function(event){if(event.target.closest('a'))return;location.href=row.getAttribute('data-market-href');});row.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();location.href=row.getAttribute('data-market-href');}});});
      return;
    }
    if(detailSymbol && view==='trade') {
      selected=markets.find(function(m){return m.symbol===detailSymbol})||selected;
      const back=document.createElement('a'); back.className='market-back'; back.href='/dashboard/'; back.textContent='← All markets'; root.prepend(back);
      root.querySelector('.markets-panel')?.remove();
    }
    if(view==='portfolio') root.innerHTML='<div class="page-heading"><div><h1>Portfolio.</h1><p>On-chain positions and collateral for the connected wallet.</p></div></div><section class="panel live-only-panel"><h2>Connect a wallet to load portfolio</h2><p>FloatSheets does not create browser-local balances or positions. Connect on Robinhood Chain to read the wallet-backed account.</p></section>';
    if(view==='oracle') root.innerHTML='<div class="page-heading"><div><h1>Oracle &amp; risk.</h1><p>Live market snapshots and execution eligibility from the deployed backend.</p></div></div><section class="panel markets-panel"><div class="panel-head"><h2>Robinhood Chain market state</h2><span class="pill">LIVE DATA</span></div><div class="table-scroll"><table><thead><tr><th>Market</th><th>Midpoint</th><th>Spread band</th><th>Leverage</th><th>State</th></tr></thead><tbody>'+markets.map(function(m){return '<tr><td>'+m.symbol+'</td><td>$'+money(m.price)+'</td><td>±'+money(m.band*100)+'%</td><td>'+m.max+'×</td><td>'+stateBadge(m.state)+'</td></tr>';}).join('')+'</tbody></table></div></section>';
    if(view==='vault') root.innerHTML='<div class="page-heading"><div><h1>Liquidity vault.</h1><p>USDG liquidity is settled by the deployed FloatVault contract.</p></div></div><section class="panel live-only-panel"><h2>Wallet-backed vault actions</h2><p>Deposits and withdrawals require a connected wallet and signed USDG transactions. No local vault balances or simulated APY are shown.</p><a class="secondary-btn" href="/research/vault/">Read vault mechanics ↗</a></section>';
    if(view==='listings') root.innerHTML='<div class="page-heading"><div><h1>Market listings.</h1><p>Markets configured on Robinhood Chain and monitored by the live backend.</p></div></div><section class="panel markets-panel"><div class="table-scroll"><table><thead><tr><th>Market</th><th>Settlement</th><th>Price</th><th>State</th></tr></thead><tbody>'+markets.map(function(m){return '<tr><td>'+m.symbol+'</td><td><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span></td><td>$'+money(m.price)+'</td><td>'+stateBadge(m.state)+'</td></tr>';}).join('')+'</tbody></table></div></section>';
    if(view==='settings') root.querySelectorAll('.panel').forEach(function(panel){if(!panel.querySelector('#preferences-form')) panel.remove();});
  }

  function installThemeToggle(){
    const settingsPanel=root.querySelector('#preferences-form .panel-body') || root.querySelector('#preferences-form')?.parentElement;
    if(!settingsPanel || document.getElementById('dashboard-dark-mode')) return;
    const row=document.createElement('div'); row.className='list-row dashboard-theme-row';
    row.innerHTML='<div><strong>Dark dashboard</strong><p>Use a lower-light workspace palette.</p></div><input type="checkbox" class="setting-toggle" id="dashboard-dark-mode" aria-label="Dark dashboard">';
    settingsPanel.append(row);
    const toggle=row.querySelector('input');
    toggle.checked=localStorage.getItem('floatsheets-dashboard-theme')==='dark';
    document.body.classList.toggle('dashboard-dark',toggle.checked);
    toggle.addEventListener('change',function(){document.body.classList.toggle('dashboard-dark',toggle.checked);localStorage.setItem('floatsheets-dashboard-theme',toggle.checked?'dark':'light');});
  }

  let chartRequest = 0;
  drawChart = async function drawLiveChart(){
    const canvas=document.getElementById('price-chart');
    if(!canvas) return;
    const requestId=++chartRequest;
    const api=window.__FLOATSHEETS_API_URL__;
    if(!api) return;
    try {
      const response=await fetch(api.replace(/\/$/,'')+'/v1/markets/'+encodeURIComponent(selected.symbol)+'/history?range='+encodeURIComponent(timeframe),{headers:{accept:'application/json'}});
      if(!response.ok) throw new Error('history unavailable');
      const payload=await response.json();
      if(requestId!==chartRequest||!Array.isArray(payload.points)||!payload.points.length) return;
      const points=payload.points.map(function(point){return {time:new Date(point.observed_at),price:Number(point.twap_price_usdg ?? point.spot_price_usdg),deviation:Number(point.spot_twap_deviation_bps||0)/10000};}).filter(function(point){return Number.isFinite(point.price)&&point.price>0&&!Number.isNaN(point.time.getTime());});
      if(!points.length) return;
      // Candles are calculated only from persisted oracle snapshots. They are
      // not market-data placeholders: each open/high/low/close is a recorded
      // USDG midpoint within the selected time bucket.
      const bucketMs={"1H":5*60e3,"4H":15*60e3,"1D":60*60e3,"1W":6*60*60e3,"1M":24*60*60e3}[timeframe]||60*60e3;
      const candles=[];
      points.forEach(function(point){
        const bucket=Math.floor(point.time.getTime()/bucketMs)*bucketMs;
        const candle=candles[candles.length-1];
        if(!candle||candle.bucket!==bucket) candles.push({bucket:bucket,time:point.time,open:point.price,high:point.price,low:point.price,close:point.price,deviation:point.deviation});
        else { candle.high=Math.max(candle.high,point.price); candle.low=Math.min(candle.low,point.price); candle.close=point.price; candle.deviation=Math.max(candle.deviation,point.deviation); }
      });
      const box=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1,w=box.width,h=box.height,left=12,right=56,top=25,bottom=35;
      const ctx=canvas.getContext('2d'); if(!ctx) return; canvas.width=w*dpr; canvas.height=h*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
      const prices=candles.flatMap(function(candle){return [candle.high,candle.low];}),min=Math.min.apply(null,prices),max=Math.max.apply(null,prices),pad=Math.max((max-min)*.12,max*.0005),lo=min-pad,hi=max+pad;
      const X=function(i){return left+(i/Math.max(1,candles.length-1))*(w-left-right);},Y=function(price){return top+(hi-price)/(hi-lo)*(h-top-bottom);};
      ctx.clearRect(0,0,w,h);ctx.font='10px Arial';ctx.textAlign='left';
      for(let i=0;i<5;i++){const y=top+i*(h-top-bottom)/4;ctx.strokeStyle=document.body.classList.contains('dashboard-dark')?'#273754':'#edf1f7';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(w-right,y);ctx.stroke();ctx.fillStyle=document.body.classList.contains('dashboard-dark')?'#9aacd0':'#8d9ab2';ctx.fillText((hi-i*(hi-lo)/4).toFixed(2),w-right+10,y+4);}
      const slot=(w-left-right)/Math.max(1,candles.length),body=Math.max(2,Math.min(14,slot*.58));
      candles.forEach(function(candle,i){const x=X(i),up=candle.close>=candle.open,color=up?'#1f9d70':'#db5b66',high=Y(candle.high),low=Y(candle.low),open=Y(candle.open),close=Y(candle.close);ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,high);ctx.lineTo(x,low);ctx.stroke();ctx.fillStyle=color;ctx.fillRect(x-body/2,Math.min(open,close),body,Math.max(1,Math.abs(close-open)));});
      ctx.fillStyle=document.body.classList.contains('dashboard-dark')?'#9aacd0':'#8d9ab2';for(let i=0;i<5;i++){const candle=candles[Math.min(candles.length-1,Math.round(i*(candles.length-1)/4))];ctx.fillText(candle.time.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),X(Math.min(candles.length-1,Math.round(i*(candles.length-1)/4))),h-10);}
      canvas.onmousemove=function(event){const rect=canvas.getBoundingClientRect(),index=Math.max(0,Math.min(candles.length-1,Math.round((event.clientX-rect.left-left)/(w-left-right)*(candles.length-1)))),candle=candles[index],tip=document.querySelector('.chart-tooltip');if(!tip)return;tip.style.display='block';tip.style.left=Math.min(w-190,Math.max(0,event.clientX-rect.left+10))+'px';tip.textContent=candle.time.toLocaleString()+' · O $'+money(candle.open,4)+' H $'+money(candle.high,4)+' L $'+money(candle.low,4)+' C $'+money(candle.close,4);};canvas.onmouseleave=function(){const tip=document.querySelector('.chart-tooltip');if(tip)tip.style.display='none';};
    } catch(error) { console.warn('FloatSheets historical chart unavailable',error); }
  };

  render=function(){
    if(!window.__FLOATSHEETS_LIVE_MARKETS__){ root.innerHTML='<section class="panel live-only-panel"><h2>Loading live markets</h2><p>Reading configured markets and snapshots from the FloatSheets backend.</p></section>'; return; }
    originalRender();
    removeSimulationControls();
    genuinePageContent();
    decorateAssets();
    normalizeMetricNotes();
    const chartLegend=root.querySelector('.chart-legend');
    if(chartLegend) chartLegend.textContent='Recorded oracle OHLC · USDG';
    installThemeToggle();
    window.__FLOATSHEETS_INSTALL_WALLET__?.();
  };
  // Discard any local design-time account state before the first live render.
  state={balance:0,positions:[],orders:[],activity:[],nominations:[],vault:0,staked:0,float:0,preferences:{notifications:true,reduced:false},name:'Trading account'};
  save=function(){};
  render();
})();
