// Live dashboard presentation layer. It removes design-time simulation state,
// decorates assets with the supplied icons, and exposes a persistent dark mode.
(function installLiveDashboardUi(){
  const root = document.getElementById('workspace');
  if (!root || typeof render !== 'function') return;
  const originalRender = render;
  const icon = {USDG:'/usdg_logo.png',ETH:'/eth.jpeg'};
  function selectedContractVersion(){
    const selected=localStorage.getItem('floatsheets-contract-version-v1');
    if(selected==='legacy-orion') return 'legacy-orion';
    if(selected==='goldlake') return 'goldlake';
    if(selected==='silverlake') return 'silverlake';
    localStorage.setItem('floatsheets-contract-version-v1','goldlake');
    return 'goldlake';
  }
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
      if(textNode.parentElement?.closest('.asset-ref,.token-amount-shell')) return;
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
  function tokenAmountInput(id,label){
    return '<div class="field token-amount-field"><label for="'+id+'">'+label+'</label><div class="token-amount-shell"><div class="token-amount-token"><img src="/usdg_logo.png" alt="">USDG</div><div class="token-amount-value"><span aria-hidden="true">$</span><input id="'+id+'" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="'+label+' in USDG" aria-describedby="'+id+'-equivalent"></div><div class="token-amount-equivalent" id="'+id+'-equivalent">0.00 USDG</div></div></div>';
  }
  function paintTokenAmount(input){
    const output=input?.closest('.token-amount-shell')?.querySelector('.token-amount-equivalent');
    if(!output)return;
    try { output.textContent=displayUsdG(rawUsdG(input.value))+' USDG'; } catch { output.textContent='0.00 USDG'; }
  }
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
    return records.slice(0,20).map(function(item){const timestamp='<time datetime="'+item.time+'">'+new Date(item.time).toLocaleString()+'</time>',link=item.hash?'<a href="https://robinhoodchain.blockscout.com/tx/'+item.hash+'" target="_blank" rel="noreferrer">View transaction ↗</a>':'';return '<div class="activity-row"><strong>'+activityCopy(item)+(item.market?' · '+item.market:'')+'</strong><div class="activity-meta">'+link+timestamp+'</div></div>';}).join('');
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

  function installMobileWorkspaceMenu(){
    if(document.getElementById('mobile-workspace-menu-trigger')) return;
    const trigger=document.createElement('button');
    trigger.id='mobile-workspace-menu-trigger';
    trigger.type='button';
    trigger.className='mobile-workspace-menu-trigger';
    trigger.setAttribute('aria-label','Open workspace menu');
    trigger.setAttribute('aria-expanded','false');
    trigger.innerHTML='<span aria-hidden="true">☰</span>';

    const menu=document.createElement('div');
    menu.id='mobile-workspace-menu';
    menu.className='mobile-workspace-menu';
    menu.setAttribute('aria-hidden','true');
    menu.innerHTML='<button type="button" class="mobile-workspace-backdrop" aria-label="Close workspace menu"></button><section class="mobile-workspace-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-workspace-menu-title"><div class="mobile-workspace-sheet-head"><span id="mobile-workspace-menu-title">WORKSPACE</span><button type="button" class="mobile-workspace-close" aria-label="Close workspace menu">×</button></div><nav aria-label="Workspace navigation"><a href="#trade">↗ <span>Trade</span></a><a href="#portfolio">▦ <span>Portfolio</span></a><a href="#oracle">◎ <span>Oracle &amp; Risk</span></a><a href="#vault">◈ <span>LP</span></a><a href="#listings">⊞ <span>Market listings</span></a><a href="#settings">⚙ <span>Settings</span></a></nav></section>';
    document.body.append(menu,trigger);

    const close=function(){
      menu.classList.remove('is-open');
      menu.setAttribute('aria-hidden','true');
      trigger.setAttribute('aria-expanded','false');
      trigger.setAttribute('aria-label','Open workspace menu');
      trigger.innerHTML='<span aria-hidden="true">☰</span>';
      document.body.classList.remove('mobile-workspace-menu-open');
    };
    const open=function(){
      menu.classList.add('is-open');
      menu.setAttribute('aria-hidden','false');
      trigger.setAttribute('aria-expanded','true');
      trigger.setAttribute('aria-label','Close workspace menu');
      trigger.innerHTML='<span aria-hidden="true">×</span>';
      document.body.classList.add('mobile-workspace-menu-open');
      menu.querySelector('a')?.focus();
    };
    trigger.addEventListener('click',function(){menu.classList.contains('is-open')?close():open();});
    menu.querySelector('.mobile-workspace-backdrop')?.addEventListener('click',close);
    menu.querySelector('.mobile-workspace-close')?.addEventListener('click',close);
    menu.querySelectorAll('a').forEach(function(link){link.addEventListener('click',close);});
    const onKeydown=function(event){if(event.key==='Escape'&&menu.classList.contains('is-open')){close();trigger.focus();}};
    document.addEventListener('keydown',onKeydown);
    window.__FLOATSHEETS_MOBILE_MENU_DISPOSE__=function(){
      document.removeEventListener('keydown',onKeydown);
      document.body.classList.remove('mobile-workspace-menu-open');
      menu.remove();trigger.remove();
      delete window.__FLOATSHEETS_MOBILE_MENU_DISPOSE__;
    };
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
    return '<div class="live-only-panel live-trade-ticket"><h2>Open '+selected.symbol+' exposure</h2><div class="segmented"><button type="button" data-live-side="long" class="active">↗ Long</button><button type="button" data-live-side="short" class="short">↘ Short</button></div>'+tokenAmountInput('live-collateral','Margin to deposit')+'<div class="field live-leverage-field"><label for="live-leverage">Target leverage <b id="live-leverage-value">1×</b></label><input id="live-leverage" type="range" min="1" max="'+selected.max+'" value="1" step="1"><div class="leverage-row"><span>1×</span><span>'+selected.max+'× maximum</span></div></div><p class="trade-contract-warning" id="live-contract-warning" role="alert" hidden></p><div class="order-summary" id="live-order-summary"></div><p class="order-disclosure">You will see the final price and fee before confirming. Prices refresh quickly.</p><button class="primary-btn" id="submit-live-trade" type="button">Open long position</button></div>';
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
    const warning=ticket.querySelector('#live-contract-warning');
    const leverageField=ticket.querySelector('.live-leverage-field');
    let validationTimer=0,validationRequest=0,tradeAccepted=false;
    const clearContractWarning=function(){
      warning.hidden=true;warning.textContent='';ticket.querySelector('.token-amount-shell')?.classList.remove('is-contract-invalid','contract-shake');leverageField?.classList.remove('is-contract-invalid','contract-shake');
    };
    const showContractWarning=function(message,field){
      clearContractWarning();warning.hidden=false;warning.textContent=message;
      const target=field==='margin'?ticket.querySelector('.token-amount-shell'):leverageField;
      target?.classList.add('is-contract-invalid','contract-shake');
      setTimeout(function(){target?.classList.remove('contract-shake');},380);
    };
    const update=function(){
      try {
        const margin=rawUsdG(collateral.value),lev=BigInt(leverage.value);
        // Reserve the six-bps execution fee before determining a notional that
        // satisfies the clearing house's initial-margin invariant.
        const notional=margin*lev*10000n/(10000n+lev*6n);
        ticket.querySelector('#live-leverage-value').textContent=leverage.value+'×';
        summary.innerHTML='<div><span>Margin</span><b>'+displayUsdG(margin)+' USDG</b></div><div><span>Position size</span><b>Up to '+displayUsdG(notional)+' USDG</b></div><div><span>Trading fee</span><b>0.06%</b></div>';
        submit.disabled=margin===0n||!tradeAccepted;
      } catch { summary.innerHTML=''; submit.disabled=true; }
    };
    const checkTrade=function(){
      clearTimeout(validationTimer);
      tradeAccepted=false;update();clearContractWarning();
      let margin,lev,notional;
      try { margin=rawUsdG(collateral.value);lev=BigInt(leverage.value);notional=margin*lev*10000n/(10000n+lev*6n); } catch { return; }
      if(margin===0n||notional===0n) return;
      const request=++validationRequest;
      validationTimer=setTimeout(async function(){
        try {
          const wallet=walletApi();if(!wallet?.checkTrade) throw new Error('Trading checks are still loading.');
          const result=await wallet.checkTrade({market:selected.symbol,isLong:isLong,marginUsdg:margin.toString(),notionalUsdg:notional.toString(),targetLeverage:lev.toString()});
          if(request!==validationRequest||!ticket.isConnected)return;
          tradeAccepted=result?.acceptable===true;
          if(!tradeAccepted) showContractWarning(typeof result?.reason==='string'?result.reason:'This position is not available right now.',result?.field==='margin'?'margin':'leverage');
        } catch(reason) {
          if(request!==validationRequest||!ticket.isConnected)return;
          tradeAccepted=false;showContractWarning(reason instanceof Error?reason.message:'This position could not be checked right now.','leverage');
        }
        update();
      },350);
    };
    ticket.querySelectorAll('[data-live-side]').forEach(function(button){button.addEventListener('click',function(){isLong=button.dataset.liveSide==='long';ticket.querySelectorAll('[data-live-side]').forEach(function(item){item.classList.toggle('active',item===button);});submit.textContent='Open '+(isLong?'long':'short')+' position';checkTrade();});});
    collateral.addEventListener('input',function(){paintTokenAmount(collateral);checkTrade();}); leverage.addEventListener('input',checkTrade); paintTokenAmount(collateral);update();
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
        if(!tradeAccepted) throw new Error('Adjust your margin or leverage until this position is available.');
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
  let portfolioPnlMode = localStorage.getItem('floatsheets-portfolio-pnl') === 'realized' ? 'realized' : 'unrealized';
  let lastPnlSnapshot = null;
  const pnlDisplay = window.FloatSheetsPnlDisplay;

  function pnlCard(portfolio){
    return '<div class="metric pnl-card"><div class="pnl-heading"><small id="pnl-label">Unrealized PnL</small>'+(portfolio?'<div class="pnl-toggle" role="group" aria-label="Profit and loss view"><button type="button" data-pnl-mode="unrealized">uPnL</button><button type="button" data-pnl-mode="realized">PnL</button></div>':'')+'</div><strong id="wallet-market-pnl" class="pnl-value" role="img" aria-label="Loading profit and loss">…</strong><div class="metric-note pnl-note"><span class="asset-ref"><img src="/usdg_logo.png" alt="">USDG</span><span id="pnl-percent">—</span></div><div class="pnl-caption" id="pnl-caption"></div></div>';
  }

  function rollValue(element, value){
    if(element.dataset.value === value) return;
    const previous = element.dataset.value;
    element.dataset.value = value;
    element.setAttribute('aria-label', value + ' USDG');
    const animate = previous && !document.body.classList.contains('reduce-dash-motion') && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.replaceChildren();
    Array.from(value).forEach(function(character, index){
      const slot = document.createElement('span'); slot.className = 'pnl-reel'; slot.setAttribute('aria-hidden','true');
      if(!/\d/.test(character) || !animate || previous[index] === character){
        slot.textContent = character;
      } else {
        const oldDigit = /\d/.test(previous[index] || '') ? Number(previous[index]) : 0;
        const steps = 10 + (Number(character) - oldDigit + 10) % 10;
        const strip = document.createElement('span'); strip.className = 'pnl-reel-strip';
        for(let n=0;n<=steps;n++){const digit=document.createElement('span');digit.textContent=String((oldDigit+n)%10);strip.append(digit);}
        slot.append(strip);
        const animation = strip.animate([{transform:'translateY(0)'},{transform:'translateY(-'+steps+'em)'}], {duration:550+index*18,easing:'cubic-bezier(.18,.7,.25,1)',fill:'forwards'});
        animation.onfinish=function(){if(slot.isConnected)slot.replaceChildren(document.createTextNode(character));};
      }
      element.append(slot);
    });
  }

  function paintPnl(snapshot, portfolio){
    const realized = portfolio && portfolioPnlMode === 'realized';
    const raw = BigInt(realized ? snapshot.realizedUsdg : snapshot.unrealizedUsdg);
    const denominator = realized ? snapshot.depositedUsdg : snapshot.activeMarginUsdg;
    const value = root.querySelector('#wallet-market-pnl');
    if(!value) return;
    root.querySelector('#pnl-label').textContent = realized ? 'Realized PnL' : 'Unrealized PnL';
    value.classList.toggle('positive', raw > 0n); value.classList.toggle('negative', raw < 0n);
    rollValue(value, pnlDisplay.signedDecimal(raw));
    const percent = root.querySelector('#pnl-percent');
    percent.textContent = '('+pnlDisplay.percentage(raw, denominator)+')';
    percent.title = realized ? 'Return on total margin deposited across your markets.' : 'Return on the current margin backing your open positions.';
    root.querySelector('#pnl-caption').textContent = realized ? 'After trading fees · all markets' : (snapshot.stale ? 'Last available price · update delayed' : 'Before closing fees');
    root.querySelectorAll('[data-pnl-mode]').forEach(function(button){button.setAttribute('aria-pressed',String((button.dataset.pnlMode === 'realized') === realized));});
  }

  async function renderWalletContext(){
    const wallet = walletState(), request = ++walletRequest;
    if(!wallet?.connected) return;
    const view = location.hash.slice(1) || 'trade';
    const portfolio = view === 'portfolio';
    const details = view === 'trade' ? location.pathname.match(/^\/dashboard\/([A-Za-z0-9.-]+)\/?$/)?.[1]?.toUpperCase() : null;
    if(!portfolio && !details) return;
    const balance = displayUsdG(rawUsdG(wallet.usdgBalance || '0'));
    const accountKey = wallet.address.toLowerCase() + ':' + (portfolio ? 'portfolio' : details);
    const target = portfolio ? root.querySelector('#wallet-portfolio') : root.querySelector('.metric-grid');
    if(!target) return;
    if(target.dataset.account !== accountKey){
      target.dataset.account = accountKey;
      const walletCard = '<div class="metric featured"><small>Wallet USDG balance</small><strong id="pnl-wallet-balance">'+balance+'</strong><div class="metric-note"><span class="asset-ref"><img src="/usdg_logo.png" alt="">USDG</span> · available to use</div></div>';
      target.innerHTML = portfolio
        ? '<div class="metric-grid">'+walletCard+'<div class="metric"><small>Open positions</small><strong id="portfolio-position-count">…</strong><div class="metric-note">across your markets</div></div>'+pnlCard(true)+'</div><div id="portfolio-position-table"></div>'
        : walletCard+'<div class="metric"><small>Margin in this market</small><strong id="wallet-market-margin">…</strong><div class="metric-note">'+details+' only</div></div><div class="metric"><small>Your position</small><strong id="wallet-market-size">…</strong><div class="metric-note">current size</div></div>'+pnlCard(false);
      target.querySelectorAll('[data-pnl-mode]').forEach(function(button){
        button.addEventListener('click',function(){
          portfolioPnlMode = button.dataset.pnlMode;
          localStorage.setItem('floatsheets-portfolio-pnl',portfolioPnlMode);
          if(lastPnlSnapshot?.key === accountKey) paintPnl(lastPnlSnapshot.snapshot,true);
        });
      });
    }
    try {
      const snapshot = await walletApi().pnlSnapshot(portfolio ? markets.map(m=>m.symbol) : [details], portfolio);
      if(request !== walletRequest || !root.isConnected || walletState()?.address?.toLowerCase() !== wallet.address.toLowerCase() || !walletState()?.connected) return;
      lastPnlSnapshot = {key:accountKey,snapshot};
      if(!portfolio) activeChart?.setPosition(snapshot.positions.find(p=>p.symbol===details));
      root.querySelector('#pnl-wallet-balance').textContent = balance;
      paintPnl(snapshot,portfolio);
      const open = snapshot.positions.filter(p=>BigInt(p.sizeE18)!==0n);
      const table = '<div class="table-scroll"><table><thead><tr><th>Market</th><th>Direction</th><th>Base size</th><th>Entry price</th><th>Margin</th><th>uPnL (USDG)</th></tr></thead><tbody>'+open.map(function(p){
        return '<tr><td>'+escapeMessage(p.symbol)+'</td><td class="'+(BigInt(p.sizeE18)>0n?'positive':'negative')+'">'+(BigInt(p.sizeE18)>0n?'Long':'Short')+'</td><td>'+Math.abs(Number(p.sizeE18)/1e18).toLocaleString(undefined,{maximumFractionDigits:8})+'</td><td>$'+(Number(p.entryPriceE18)/1e18).toLocaleString(undefined,{maximumFractionDigits:4})+'</td><td>'+displayUsdG(BigInt(p.marginUsdg))+' USDG</td><td>'+pnlDisplay.signedDecimal(p.pnlUsdg)+'</td></tr>';
      }).join('')+'</tbody></table></div>';
      if(portfolio){
        root.querySelector('#portfolio-position-count').textContent = String(open.length);
        root.querySelector('#portfolio-position-table').innerHTML = open.length ? table : '<div class="empty-state"><h3>No open positions</h3><p>Your closed trades are included in realized PnL.</p></div>';
      } else {
        const position = snapshot.positions[0];
        root.querySelector('#wallet-market-margin').textContent = displayUsdG(BigInt(position.marginUsdg));
        root.querySelector('#wallet-market-size').textContent = (Number(position.sizeE18)/1e18).toLocaleString(undefined,{maximumFractionDigits:8});
        installClosePosition(position); installMarginRecovery(position);
        const positionsTarget = root.querySelector('#wallet-trade-positions');
        if(positionsTarget) positionsTarget.innerHTML = '<div class="panel-head"><h2>Open position</h2></div>'+(open.length ? table : '<div class="empty-state"><h3>No open '+details+' position</h3><p>Open a position to see it here.</p></div>');
      }
    } catch(error) {
      if(request !== walletRequest || !root.isConnected) return;
      const value = root.querySelector('#wallet-market-pnl');
      if(value){value.textContent='—';value.removeAttribute('data-value');value.setAttribute('aria-label','Profit and loss unavailable');}
      root.querySelector('#pnl-percent').textContent='—';
      root.querySelector('#pnl-caption').textContent='Update unavailable · retrying';
      lastPnlSnapshot = null;
      activeChart?.setPosition(null);
      console.warn('FloatSheets account refresh failed',error);
    }
  }

  function vaultPanel(){
    const wallet=walletState();
    if(!wallet?.connected) return '<section class="panel live-only-panel"><h2>Provide liquidity</h2><p>Connect your wallet to deposit USDG and receive vault shares.</p><button class="primary-btn" id="connect-to-vault" type="button">Connect wallet</button></section>';
    return '<section class="panel live-only-panel" id="live-vault-panel"><h2>Provide liquidity</h2><p>Your USDG helps back all FloatSheets markets. Your vault share value changes as traders profit or lose.</p><div id="live-vault-data"><p>Loading vault balances.</p></div></section>';
  }

  function keeperPanel(){
    return '<section class="panel live-only-panel keeper-panel" id="keeper-panel"><div class="panel-head"><h2>Protocol keeper</h2><span class="pill" id="keeper-state">CHECKING</span></div><div class="panel-body" id="keeper-data"><p>Loading keeper status.</p></div></section>';
  }

  function keeperEscape(value){ return String(value??'').replace(/[&<>"']/g,function(character){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character];}); }

  function keeperAge(iso){
    if(!iso) return 'not yet';
    const seconds=Math.max(0,Math.round((Date.now()-new Date(iso).getTime())/1000));
    return seconds<60?seconds+'s ago':Math.round(seconds/60)+'m ago';
  }

  async function renderKeeperContext(){
    const target=root.querySelector('#keeper-data'),badge=root.querySelector('#keeper-state'),api=window.__FLOATSHEETS_SERVER_API__;
    if(!target||!api?.getKeeperStatus) return;
    try {
      const status=await api.getKeeperStatus();
      const tracked=status.deployments.reduce(function(sum,row){return sum+row.tracked_positions;},0);
      const healthy=status.enabled&&!status.last_error&&status.last_run_finished_at&&(Date.now()-new Date(status.last_run_finished_at).getTime())<status.interval_seconds*4000;
      if(badge){badge.textContent=!status.enabled?'PAUSED':healthy?'WATCHING':'DEGRADED';}
      const actions=status.recent_actions.map(function(row){
        const label=(row.reason==='expiry'?'Closed at 7-day expiry':'Liquidated below maintenance')+(row.market?' · '+keeperEscape(row.market):'');
        const link=row.transaction_hash?'<a href="https://robinhoodchain.blockscout.com/tx/'+keeperEscape(row.transaction_hash)+'" target="_blank" rel="noreferrer">View transaction ↗</a>':'';
        return '<div class="list-row"><div><strong>'+label+'</strong><p>'+keeperEscape(row.trader.slice(0,6)+'…'+row.trader.slice(-4))+' · '+new Date(row.created_at).toLocaleString()+' · '+keeperEscape(row.contract_version)+'</p></div><div>'+(row.status==='confirmed'?link:'<span class="pill">RETRYING</span>')+'</div></div>';
      }).join('');
      target.innerHTML='<div class="metric-grid"><div class="metric featured"><small>Positions watched</small><strong>'+tracked+'</strong><div class="metric-note">Across '+status.deployments.length+' deployments</div></div><div class="metric"><small>Liquidations</small><strong>'+status.totals.liquidations+'</strong><div class="metric-note">Below maintenance margin</div></div><div class="metric"><small>Expiry closes</small><strong>'+status.totals.expiries+'</strong><div class="metric-note">Positions past 7 days</div></div><div class="metric"><small>Keeper rewards</small><strong>'+(status.claimable_rewards_usdg===null?'—':displayUsdG(BigInt(status.claimable_rewards_usdg)))+'</strong><div class="metric-note"><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span> · kept by the protocol</div></div></div><p class="info-note">FloatSheets runs its own keeper. Every '+status.interval_seconds+' seconds it checks each open position on Robinhood Chain and closes those that fall below maintenance margin or pass the 7-day limit, so losses never wait on third-party bots. Last check: '+keeperAge(status.last_run_finished_at)+'.</p>'+(actions?'<section class="queue-requests">'+actions+'</section>':'<div class="list-row"><div><strong>No closes needed</strong><p>Every watched position is above maintenance margin and inside its 7-day window.</p></div><span class="pill">ALL CLEAR</span></div>');
    } catch(error) {
      if(badge) badge.textContent='UNAVAILABLE';
      target.innerHTML='<p>Keeper status is temporarily unavailable.</p>';
      console.warn('FloatSheets keeper status failed',error);
    }
  }

  async function renderVaultContext(){
    const target=root.querySelector('#live-vault-data');
    root.querySelector('#connect-to-vault')?.addEventListener('click',function(){document.getElementById('account-button')?.click();});
    if(!target||!walletState()?.connected) return;
    try {
      const wallet=walletApi(),vault=await wallet?.vault();if(!vault)return;
      const assets=BigInt(vault.assets),shares=BigInt(vault.shares),lockedShares=BigInt(vault.lockedShares),totalShares=BigInt(vault.totalShares),available=BigInt(vault.availableLiquidity);
      const usableShares=shares>lockedShares?shares-lockedShares:0n;
      const ownership=totalShares===0n?'0.00':(Number(shares)*100/Number(totalShares)).toFixed(2);
      const shareValue=shares*(assets+1n)/(totalShares+1000000n);
      const now=Math.floor(Date.now()/1000),readyAt=Number(vault.epochStartedAt)+Number(vault.epochDuration),settleReady=!vault.epochSettled&&vault.navFresh&&now>=readyAt;
      const pending=(vault.requests||[]).filter(function(row){return (BigInt(row.depositAssets)>0n&&!row.depositClaimed)||(BigInt(row.withdrawalShares)>0n&&!row.withdrawalClaimed);});
      const requestRows=pending.map(function(row){
        const depositPending=BigInt(row.depositAssets)>0n&&!row.depositClaimed,withdrawPending=BigInt(row.withdrawalShares)>0n&&!row.withdrawalClaimed;
        const text=(depositPending?'Deposit '+displayUsdG(BigInt(row.depositAssets))+' USDG':'')+(depositPending&&withdrawPending?' · ':'')+(withdrawPending?'Withdrawal '+(BigInt(row.withdrawalShares)/1000000000000n).toString()+' shares':'');
        if(!row.settled)return '<div class="list-row"><div><strong>Epoch '+row.epoch+' · '+text+'</strong><p>Waiting for the daily epoch to settle.</p></div><span class="pill">QUEUED</span></div>';
        const withdrawalAction=withdrawPending?(BigInt(row.settledWithdrawalShares||'0')===0n?'<button class="small-btn" data-cancel-withdrawal="'+row.epoch+'">Release queued shares</button>':'<button class="small-btn" data-claim-withdrawal="'+row.epoch+'">Claim USDG</button>'):'';
        const status=withdrawPending&&BigInt(row.settledWithdrawalShares||'0')===0n?'Withdrawal was deferred because vault liquidity was insufficient. Release your shares and retry later.':'Settlement is complete. Claim your shares or USDG.';
        return '<div class="list-row"><div><strong>Epoch '+row.epoch+' · '+text+'</strong><p>'+status+'</p></div><div>'+ (depositPending?'<button class="small-btn" data-claim-deposit="'+row.epoch+'">Claim shares</button> ':'')+withdrawalAction+'</div></div>';
      }).join('');
      const queueStatus='<div class="list-row"><div><strong>Daily LP epoch · '+vault.epoch+'</strong><p>'+(vault.epochSettled?'This epoch is settled. New requests start the next epoch.':!vault.navFresh?'Settlement paused until all open markets have fresh, unbroken oracle marks.':settleReady?'The epoch is ready for settlement.':'Requests settle after '+new Date(readyAt*1000).toLocaleString()+'.')+'</p></div>'+(settleReady?'<button class="small-btn" id="settle-vault-queue">Settle requests</button>':'<span class="pill">'+(vault.epochSettled?'SETTLED':!vault.navFresh?'NAV PAUSED':'24 HOUR QUEUE')+'</span>')+'</div>';
      target.innerHTML='<div class="metric-grid"><div class="metric featured"><small>Vault assets</small><strong>'+displayUsdG(assets)+'</strong><div class="metric-note"><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span> · '+(vault.navFresh?'marked to open PnL':'NAV unavailable while oracle marks are stale')+'</div></div><div class="metric"><small>Your vault value</small><strong>'+displayUsdG(shareValue)+'</strong><div class="metric-note"><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span> · '+ownership+'% of vault</div></div><div class="metric"><small>Available liquidity</small><strong>'+displayUsdG(available)+'</strong><div class="metric-note">After market stress reserve</div></div><div class="metric"><small>Insurance tranche</small><strong>'+displayUsdG(BigInt(vault.insuranceAssets))+'</strong><div class="metric-note">First-loss buffer</div></div></div><p class="info-note">Deposits and withdrawals enter a daily queue and are priced at epoch settlement. Share value reflects current open trader PnL.</p>'+queueStatus+(requestRows?'<section class="queue-requests">'+requestRows+'</section>':'')+tokenAmountInput('live-vault-deposit','USDG to deposit')+'<button class="primary-btn" id="submit-vault-deposit" type="button">Queue deposit</button>'+(usableShares>0n?'<button class="secondary-btn" id="submit-vault-withdraw" type="button">Queue withdrawal of available shares</button>':'');
      const input=target.querySelector('#live-vault-deposit'),deposit=target.querySelector('#submit-vault-deposit'),withdraw=target.querySelector('#submit-vault-withdraw');
      input?.addEventListener('input',function(){paintTokenAmount(input);});paintTokenAmount(input);
      deposit?.addEventListener('click',async function(){try{const amount=rawUsdG(input.value);if(amount===0n)throw new Error('Enter a USDG amount greater than zero.');deposit.disabled=true;const allowance=await wallet.vaultAllowance();if(allowance<amount){deposit.textContent='Confirm USDG approval…';const approval=await wallet.buildTransaction('vault-approve',{amountUsdg:amount.toString()});await wallet.send(approval.transaction);}deposit.textContent='Confirm queue request…';const tx=await wallet.buildTransaction('vault-deposit',{amountUsdg:amount.toString()});const hash=await wallet.send(tx.transaction);render();showActionModal('Deposit queued','Your USDG deposit is queued for daily epoch settlement. Transaction: '+hash);}catch(reason){deposit.disabled=false;deposit.textContent='Queue deposit';showActionModal('Could not queue deposit',reason instanceof Error?reason.message:'Deposit could not be queued.');}});
      withdraw?.addEventListener('click',async function(){try{withdraw.disabled=true;withdraw.textContent='Confirm queue request…';const tx=await wallet.buildTransaction('vault-withdraw',{shares:usableShares.toString()});const hash=await wallet.send(tx.transaction);render();showActionModal('Withdrawal queued','Your shares are queued for daily epoch settlement. Transaction: '+hash);}catch(reason){withdraw.disabled=false;withdraw.textContent='Queue withdrawal of available shares';showActionModal('Could not queue withdrawal',reason instanceof Error?reason.message:'Withdrawal could not be queued.');}});
      target.querySelector('#settle-vault-queue')?.addEventListener('click',async function(event){const button=event.currentTarget;try{button.disabled=true;const tx=await wallet.buildTransaction('vault-settle-queue',{});const hash=await wallet.send(tx.transaction);render();showActionModal('LP epoch settled','Queued deposits and withdrawals were priced at the same vault NAV. Transaction: '+hash);}catch(reason){button.disabled=false;showActionModal('Could not settle LP requests',reason instanceof Error?reason.message:'Epoch settlement failed.');}});
      target.querySelectorAll('[data-claim-deposit]').forEach(function(button){button.addEventListener('click',async function(){try{const epoch=button.getAttribute('data-claim-deposit');const tx=await wallet.buildTransaction('vault-claim-deposit',{epoch});const hash=await wallet.send(tx.transaction);render();showActionModal('Shares claimed','Your queued deposit shares were claimed. Transaction: '+hash);}catch(reason){showActionModal('Could not claim shares',reason instanceof Error?reason.message:'Share claim failed.');}});});
      target.querySelectorAll('[data-claim-withdrawal]').forEach(function(button){button.addEventListener('click',async function(){try{const epoch=button.getAttribute('data-claim-withdrawal');const tx=await wallet.buildTransaction('vault-claim-withdrawal',{epoch,receiver:wallet.address});const hash=await wallet.send(tx.transaction);render();showActionModal('Withdrawal claimed','Your queued USDG withdrawal was claimed. Transaction: '+hash);}catch(reason){showActionModal('Could not claim withdrawal',reason instanceof Error?reason.message:'Withdrawal claim failed.');}});});
      target.querySelectorAll('[data-cancel-withdrawal]').forEach(function(button){button.addEventListener('click',async function(){try{const epoch=button.getAttribute('data-cancel-withdrawal');const tx=await wallet.buildTransaction('vault-cancel-withdrawal',{epoch});const hash=await wallet.send(tx.transaction);render();showActionModal('Withdrawal released','Your shares are unlocked. You can queue another withdrawal when liquidity is available. Transaction: '+hash);}catch(reason){showActionModal('Could not release shares',reason instanceof Error?reason.message:'Withdrawal cancellation failed.');}});});
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
      el.textContent=el.textContent.replace(/fictional markets/gi,'live markets').replace(/virtual (account )?balance/gi,'wallet collateral').replace(/Illustrative equity market/gi,'Robinhood Chain market').replace(/24h change · sample/gi,'24h change · recorded oracle');
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
    if(view==='vault') root.innerHTML='<div class="page-heading"><div><h1>Liquidity vault.</h1><p>Provide USDG liquidity for FloatSheets markets.</p></div></div>'+vaultPanel()+keeperPanel();
    if(view==='listings') root.innerHTML='<div class="page-heading"><div><h1>Market listings.</h1><p>Available markets on Robinhood Chain.</p></div></div><section class="panel markets-panel"><div class="table-scroll"><table><thead><tr><th>Market</th><th>Settlement</th><th>Price</th><th>Status</th></tr></thead><tbody>'+markets.map(function(m){return '<tr><td>'+m.symbol+'</td><td><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span></td><td>$'+money(m.price)+'</td><td>'+stateBadge(m.state)+'</td></tr>';}).join('')+'</tbody></table></div></section>';
    if(view==='settings') root.querySelectorAll('.panel').forEach(function(panel){if(!panel.querySelector('#preferences-form')) panel.remove();});
  }

  function installThemeToggle(){
    const settingsPanel=root.querySelector('#preferences-form .panel-body') || root.querySelector('#preferences-form')?.parentElement;
    if(!settingsPanel) return;
    if(!document.getElementById('contract-version-select')){
      const versionRow=document.createElement('div'); versionRow.className='list-row contract-version-row';
      versionRow.innerHTML='<div><strong>Contract version</strong><p>Choose which FloatSheets contracts power your dashboard and wallet actions.</p></div><select id="contract-version-select" aria-label="Contract version"><option value="goldlake">FloatSheets Goldlake · latest</option><option value="silverlake">FloatSheets Silverlake · legacy access</option><option value="amber" disabled>FloatSheets Amber · retired</option><option value="jasper" disabled>FloatSheets Jasper · paused</option><option value="meadow" disabled>FloatSheets Meadow · paused</option><option value="legacy-orion">FloatSheets Legacy Orion · vault access</option></select>';
      settingsPanel.append(versionRow);
      const select=versionRow.querySelector('select');
      select.value=selectedContractVersion();
      select.addEventListener('change',function(){
        const version=select.value==='legacy-orion'?'legacy-orion':select.value==='silverlake'?'silverlake':'goldlake';
        localStorage.setItem('floatsheets-contract-version-v1',version);
        window.dispatchEvent(new CustomEvent('floatsheets-contract-version-change',{detail:{version:version}}));
      });
    }
    if(document.getElementById('dashboard-dark-mode')) return;
    const row=document.createElement('div'); row.className='list-row dashboard-theme-row';
    row.innerHTML='<div><strong>Dark dashboard</strong><p>Use a lower-light workspace palette.</p></div><input type="checkbox" class="setting-toggle" id="dashboard-dark-mode" aria-label="Dark dashboard">';
    settingsPanel.append(row);
    const toggle=row.querySelector('input');
    toggle.checked=localStorage.getItem('floatsheets-dashboard-theme')==='dark';
    document.body.classList.toggle('dashboard-dark',toggle.checked);
    toggle.addEventListener('change',function(){document.body.classList.toggle('dashboard-dark',toggle.checked);localStorage.setItem('floatsheets-dashboard-theme',toggle.checked?'dark':'light');});
  }

  function showContractWelcome(){
    if(window.__FLOATSHEETS_WELCOME_SHOWN__||typeof modal!=='function')return;
    window.__FLOATSHEETS_WELCOME_SHOWN__=true;
    const version=selectedContractVersion();
    const name=version==='legacy-orion'?'FloatSheets Legacy Orion':version==='goldlake'?'FloatSheets Goldlake':version==='amber'?'FloatSheets Amber':version==='silverlake'?'FloatSheets Silverlake':'FloatSheets Silverlake';
    modal('Welcome to FloatSheets.','<p>Your dashboard is using <strong>'+name+'</strong>.</p><p>You can switch contract versions any time in <strong>Settings → Contract version</strong>. The selected version controls the contracts used for your wallet, positions, oracle data, and vault.</p>','Open Settings',function(){dialog.close();location.hash='settings';});
  }

  function showLegacyTradingDisabled(){
    const version=selectedContractVersion();
    const view=location.hash.slice(1)||'trade';
    if(version==='silverlake'&&view==='trade'){
      root.innerHTML='<section class="panel live-only-panel legacy-trading-overlay" role="status"><div class="legacy-trading-copy"><span class="pill">FLOATSHEETS SILVERLAKE</span><h1>New trades use Goldlake.</h1><p>You can manage existing Silverlake positions from Portfolio and withdraw Silverlake liquidity from Vault. Select Goldlake to open new positions.</p><div class="legacy-trading-actions"><button type="button" class="small-btn" data-switch-goldlake>Switch to Goldlake</button><a class="small-btn" href="#portfolio">Open portfolio</a><a class="small-btn" href="#vault">Open vault</a></div></div></section>';
      root.querySelector('[data-switch-goldlake]').addEventListener('click',function(){localStorage.setItem('floatsheets-contract-version-v1','goldlake');window.dispatchEvent(new CustomEvent('floatsheets-contract-version-change',{detail:{version:'goldlake'}}));});
      return true;
    }
    if(version!=='legacy-orion'||!['trade','portfolio','oracle','listings'].includes(view))return false;
    root.innerHTML='<section class="panel live-only-panel legacy-trading-overlay" role="status" aria-labelledby="legacy-trading-title"><div class="legacy-trading-mark" aria-hidden="true">i</div><div class="legacy-trading-copy"><span class="pill">FLOATSHEETS LEGACY ORION</span><h1 id="legacy-trading-title">Trading is disabled on Orion.</h1><p>You can still use the vault to view your liquidity and withdraw it. Switch to FloatSheets Goldlake to access trading, portfolio, oracle and market listing pages.</p><div class="legacy-trading-actions"><button type="button" class="small-btn" data-switch-goldlake>Switch to Goldlake</button><a class="small-btn" href="#vault">Open vault</a><a class="legacy-settings-link" href="#settings">Version settings</a></div></div></section>';
    root.querySelector('[data-switch-goldlake]').addEventListener('click',function(){
      localStorage.setItem('floatsheets-contract-version-v1','goldlake');
      window.dispatchEvent(new CustomEvent('floatsheets-contract-version-change',{detail:{version:'goldlake'}}));
    });
    return true;
  }

  let chartRequest = 0;
  function scheduleChartRefresh(){
    clearInterval(window.__FLOATSHEETS_CHART_REFRESH_TIMER__);
    const onMarketPage=Boolean(location.pathname.match(/^\/dashboard\/[A-Za-z0-9.-]+\/?$/));
    if(onMarketPage) window.__FLOATSHEETS_CHART_REFRESH_TIMER__=setInterval(function(){
      if(!root.isConnected){clearInterval(window.__FLOATSHEETS_CHART_REFRESH_TIMER__);activeChart?.destroy();return;}
      if(!document.hidden){drawChart();void refreshLiveMarketTruth();}
    },30_000);
  }
  function scheduleWalletRefresh(){
    clearInterval(window.__FLOATSHEETS_WALLET_REFRESH_TIMER__);
    let refreshing=false;
    if(walletState()?.connected) window.__FLOATSHEETS_WALLET_REFRESH_TIMER__=setInterval(async function(){
      if(!root.isConnected){clearInterval(window.__FLOATSHEETS_WALLET_REFRESH_TIMER__);return;}
      if(refreshing||document.hidden||root.querySelector('.live-trade-ticket[data-submitting="true"]'))return;
      refreshing=true;
      try { await renderWalletContext(); } finally { refreshing=false; }
    },15_000);
  }
  let activeChart = null, chartKey = '', chartAbort = null, liveTruthRequest = 0;
  function paintTwentyFourHourChange(history){
    const stat=root.querySelector('.chart-stats > div:nth-child(2)');
    const label=stat?.querySelector('small'), value=stat?.querySelector('strong');
    if(!label||!value)return;
    label.textContent='24h change · recorded oracle';
    let candles=[];
    try { candles=history ? globalThis.FloatSheetsMarketChart.readCandles(history,'1D') : []; } catch {}
    const first=candles[0], last=candles[candles.length-1];
    // Do not describe a partial new-market history as a 24-hour performance.
    if(!first||!last||last.observed-first.observed<21*60*60*1000||first.open<=0){
      value.className='';value.textContent='—';label.textContent='24h change · building history';return;
    }
    const change=(last.close-first.open)/first.open*100;
    if(!Number.isFinite(change)){value.className='';value.textContent='—';return;}
    value.className=change>=0?'positive':'negative';
    value.textContent=(change>=0?'+':'')+change.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:4})+'%';
  }
  function paintLiveMarketTruth(data){
    const confidence=root.querySelector('.chart-stats > div:nth-child(3)');
    const status=root.querySelector('.chart-stats > div:nth-child(4)');
    if(!confidence||!status)return;
    const confidenceLabel=confidence.querySelector('small'),confidenceValue=confidence.querySelector('strong');
    const stateLabel=status.querySelector('small'),stateValue=status.querySelector('.state');
    if(confidenceLabel)confidenceLabel.textContent='Oracle confidence';
    if(stateLabel)stateLabel.textContent='Trade status';
    if(!data){if(confidenceValue)confidenceValue.textContent='—';if(stateValue)stateValue.textContent='CHECKING';return;}
    const bps=Number(data.oracle_confidence_bps);
    if(confidenceValue){
      confidenceValue.textContent=Number.isFinite(bps)?'± '+(bps/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})+'%':'—';
      confidenceValue.title=Number.isFinite(bps)?bps+' bps · current on-chain oracle attestation':'Unavailable';
    }
    if(stateValue){
      stateValue.className='state '+data.state;
      stateValue.textContent=data.state==='LIVE'?'LIVE':data.state==='READY'?'READY':data.state==='HALTED'?'HALTED':data.state==='CLOSE_ONLY'?'CLOSE ONLY':'UNAVAILABLE';
      stateValue.title=data.state==='READY'?'A current oracle price is published when you request a quote.':'Current on-chain market and oracle check';
    }
  }
  function abortable(promise,signal){
    return new Promise(function(resolve,reject){
      if(signal.aborted){reject(new DOMException('The operation was aborted.','AbortError'));return;}
      const onAbort=function(){reject(new DOMException('The operation was aborted.','AbortError'));};
      signal.addEventListener('abort',onAbort,{once:true});
      promise.then(resolve,reject).finally(function(){signal.removeEventListener('abort',onAbort);});
    });
  }
  async function refreshLiveMarketTruth(){
    const detail=location.pathname.match(/^\/dashboard\/([A-Za-z0-9.-]+)\/?$/)?.[1]?.toUpperCase();
    const api=window.__FLOATSHEETS_SERVER_API__;
    if(!detail||!api)return;
    const request=++liveTruthRequest;paintLiveMarketTruth(null);
    try {
      const version=selectedContractVersion();
      const data=await api.getLiveMarket(detail,version);
      if(request===liveTruthRequest&&root.isConnected&&selected.symbol===detail)paintLiveMarketTruth(data);
    } catch { if(request===liveTruthRequest&&root.isConnected)paintLiveMarketTruth({state:'UNAVAILABLE'}); }
  }
  if(window.__FLOATSHEETS_CHART_DISPOSE__)window.removeEventListener('floatsheets-dashboard-dispose',window.__FLOATSHEETS_CHART_DISPOSE__);
  window.__FLOATSHEETS_CHART_DISPOSE__=function(){
    ++chartRequest;++walletRequest;chartAbort?.abort();activeChart?.destroy();activeChart=null;
    clearInterval(window.__FLOATSHEETS_CHART_REFRESH_TIMER__);
    clearInterval(window.__FLOATSHEETS_WALLET_REFRESH_TIMER__);
    window.__FLOATSHEETS_MOBILE_MENU_DISPOSE__?.();
  };
  window.addEventListener('floatsheets-dashboard-dispose',window.__FLOATSHEETS_CHART_DISPOSE__);
  drawChart = async function drawLiveChart(){
    const canvas=document.getElementById('price-chart');
    if(!canvas) return;
    const requestId=++chartRequest;
    if(activeChart?.canvas!==canvas){
      activeChart?.destroy();
      activeChart=globalThis.FloatSheetsMarketChart.create(canvas);
      chartKey='';
    }
    const key=selected.symbol+':'+timeframe;
    if(chartKey!==key){activeChart.setData({candles:[]},timeframe);chartKey=key;}
    activeChart.loading();
    const wallet=walletState(), snapshot=lastPnlSnapshot;
    const accountKey=wallet?.address?.toLowerCase()+':'+selected.symbol;
    activeChart.setPosition(wallet?.connected && snapshot?.key===accountKey ? snapshot.snapshot.positions.find(p=>p.symbol===selected.symbol) : null);
    const api=window.__FLOATSHEETS_SERVER_API__;
    if(!api){activeChart.unavailable();return;}
    chartAbort?.abort();
    chartAbort=new AbortController();
    const controller=chartAbort;
    const timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const version=selectedContractVersion();
      const historyRequest=api.getMarketHistory(selected.symbol,timeframe,version);
      const dayRequest=timeframe==='1D' ? null : api.getMarketHistory(selected.symbol,'1D',version);
      const payload=await abortable(historyRequest,controller.signal);
      if(requestId!==chartRequest || !canvas.isConnected) return;
      activeChart.setData(payload,timeframe);
      if(dayRequest){
        try { paintTwentyFourHourChange(await abortable(dayRequest,controller.signal)); }
        catch { paintTwentyFourHourChange(null); }
      } else paintTwentyFourHourChange(payload);
    } catch(error) {
      if(requestId===chartRequest && canvas.isConnected)activeChart.unavailable();
    } finally {clearTimeout(timeout);}
  };

  render=function(){
    ++walletRequest;
    ++chartRequest;
    chartAbort?.abort();
    activeChart?.destroy();activeChart=null;
    if(!window.__FLOATSHEETS_LIVE_MARKETS__){ root.innerHTML='<section class="panel live-only-panel"><h2>Loading markets</h2><p>Getting the latest prices and market status.</p></section>'; return; }
    // Set the selected live market before the legacy renderer creates its
    // chart and trade panel. This avoids briefly building a transaction for
    // whichever market happened to be first in the list.
    const requestedSymbol=location.pathname.match(/^\/dashboard\/([A-Za-z0-9.-]+)\/?$/)?.[1]?.toUpperCase();
    if(requestedSymbol) selected=markets.find(function(m){return m.symbol===requestedSymbol})||selected;
    originalRender();
    removeSimulationControls();
    genuinePageContent();
    const legacyTradingDisabled=showLegacyTradingDisabled();
    if(!legacyTradingDisabled){
      paintTwentyFourHourChange(null);
      void refreshLiveMarketTruth();
    }
    document.querySelector('.network-label .pill')?.remove();
    root.querySelectorAll('.risk-strip span').forEach(function(item){if(item.textContent?.trim().startsWith('Sources'))item.remove();});
    decorateAssets();
    normalizeMetricNotes();
    const chartLegend=root.querySelector('.chart-legend');
    if(chartLegend) chartLegend.textContent='Price history · USDG';
    installThemeToggle();
    showContractWelcome();
    installSidebarToggle();
    installMobileWorkspaceMenu();
    installActivityFeed();
    window.__FLOATSHEETS_INSTALL_WALLET__?.();
    if(!legacyTradingDisabled) bindTradeTicket();
    if(!legacyTradingDisabled) void renderWalletContext();
    if(location.hash.slice(1)==='vault') { void renderVaultContext(); void renderKeeperContext(); }
    if(!legacyTradingDisabled) { scheduleChartRefresh(); scheduleWalletRefresh(); }
    else { clearInterval(window.__FLOATSHEETS_CHART_REFRESH_TIMER__); clearInterval(window.__FLOATSHEETS_WALLET_REFRESH_TIMER__); }
  };
  // Discard any local design-time account state before the first live render.
  state={balance:0,positions:[],orders:[],activity:[],nominations:[],vault:0,staked:0,float:0,preferences:{notifications:true,reduced:localStorage.getItem('floatsheets-reduced-motion')==='true'},name:'Trading account'};
  save=function(){localStorage.setItem('floatsheets-reduced-motion',String(Boolean(state.preferences.reduced)));};
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
