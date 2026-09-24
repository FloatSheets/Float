// Live dashboard presentation layer. It removes design-time simulation state,
// decorates assets with the supplied icons, and exposes a persistent dark mode.
(function installLiveDashboardUi(){
  const root = document.getElementById('workspace');
  if (!root || typeof render !== 'function') return;
  const originalRender = render;
  const icon = {USDG:'/usdg_logo.png',ETH:'/eth.jpeg'};
  document.body.classList.toggle('dashboard-dark',localStorage.getItem('floatsheets-dashboard-theme')==='dark');

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

  const usdgDecimals=6;
  const activityStorageKey='floatsheets-wallet-activity-v1';
  const activityNotificationsKey='floatsheets-activity-notifications';
  const rawUsdG=function(value){
    const normalized=String(value).trim();
    if(!/^\d+(?:\.\d{0,6})?$/.test(normalized)) throw new Error('Enter a USDG amount with up to 6 decimal places.');
    const parts=normalized.split('.');
    return BigInt(parts[0]+(parts[1]||'').padEnd(usdgDecimals,'0'));
  };
  const displayUsdG=function(raw){ return (Number(raw)/1e6).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); };
  const walletState=function(){ return window.__FLOATSHEETS_WALLET_STATE__; };
  const walletApi=function(){ return window.__FLOATSHEETS_WALLET__; };
  const escapeMessage=function(value){ return String(value).replace(/[&<>"']/g,function(character){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]; }); };
  const showActionModal=function(title,message){ modal(title,'<p>'+escapeMessage(message)+'</p>'); };
  const activityNotificationsEnabled=function(){ return localStorage.getItem(activityNotificationsKey)!=='off'; };
  const activities=function(){ try { const stored=JSON.parse(localStorage.getItem(activityStorageKey)||'[]'); return Array.isArray(stored)?stored:[]; } catch { return []; } };
  const saveActivities=function(items){ localStorage.setItem(activityStorageKey,JSON.stringify(items.slice(0,60))); };
  const activityCopy=function(item){
    const market=item.market?' · '+item.market:'';
    return ({approval:'USDG approval confirmed',deposit:'Margin added',withdraw:'Margin withdrawn',trade:'Position opened',close:'Position closed',liquidation:'Position liquidated','vault-approve':'USDG approval confirmed','vault-deposit':'Liquidity added','vault-withdraw':'Liquidity withdrawn'})[item.action]||'Transaction confirmed'+market;
  };
  function recordActivity(action,detail){
    const item={action:action,market:detail?.market||'',hash:detail?.hash||'',time:new Date().toISOString()};
    saveActivities([item].concat(activities()));
    if(activityNotificationsEnabled()&&typeof toast==='function') toast(activityCopy(item)+(item.market?' · '+item.market:''));
  }
  function activityHtml(){
    const records=activities();
    if(!records.length) return '<p>No activity yet. Confirmed wallet actions will appear here.</p>';
    return records.slice(0,20).map(function(item){const hash=item.hash?'<small><a href="https://robinhoodchain.blockscout.com/tx/'+item.hash+'" target="_blank" rel="noreferrer">View transaction ↗</a> · '+new Date(item.time).toLocaleString()+'</small>':'<small>'+new Date(item.time).toLocaleString()+'</small>';return '<div class="activity-row"><strong>'+activityCopy(item)+(item.market?' · '+item.market:'')+'</strong>'+hash+'</div>';}).join('');
  }

  function installSidebarToggle(){
    const sidebar=document.querySelector('.dash-sidebar');
    if(!sidebar||document.getElementById('sidebar-toggle')) return;
    const toggle=document.createElement('button');
    toggle.id='sidebar-toggle'; toggle.type='button'; toggle.className='sidebar-toggle'; toggle.setAttribute('aria-label','Collapse sidebar');
    const setCollapsed=function(collapsed){ document.body.classList.toggle('dashboard-sidebar-collapsed',collapsed); toggle.textContent=collapsed?'›':'‹'; toggle.setAttribute('aria-label',collapsed?'Expand sidebar':'Collapse sidebar'); toggle.setAttribute('aria-expanded',String(!collapsed)); localStorage.setItem('floatsheets-sidebar-collapsed',collapsed?'true':'false'); };
    setCollapsed(localStorage.getItem('floatsheets-sidebar-collapsed')==='true');
    toggle.addEventListener('click',function(){setCollapsed(!document.body.classList.contains('dashboard-sidebar-collapsed'));});
    sidebar.append(toggle);
  }

  function installActivityFeed(){
    const activityButton=document.getElementById('activity-button');
    if(activityButton) activityButton.onclick=function(){ modal('Recent activity.','<div>'+activityHtml()+'</div>'); };
    const notifications=document.getElementById('notifications');
    if(notifications){
      notifications.checked=activityNotificationsEnabled();
      notifications.onchange=function(){localStorage.setItem(activityNotificationsKey,notifications.checked?'on':'off');};
    }
  }

  function tradeTicket(){
    const wallet=walletState();
    if(!wallet?.connected) return '<div class="live-only-panel"><h2>Ready to trade?</h2><p>Connect your wallet to use USDG as margin and open a position.</p><button class="primary-btn" id="connect-to-trade">Connect wallet</button></div>';
    return '<div class="live-only-panel live-trade-ticket"><h2>Open '+selected.symbol+' exposure</h2><div class="segmented"><button type="button" data-live-side="long" class="active">↗ Long</button><button type="button" data-live-side="short" class="short">↘ Short</button></div><div class="field"><label for="live-collateral">Margin to deposit</label><div class="input-wrap"><input id="live-collateral" inputmode="decimal" value="10" aria-label="USDG margin"><span>USDG</span></div></div><div class="field"><label for="live-leverage">Target leverage <b id="live-leverage-value">1×</b></label><input id="live-leverage" type="range" min="1" max="'+selected.max+'" value="1" step="1"><div class="leverage-row"><span>1×</span><span>'+selected.max+'× maximum</span></div></div><div class="order-summary" id="live-order-summary"></div><p class="order-disclosure">You will see the final price and fee before confirming. Prices refresh quickly.</p><button class="primary-btn" id="submit-live-trade" type="button">Open long position</button></div>';
  }

  function bindTradeTicket(){
    const ticket=root.querySelector('.live-trade-ticket');
    root.querySelector('#connect-to-trade')?.addEventListener('click',function(){ document.getElementById('account-button')?.click(); });
    if(!ticket) return;
    let isLong=true;
    const collateral=ticket.querySelector('#live-collateral');
    const leverage=ticket.querySelector('#live-leverage');
    const summary=ticket.querySelector('#live-order-summary');
    const submit=ticket.querySelector('#submit-live-trade');
    const update=function(){
      try {
        const margin=rawUsdG(collateral.value),lev=BigInt(leverage.value);
        // Reserve the six-bps execution fee before determining a notional that
        // satisfies the clearing house's initial-margin invariant.
        const notional=margin*lev*10000n/(10000n+lev*6n);
        ticket.querySelector('#live-leverage-value').textContent=leverage.value+'×';
        summary.innerHTML='<div><span>Margin</span><b>'+displayUsdG(margin)+' USDG</b></div><div><span>Position size</span><b>Up to '+displayUsdG(notional)+' USDG</b></div><div><span>Trading fee</span><b>0.06%</b></div>';
        submit.disabled=margin===0n;
      } catch { summary.innerHTML=''; submit.disabled=true; }
    };
    ticket.querySelectorAll('[data-live-side]').forEach(function(button){button.addEventListener('click',function(){isLong=button.dataset.liveSide==='long';ticket.querySelectorAll('[data-live-side]').forEach(function(item){item.classList.toggle('active',item===button);});submit.textContent='Open '+(isLong?'long':'short')+' position';});});
    collateral.addEventListener('input',update); leverage.addEventListener('input',update); update();
    submit.addEventListener('click',async function(){
      let marginDeposited=false;
      let marginAlreadyHeld=false;
      let margin=0n;
      try {
        const wallet=walletApi(); if(!wallet?.connected) throw new Error('Connect a Robinhood Chain wallet first.');
        margin=rawUsdG(collateral.value);
        const lev=BigInt(leverage.value);
        let notional=margin*lev*10000n/(10000n+lev*6n);
        if(margin===0n||notional===0n) throw new Error('Margin is too small for this leverage.');
        ticket.dataset.submitting='true'; submit.disabled=true;
        const existingPosition=await wallet.position(selected.symbol);
        const heldMargin=existingPosition&&BigInt(existingPosition.sizeE18)===0n?BigInt(existingPosition.marginUsdg):0n;
        if(heldMargin>0n){
          // A previous quote can fail after its separate margin transaction
          // confirms. Never ask the user to deposit that margin again.
          margin=heldMargin;
          notional=margin*lev*10000n/(10000n+lev*6n);
          marginAlreadyHeld=true;
          submit.textContent='Using available margin…';
        } else {
          const allowance=await wallet.allowance();
          if(allowance<margin){submit.textContent='Confirm USDG approval…';const approval=await wallet.buildTransaction('approve',{amountUsdg:margin.toString()});await wallet.send(approval.transaction);}
          submit.textContent='Confirm margin deposit…';const deposit=await wallet.buildTransaction('deposit',{market:selected.symbol,amountUsdg:margin.toString()});await wallet.send(deposit.transaction);marginDeposited=true;
        }
        submit.textContent='Requesting live quote…';const quote=await wallet.buildTransaction('trade-quote',{market:selected.symbol,isLong:isLong,notionalUsdg:notional.toString()});
        submit.textContent='Confirm trade…';const hash=await wallet.send(quote.transaction);
        delete ticket.dataset.submitting; render(); showActionModal('Position opened','Your '+selected.symbol+' position was confirmed on Robinhood Chain. Transaction: '+hash);
      } catch(reason) { delete ticket.dataset.submitting; submit.disabled=false; submit.textContent='Open '+(isLong?'long':'short')+' position'; const message=reason instanceof Error?reason.message:'Trade could not be submitted.'; if(marginDeposited||marginAlreadyHeld) void offerMarginRecovery(selected.symbol,margin,message); else showActionModal('Could not open position',message); }
    });
  }

  async function withdrawPendingMargin(symbol, amount){
    try {
      const wallet=walletApi();
      const transaction=await wallet.buildTransaction('withdraw',{market:symbol,amountUsdg:amount.toString()});
      const hash=await wallet.send(transaction.transaction);
      render();
      showActionModal('Margin withdrawn','Your '+displayUsdG(amount)+' USDG margin was returned to your wallet. Transaction: '+hash);
    } catch(reason) {
      showActionModal('Could not withdraw margin',reason instanceof Error?reason.message:'Your margin could not be withdrawn.');
    }
  }

  async function offerMarginRecovery(symbol, fallbackAmount, reason){
    try {
      const position=await walletApi().position(symbol);
      const amount=position && BigInt(position.sizeE18)===0n ? BigInt(position.marginUsdg) : 0n;
      if(amount===0n) { showActionModal('Could not open position',reason); return; }
      modal('Position not opened','<p>'+escapeMessage(reason)+'</p><p>Your '+displayUsdG(amount)+' USDG margin is safely held in the clearing account. You can withdraw it now.</p>','Withdraw margin',function(){ dialog.close(); void withdrawPendingMargin(symbol,amount); });
    } catch { showActionModal('Could not open position',reason); }
  }

  function installClosePosition(position){
    const ticket=root.querySelector('.live-trade-ticket');
    if(!ticket||!position||BigInt(position.sizeE18)===0n||ticket.querySelector('#close-live-position'))return;
    const button=document.createElement('button');
    button.id='close-live-position';button.type='button';button.className='secondary-btn';button.textContent='Close current position';
    button.addEventListener('click',async function(){
      try{
        const wallet=walletApi();if(!wallet?.connected)throw new Error('Connect a Robinhood Chain wallet first.');
        button.disabled=true;button.textContent='Getting closing price…';
        const quote=await wallet.buildTransaction('close-quote',{market:selected.symbol});
        button.textContent='Confirm close…';const hash=await wallet.send(quote.transaction);
        render();showActionModal('Position closed','Your '+selected.symbol+' position was confirmed closed on Robinhood Chain. Transaction: '+hash);
      }catch(reason){button.disabled=false;button.textContent='Close current position';showActionModal('Could not close position',reason instanceof Error?reason.message:'Position could not be closed.');}
    });
    ticket.append(button);
  }

  function installMarginRecovery(position){
    const ticket=root.querySelector('.live-trade-ticket');
    if(!ticket || !position || BigInt(position.sizeE18)!==0n || BigInt(position.marginUsdg)===0n || ticket.querySelector('#withdraw-live-margin')) return;
    const amount=BigInt(position.marginUsdg);
    const button=document.createElement('button');
    button.id='withdraw-live-margin';button.type='button';button.className='secondary-btn';button.textContent='Withdraw available margin';
    button.addEventListener('click',function(){modal('Withdraw available margin','<p>Withdraw '+displayUsdG(amount)+' USDG back to your wallet.</p>','Withdraw margin',function(){dialog.close();void withdrawPendingMargin(selected.symbol,amount);});});
    ticket.append(button);
  }

  let walletRequest = 0;
  async function renderWalletContext(){
    const wallet=walletState(), request=++walletRequest;
    if(!wallet?.connected) return;
    const details=location.pathname.match(/^\/dashboard\/([A-Za-z0-9.-]+)\/?$/)?.[1]?.toUpperCase();
    const balance=displayUsdG(rawUsdG(wallet.usdgBalance||'0'));
    if(details){
      const grid=root.querySelector('.metric-grid');
      if(grid) grid.innerHTML='<div class="metric featured"><small>Wallet USDG balance</small><strong>'+balance+'</strong><div class="metric-note"><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span> · available to use</div></div><div class="metric"><small>Margin in this market</small><strong id="wallet-market-margin">…</strong><div class="metric-note">'+details+' only</div></div><div class="metric"><small>Your position</small><strong id="wallet-market-size">…</strong><div class="metric-note">current size</div></div><div class="metric"><small>Settlement</small><strong>USDG</strong><div class="metric-note">Robinhood Chain</div></div>';
      try { const position=await walletApi().position(details); if(request!==walletRequest||!position)return; const margin=root.querySelector('#wallet-market-margin'),size=root.querySelector('#wallet-market-size'); if(margin)margin.textContent=displayUsdG(BigInt(position.marginUsdg)); if(size)size.textContent=(Number(BigInt(position.sizeE18))/1e18).toLocaleString(undefined,{maximumFractionDigits:4}); installClosePosition(position); installMarginRecovery(position); } catch(error) { console.warn('FloatSheets position read failed',error); }
    }
    if(location.hash.slice(1)==='portfolio'){
      const target=root.querySelector('#wallet-portfolio'); if(!target)return;
      target.innerHTML='<p>Loading your positions.</p>';
      try { const positions=(await Promise.all(markets.map(async function(m){return {market:m,position:await walletApi().position(m.symbol)};}))).filter(function(item){return item.position&&BigInt(item.position.sizeE18)!==0n;}); if(request!==walletRequest)return; target.innerHTML='<div class="metric-grid"><div class="metric featured"><small>Wallet USDG balance</small><strong>'+balance+'</strong><div class="metric-note"><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span> · wallet balance</div></div><div class="metric"><small>Open on-chain positions</small><strong>'+positions.length+'</strong><div class="metric-note">across configured markets</div></div></div>'+(positions.length?'<div class="table-scroll"><table><thead><tr><th>Market</th><th>Direction</th><th>Base size</th><th>Entry price</th><th>Margin</th></tr></thead><tbody>'+positions.map(function(item){const p=item.position;return '<tr><td>'+item.market.symbol+'</td><td class="'+(BigInt(p.sizeE18)>0n?'positive':'negative')+'">'+(BigInt(p.sizeE18)>0n?'Long':'Short')+'</td><td>'+Math.abs(Number(BigInt(p.sizeE18))/1e18).toLocaleString(undefined,{maximumFractionDigits:4})+'</td><td>$'+(Number(BigInt(p.entryPriceE18))/1e18).toLocaleString(undefined,{maximumFractionDigits:4})+'</td><td>'+displayUsdG(BigInt(p.marginUsdg))+' USDG</td></tr>';}).join('')+'</tbody></table></div>':'<div class="empty-state"><h3>No on-chain positions</h3><p>Your connected wallet has no open FloatSheets positions in configured markets.</p></div>'); } catch(error) { target.innerHTML=''; showActionModal('Portfolio unavailable',error instanceof Error?error.message:'Your positions could not be loaded.'); }
    }
    const tradePositionsTarget=root.querySelector('#wallet-trade-positions');
    if(details&&tradePositionsTarget){
      tradePositionsTarget.innerHTML='<div class="panel-head"><h2>Open position</h2></div><div class="panel-body"><p>Loading your '+details+' position.</p></div>';
      try {
        const position=await walletApi().position(details);
        if(request!==walletRequest||!position)return;
        const size=BigInt(position.sizeE18),margin=BigInt(position.marginUsdg);
        tradePositionsTarget.innerHTML='<div class="panel-head"><h2>Open position</h2></div>'+(size!==0n?'<div class="table-scroll"><table><thead><tr><th>Market</th><th>Direction</th><th>Base size</th><th>Entry price</th><th>Margin</th></tr></thead><tbody><tr><td>'+details+'</td><td class="'+(size>0n?'positive':'negative')+'">'+(size>0n?'Long':'Short')+'</td><td>'+Math.abs(Number(size)/1e18).toLocaleString(undefined,{maximumFractionDigits:4})+'</td><td>$'+(Number(BigInt(position.entryPriceE18))/1e18).toLocaleString(undefined,{maximumFractionDigits:4})+'</td><td>'+displayUsdG(margin)+' USDG</td></tr></tbody></table></div>':'<div class="empty-state"><h3>No open '+details+' position</h3><p>Open a position to see it here.</p></div>');
      } catch(error) { tradePositionsTarget.innerHTML=''; console.warn('FloatSheets trade position read failed',error); }
    }
  }

  function vaultPanel(){
    const wallet=walletState();
    if(!wallet?.connected) return '<section class="panel live-only-panel"><h2>Provide liquidity</h2><p>Connect your wallet to deposit USDG and receive vault shares.</p><button class="primary-btn" id="connect-to-vault" type="button">Connect wallet</button></section>';
    return '<section class="panel live-only-panel" id="live-vault-panel"><h2>Provide liquidity</h2><p>Your USDG helps back all FloatSheets markets. Your vault share value changes as traders profit or lose.</p><div id="live-vault-data"><p>Loading vault balances.</p></div></section>';
  }

  async function renderVaultContext(){
    const target=root.querySelector('#live-vault-data');
    root.querySelector('#connect-to-vault')?.addEventListener('click',function(){document.getElementById('account-button')?.click();});
    if(!target||!walletState()?.connected) return;
    try {
      const wallet=walletApi(),vault=await wallet?.vault();if(!vault)return;
      const assets=BigInt(vault.assets),shares=BigInt(vault.shares),totalShares=BigInt(vault.totalShares),available=BigInt(vault.availableLiquidity);
      const ownership=totalShares===0n?'0.00':(Number(shares)*100/Number(totalShares)).toFixed(2);
      const shareValue=shares*(assets+1n)/(totalShares+1000000n);
      target.innerHTML='<div class="metric-grid"><div class="metric featured"><small>Vault assets</small><strong>'+displayUsdG(assets)+'</strong><div class="metric-note"><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span> · shared liquidity</div></div><div class="metric"><small>Your vault value</small><strong>'+displayUsdG(shareValue)+'</strong><div class="metric-note"><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span> · '+ownership+'% of vault</div></div><div class="metric"><small>Available liquidity</small><strong>'+displayUsdG(available)+'</strong><div class="metric-note">USDG available for markets</div></div></div><div class="field"><label for="live-vault-deposit">USDG to deposit</label><div class="input-wrap"><input id="live-vault-deposit" inputmode="decimal" value="10" aria-label="USDG to deposit"><span>USDG</span></div></div><button class="primary-btn" id="submit-vault-deposit" type="button">Add liquidity</button>'+(shares>0n?'<button class="secondary-btn" id="submit-vault-withdraw" type="button">Withdraw all liquidity</button>':'');
      const input=target.querySelector('#live-vault-deposit'),deposit=target.querySelector('#submit-vault-deposit'),withdraw=target.querySelector('#submit-vault-withdraw');
      deposit?.addEventListener('click',async function(){try{const amount=rawUsdG(input.value);if(amount===0n)throw new Error('Enter a USDG amount greater than zero.');deposit.disabled=true;const allowance=await wallet.vaultAllowance();if(allowance<amount){deposit.textContent='Confirm USDG approval…';const approval=await wallet.buildTransaction('vault-approve',{amountUsdg:amount.toString()});await wallet.send(approval.transaction);}deposit.textContent='Confirm deposit…';const tx=await wallet.buildTransaction('vault-deposit',{amountUsdg:amount.toString()});const hash=await wallet.send(tx.transaction);render();showActionModal('Liquidity added','Your USDG was added to the vault on Robinhood Chain. Transaction: '+hash);}catch(reason){deposit.disabled=false;deposit.textContent='Add liquidity';showActionModal('Could not add liquidity',reason instanceof Error?reason.message:'Liquidity could not be added.');}});
      withdraw?.addEventListener('click',async function(){try{withdraw.disabled=true;withdraw.textContent='Confirm withdrawal…';const tx=await wallet.buildTransaction('vault-withdraw',{shares:shares.toString()});const hash=await wallet.send(tx.transaction);render();showActionModal('Liquidity withdrawn','Your vault withdrawal was confirmed on Robinhood Chain. Transaction: '+hash);}catch(reason){withdraw.disabled=false;withdraw.textContent='Withdraw all liquidity';showActionModal('Could not withdraw liquidity',reason instanceof Error?reason.message:'Liquidity could not be withdrawn.');}});
    } catch(error) { target.innerHTML=''; showActionModal('Vault unavailable',error instanceof Error?error.message:'Vault data could not be loaded.'); }
  }

  function removeSimulationControls(){
    const order=root.querySelector('.order-panel');
    if(order) order.innerHTML=tradeTicket();
    root.querySelectorAll('#vault-deposit,#vault-withdraw,#add-funds,#withdraw-funds,#process-orders,#reset-workspace').forEach(function(control){control.remove();});
    root.querySelectorAll('.info-note').forEach(function(note){
      note.textContent=note.textContent.replace(/These are illustrative oracle states\.[^.]*/, 'Market prices are updated regularly.').replace(/No APY is promised\.[^.]*/, 'Vault actions require your wallet confirmation.');
    });
    root.querySelectorAll('p,span,small').forEach(function(el){
      el.textContent=el.textContent.replace(/fictional markets/gi,'live markets').replace(/virtual (account )?balance/gi,'wallet collateral').replace(/Illustrative equity market/gi,'Robinhood Chain market').replace(/24h change · sample/gi,'24h change · live feed');
    });
  }

  function genuinePageContent(){
    const view=location.hash.slice(1)||'trade';
    const detailSymbol=location.pathname.match(/^\/dashboard\/([A-Za-z0-9.-]+)\/?$/)?.[1]?.toUpperCase();
    if(!detailSymbol && view==='trade') {
      root.innerHTML='<div class="page-heading"><div><h1>Markets.</h1><p>Trade stock price moves with USDG on Robinhood Chain.</p></div></div><section class="panel markets-panel"><div class="panel-head"><h2>Available markets</h2><span class="pill">LIVE DATA</span></div><div class="table-scroll"><table><thead><tr><th>Market</th><th>Price</th><th>Price range</th><th>Leverage</th><th>Status</th></tr></thead><tbody>'+markets.map(function(m){return '<tr class="market-link-row" tabindex="0" data-market-href="/dashboard/'+encodeURIComponent(m.symbol)+'/" role="link"><td><a class="market-link" href="/dashboard/'+encodeURIComponent(m.symbol)+'/">'+m.symbol+'</a></td><td>$'+money(m.price)+'</td><td>±'+money(m.band*100)+'%</td><td>'+m.max+'×</td><td>'+stateBadge(m.state)+'</td></tr>';}).join('')+'</tbody></table></div></section>';
      root.querySelectorAll('[data-market-href]').forEach(function(row){row.addEventListener('click',function(event){if(event.target.closest('a'))return;location.href=row.getAttribute('data-market-href');});row.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();location.href=row.getAttribute('data-market-href');}});});
      return;
    }
    if(detailSymbol && view==='trade') {
      selected=markets.find(function(m){return m.symbol===detailSymbol})||selected;
      const back=document.createElement('a'); back.className='market-back'; back.href='/dashboard/'; back.textContent='← All markets'; root.prepend(back);
      root.querySelector('.markets-panel')?.remove();
      Array.from(root.querySelectorAll('.markets-panel')).find(function(panel){return panel.querySelector('h2')?.textContent?.trim().startsWith('Open positions');})?.setAttribute('id','wallet-trade-positions');
    }
    if(view==='portfolio') root.innerHTML='<div class="page-heading"><div><h1>Portfolio.</h1><p>Your positions and available USDG.</p></div></div><section class="panel live-only-panel"><h2>'+ (walletState()?.connected?'Your portfolio':'Connect your wallet') +'</h2><div id="wallet-portfolio"><p>'+ (walletState()?.connected?'Loading your positions.':'Connect on Robinhood Chain to see your USDG and positions.') +'</p></div></section>';
    if(view==='oracle') root.innerHTML='<div class="page-heading"><div><h1>Prices &amp; risk.</h1><p>See current prices and whether each market is open for trading.</p></div></div><section class="panel markets-panel"><div class="panel-head"><h2>Market status</h2><span class="pill">LIVE DATA</span></div><div class="table-scroll"><table><thead><tr><th>Market</th><th>Price</th><th>Price range</th><th>Leverage</th><th>Status</th></tr></thead><tbody>'+markets.map(function(m){return '<tr><td>'+m.symbol+'</td><td>$'+money(m.price)+'</td><td>±'+money(m.band*100)+'%</td><td>'+m.max+'×</td><td>'+stateBadge(m.state)+'</td></tr>';}).join('')+'</tbody></table></div></section>';
    if(view==='vault') root.innerHTML='<div class="page-heading"><div><h1>Liquidity vault.</h1><p>Provide USDG liquidity for FloatSheets markets.</p></div></div>'+vaultPanel();
    if(view==='listings') root.innerHTML='<div class="page-heading"><div><h1>Market listings.</h1><p>Available markets on Robinhood Chain.</p></div></div><section class="panel markets-panel"><div class="table-scroll"><table><thead><tr><th>Market</th><th>Settlement</th><th>Price</th><th>Status</th></tr></thead><tbody>'+markets.map(function(m){return '<tr><td>'+m.symbol+'</td><td><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span></td><td>$'+money(m.price)+'</td><td>'+stateBadge(m.state)+'</td></tr>';}).join('')+'</tbody></table></div></section>';
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
  function scheduleChartRefresh(){
    clearInterval(window.__FLOATSHEETS_CHART_REFRESH_TIMER__);
    const onMarketPage=Boolean(location.pathname.match(/^\/dashboard\/[A-Za-z0-9.-]+\/?$/));
    if(onMarketPage) window.__FLOATSHEETS_CHART_REFRESH_TIMER__=setInterval(function(){ drawChart(); },30_000);
  }
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
    if(!window.__FLOATSHEETS_LIVE_MARKETS__){ root.innerHTML='<section class="panel live-only-panel"><h2>Loading markets</h2><p>Getting the latest prices and market status.</p></section>'; return; }
    // Set the selected live market before the legacy renderer creates its
    // chart and trade panel. This avoids briefly building a transaction for
    // whichever market happened to be first in the list.
    const requestedSymbol=location.pathname.match(/^\/dashboard\/([A-Za-z0-9.-]+)\/?$/)?.[1]?.toUpperCase();
    if(requestedSymbol) selected=markets.find(function(m){return m.symbol===requestedSymbol})||selected;
    originalRender();
    removeSimulationControls();
    genuinePageContent();
    decorateAssets();
    normalizeMetricNotes();
    const chartLegend=root.querySelector('.chart-legend');
    if(chartLegend) chartLegend.textContent='Price history · USDG';
    installThemeToggle();
    installSidebarToggle();
    installActivityFeed();
    window.__FLOATSHEETS_INSTALL_WALLET__?.();
    bindTradeTicket();
    void renderWalletContext();
    void renderVaultContext();
    scheduleChartRefresh();
  };
  // Discard any local design-time account state before the first live render.
  state={balance:0,positions:[],orders:[],activity:[],nominations:[],vault:0,staked:0,float:0,preferences:{notifications:true,reduced:false},name:'Trading account'};
  save=function(){};
  render();
  // Dashboard scripts are re-mounted by the SPA. Replace the prior listener
  // rather than retaining stale roots, and do not disrupt a wallet approval
  // sequence while its transaction prompts are in progress.
  if(window.__FLOATSHEETS_DASHBOARD_WALLET_LISTENER__) window.removeEventListener('floatsheets-wallet-state',window.__FLOATSHEETS_DASHBOARD_WALLET_LISTENER__);
  window.__FLOATSHEETS_DASHBOARD_WALLET_LISTENER__=function(){if(!root.querySelector('.live-trade-ticket[data-submitting="true"]'))render();};
  window.addEventListener('floatsheets-wallet-state',window.__FLOATSHEETS_DASHBOARD_WALLET_LISTENER__);
  if(window.__FLOATSHEETS_TRANSACTION_LISTENER__) window.removeEventListener('floatsheets-transaction-confirmed',window.__FLOATSHEETS_TRANSACTION_LISTENER__);
  window.__FLOATSHEETS_TRANSACTION_LISTENER__=function(event){const detail=event.detail||{};if(detail.action&&detail.action!=='trade-quote')recordActivity(detail.action,detail);setTimeout(function(){if(!root.querySelector('.live-trade-ticket[data-submitting="true"]'))render();},0);};
  window.addEventListener('floatsheets-transaction-confirmed',window.__FLOATSHEETS_TRANSACTION_LISTENER__);
})();
