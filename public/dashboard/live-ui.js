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
    menu.innerHTML='<button type="button" class="mobile-workspace-backdrop" aria-label="Close workspace menu"></button><section class="mobile-workspace-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-workspace-menu-title"><div class="mobile-workspace-sheet-head"><span id="mobile-workspace-menu-title">WORKSPACE</span><button type="button" class="mobile-workspace-close" aria-label="Close workspace menu">×</button></div><nav aria-label="Workspace navigation"><a href="#trade">↗ <span>Trade</span></a><a href="#portfolio">▦ <span>Portfolio</span></a><a href="#oracle">◎ <span>Oracle &amp; Risk</span></a><a href="#vault">◈ <span>LP</span></a><a href="#news">▤ <span>Float News</span></a><a href="#listings">⊞ <span>Market listings</span></a><a href="#settings">⚙ <span>Settings</span></a></nav></section>';
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
    const withdrawalsOnly=selectedContractVersion()!=='goldlake';
    if(!wallet?.connected) return '<section class="panel live-only-panel"><h2>'+(withdrawalsOnly?'Withdraw liquidity':'Provide liquidity')+'</h2><p>'+(withdrawalsOnly?'Connect your wallet to manage or withdraw existing vault shares. New deposits are disabled for this version.':'Connect your wallet to deposit USDG and receive vault shares.')+'</p><button class="primary-btn" id="connect-to-vault" type="button">Connect wallet</button></section>';
    return '<section class="panel live-only-panel" id="live-vault-panel"><h2>'+(withdrawalsOnly?'Manage legacy liquidity':'Provide liquidity')+'</h2><p>'+(withdrawalsOnly?'View existing shares and queue withdrawals. New liquidity deposits are disabled for this version.':'Your USDG helps back all FloatSheets markets. Your vault share value changes as traders profit or lose.')+'</p><div id="live-vault-data"><p>Loading vault balances.</p></div></section>';
  }

  function keeperPanel(){
    return '<section class="panel live-only-panel keeper-panel" id="keeper-panel"><div class="panel-head"><h2>Protocol keeper</h2><span class="pill" id="keeper-state">CHECKING</span></div><div class="panel-body" id="keeper-data"><p>Loading keeper status.</p></div></section>';
  }

  function escapeHtml(value){ return String(value??'').replace(/[&<>"']/g,function(character){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character];}); }

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
        const label=(row.reason==='expiry'?'Closed at 7-day expiry':'Liquidated below maintenance')+(row.market?' · '+escapeHtml(row.market):'');
        const link=row.transaction_hash?'<a href="https://robinhoodchain.blockscout.com/tx/'+escapeHtml(row.transaction_hash)+'" target="_blank" rel="noreferrer">View transaction ↗</a>':'';
        return '<div class="list-row"><div><strong>'+label+'</strong><p>'+escapeHtml(row.trader.slice(0,6)+'…'+row.trader.slice(-4))+' · '+new Date(row.created_at).toLocaleString()+' · '+escapeHtml(row.contract_version)+'</p></div><div>'+(row.status==='confirmed'?link:'<span class="pill">RETRYING</span>')+'</div></div>';
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
      const depositsEnabled=selectedContractVersion()==='goldlake';
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
      target.innerHTML='<div class="metric-grid"><div class="metric featured"><small>Vault assets</small><strong>'+displayUsdG(assets)+'</strong><div class="metric-note"><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span> · '+(vault.navFresh?'marked to open PnL':'NAV unavailable while oracle marks are stale')+'</div></div><div class="metric"><small>Your vault value</small><strong>'+displayUsdG(shareValue)+'</strong><div class="metric-note"><span class="asset-ref"><img src="/usdg_logo.png" alt="USDG">USDG</span> · '+ownership+'% of vault</div></div><div class="metric"><small>Available liquidity</small><strong>'+displayUsdG(available)+'</strong><div class="metric-note">After market stress reserve</div></div><div class="metric"><small>Insurance tranche</small><strong>'+displayUsdG(BigInt(vault.insuranceAssets))+'</strong><div class="metric-note">First-loss buffer</div></div></div><p class="info-note">'+(depositsEnabled?'Deposits and withdrawals enter a daily queue and are priced at epoch settlement.':'New deposits are disabled. Existing withdrawals and claims remain available.')+' Share value reflects current open trader PnL.</p>'+queueStatus+(requestRows?'<section class="queue-requests">'+requestRows+'</section>':'')+(depositsEnabled?tokenAmountInput('live-vault-deposit','USDG to deposit')+'<button class="primary-btn" id="submit-vault-deposit" type="button">Queue deposit</button>':'')+(usableShares>0n?'<button class="secondary-btn" id="submit-vault-withdraw" type="button">Queue withdrawal of available shares</button>':'');
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
    if(!document.getElementById('liquidation-email-alerts')){
      const alertRow=document.createElement('section'); alertRow.id='liquidation-email-alerts'; alertRow.className='list-row liquidation-email-alerts';
      alertRow.style.cssText='display:block;padding:18px 0;border-top:1px solid var(--line,#e5eaf1)';
      alertRow.innerHTML='<div><strong>Email liquidation alerts</strong><p>Get an email after an on-chain liquidation is confirmed. Verify the address before alerts are sent. Uncheck to pause email alerts; clear the address and save to remove it.</p></div><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px"><input id="liquidation-alert-email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com" aria-label="Alert email address" style="min-width:220px;flex:1;padding:10px 12px;border:1px solid var(--line,#d8deea);border-radius:8px"><label style="display:flex;gap:8px;align-items:center"><input id="liquidation-alert-enabled" type="checkbox"> Enable email</label><button type="button" class="secondary-btn" id="liquidation-alert-save">Save email</button></div><p id="liquidation-alert-status" role="status" aria-live="polite" style="margin:10px 0 0"></p>';
      settingsPanel.append(alertRow);
      const walletState=window.__FLOATSHEETS_WALLET_STATE__||{};
      const saved=walletState.address&&localStorage.getItem('floatsheets-liquidation-email-'+walletState.address.toLowerCase());
      if(saved){try{const pref=JSON.parse(saved);alertRow.querySelector('#liquidation-alert-email').value=pref.email||'';alertRow.querySelector('#liquidation-alert-enabled').checked=pref.enabled===true;}catch{alertRow.querySelector('#liquidation-alert-email').value=saved;}}
      alertRow.querySelector('#liquidation-alert-save').addEventListener('click',async function(){
        const status=alertRow.querySelector('#liquidation-alert-status');
        const wallet=window.__FLOATSHEETS_WALLET__;
        if(!wallet?.connected||typeof wallet.configureEmailAlerts!=='function'){status.textContent='Connect your wallet on Robinhood Chain first.';return;}
        const emailInput=alertRow.querySelector('#liquidation-alert-email');
        const enabled=alertRow.querySelector('#liquidation-alert-enabled').checked;
        if(enabled&&!emailInput.value.trim()){status.textContent='Enter an email address to enable alerts.';emailInput.focus();return;}
        const button=alertRow.querySelector('#liquidation-alert-save'); button.disabled=true; status.textContent='Waiting for wallet signature…';
        try { const result=await wallet.configureEmailAlerts(emailInput.value.trim(),enabled); status.textContent=result.message||'Settings saved.'; }
        catch(error){status.textContent=error instanceof Error?error.message:'Could not update email alerts.';}
        finally {button.disabled=false;}
      });
    }
    if(!document.getElementById('liquidation-telegram-alerts')){
      const telegramRow=document.createElement('section'); telegramRow.id='liquidation-telegram-alerts'; telegramRow.className='list-row liquidation-telegram-alerts';
      telegramRow.style.cssText='display:block;padding:18px 0;border-top:1px solid var(--line,#e5eaf1)';
      telegramRow.innerHTML='<div><strong>Telegram liquidation alerts</strong><p>Link your Telegram account once to this wallet. FloatSheets only sends this bot a message after a confirmed liquidation for your wallet.</p></div><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px"><button type="button" class="secondary-btn" id="liquidation-telegram-link">Link Telegram</button><label style="display:flex;gap:8px;align-items:center"><input id="liquidation-telegram-enabled" type="checkbox" disabled> Enable Telegram</label><span id="liquidation-telegram-linked"></span><a id="liquidation-telegram-open" href="#" target="_blank" rel="noopener noreferrer" hidden>Open Telegram ↗</a></div><p id="liquidation-telegram-status" role="status" aria-live="polite" style="margin:10px 0 0"></p>';
      settingsPanel.append(telegramRow);
      const walletState=window.__FLOATSHEETS_WALLET_STATE__||{};
      const walletAddress=walletState.address&&walletState.address.toLowerCase();
      const saved=walletAddress&&localStorage.getItem('floatsheets-liquidation-telegram-'+walletAddress);
      const toggle=telegramRow.querySelector('#liquidation-telegram-enabled');
      const linked=telegramRow.querySelector('#liquidation-telegram-linked');
      const linkButton=telegramRow.querySelector('#liquidation-telegram-link');
      const status=telegramRow.querySelector('#liquidation-telegram-status');
      if(saved){try{const pref=JSON.parse(saved);toggle.disabled=false;toggle.checked=pref.enabled===true;linked.textContent=pref.username?'Linked as '+pref.username:'Telegram linked';}catch{}}
      toggle.addEventListener('change',async function(){
        const wallet=window.__FLOATSHEETS_WALLET__;
        if(!wallet?.connected||typeof wallet.configureTelegramAlerts!=='function'){toggle.checked=false;status.textContent='Connect your wallet on Robinhood Chain first.';return;}
        const prior=!toggle.checked; toggle.disabled=true; status.textContent='Waiting for wallet signature…';
        try{const result=await wallet.configureTelegramAlerts(toggle.checked);status.textContent=result.message||'Telegram alert settings saved.';}
        catch(error){toggle.checked=prior;status.textContent=error instanceof Error?error.message:'Could not update Telegram alerts.';}
        finally{toggle.disabled=false;}
      });
      linkButton.addEventListener('click',async function(){
        const wallet=window.__FLOATSHEETS_WALLET__;
        if(!wallet?.connected||typeof wallet.startTelegramAlertLink!=='function'){status.textContent='Connect your wallet on Robinhood Chain first.';return;}
        linkButton.disabled=true; status.textContent='Confirm the wallet signature to create a one-time link…';
        try{
          const result=await wallet.startTelegramAlertLink();
          const open=telegramRow.querySelector('#liquidation-telegram-open'); open.href=result.link_url; open.hidden=false;
          status.textContent='Open Telegram, then tap Start. This one-time link expires in 10 minutes.';
          if(window.__FLOATSHEETS_TELEGRAM_LINK_POLL__)clearInterval(window.__FLOATSHEETS_TELEGRAM_LINK_POLL__);
          let checking=false; const started=Date.now();
          window.__FLOATSHEETS_TELEGRAM_LINK_POLL__=setInterval(async function(){
            if(checking)return; checking=true;
            try{
              const state=await wallet.getTelegramAlertLinkStatus(result.token);
              if(state.linked){clearInterval(window.__FLOATSHEETS_TELEGRAM_LINK_POLL__);window.__FLOATSHEETS_TELEGRAM_LINK_POLL__=null;const pref={enabled:true,username:state.telegram_username||null};localStorage.setItem('floatsheets-liquidation-telegram-'+wallet.address.toLowerCase(),JSON.stringify(pref));toggle.disabled=false;toggle.checked=true;linked.textContent=pref.username?'Linked as '+pref.username:'Telegram linked';status.textContent='Telegram linked and liquidation alerts enabled.';open.hidden=true;linkButton.disabled=false;}
              else if(Date.now()-started>10*60*1000){clearInterval(window.__FLOATSHEETS_TELEGRAM_LINK_POLL__);window.__FLOATSHEETS_TELEGRAM_LINK_POLL__=null;status.textContent='Link expired. Start again to get a new one-time link.';linkButton.disabled=false;}
            }catch(error){clearInterval(window.__FLOATSHEETS_TELEGRAM_LINK_POLL__);window.__FLOATSHEETS_TELEGRAM_LINK_POLL__=null;status.textContent=error instanceof Error?error.message:'Could not check Telegram link status.';linkButton.disabled=false;}
            finally{checking=false;}
          },2500);
        }catch(error){status.textContent=error instanceof Error?error.message:'Could not create Telegram link.';linkButton.disabled=false;}
      });
    }
    if(!window.__FLOATSHEETS_EMAIL_ALERTS_RESULT_LISTENER__){
      window.__FLOATSHEETS_EMAIL_ALERTS_RESULT_LISTENER__=function(event){const status=document.getElementById('liquidation-alert-status');if(status)status.textContent=event.detail?.message||'Email alert settings updated.';const input=document.getElementById('liquidation-alert-email'),toggle=document.getElementById('liquidation-alert-enabled');if(event.detail?.verified&&toggle)toggle.checked=true;if(event.detail?.enabled===true&&toggle)toggle.checked=true;if(event.detail?.enabled===false&&toggle)toggle.checked=false;if(event.detail?.verified&&event.detail?.email&&input)input.value=event.detail.email;};
      window.addEventListener('floatsheets-email-alerts-result',window.__FLOATSHEETS_EMAIL_ALERTS_RESULT_LISTENER__);
      if(window.__FLOATSHEETS_EMAIL_ALERTS_RESULT__){window.__FLOATSHEETS_EMAIL_ALERTS_RESULT_LISTENER__({detail:window.__FLOATSHEETS_EMAIL_ALERTS_RESULT__});window.__FLOATSHEETS_EMAIL_ALERTS_RESULT__=null;}
    }
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
      root.innerHTML='<section class="panel live-only-panel legacy-trading-overlay" role="status"><div class="legacy-trading-copy"><span class="pill">FLOATSHEETS SILVERLAKE</span><h1>New trades use Goldlake.</h1><p>New positions and deposits are disabled. You can manage existing Silverlake positions from Portfolio and withdraw existing Silverlake liquidity from Vault. Select Goldlake for new positions and deposits.</p><div class="legacy-trading-actions"><button type="button" class="small-btn" data-switch-goldlake>Switch to Goldlake</button><a class="small-btn" href="#portfolio">Open portfolio</a><a class="small-btn" href="#vault">Open vault</a></div></div></section>';
      root.querySelector('[data-switch-goldlake]').addEventListener('click',function(){localStorage.setItem('floatsheets-contract-version-v1','goldlake');window.dispatchEvent(new CustomEvent('floatsheets-contract-version-change',{detail:{version:'goldlake'}}));});
      return true;
    }
    if(version!=='legacy-orion'||!['trade','portfolio','oracle','listings'].includes(view))return false;
    root.innerHTML='<section class="panel live-only-panel legacy-trading-overlay" role="status" aria-labelledby="legacy-trading-title"><div class="legacy-trading-mark" aria-hidden="true">i</div><div class="legacy-trading-copy"><span class="pill">FLOATSHEETS LEGACY ORION</span><h1 id="legacy-trading-title">Trading is disabled on Orion.</h1><p>New positions and deposits are disabled. You can still use the vault to view your liquidity, claim completed requests and withdraw your existing shares. Switch to FloatSheets Goldlake for new trading and deposits.</p><div class="legacy-trading-actions"><button type="button" class="small-btn" data-switch-goldlake>Switch to Goldlake</button><a class="small-btn" href="#vault">Open vault</a><a class="legacy-settings-link" href="#settings">Version settings</a></div></div></section>';
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
  function paintCorporateAction(action){
    const stats=root.querySelector('.chart-stats');
    if(!stats)return;
    let notice=root.querySelector('#corporate-action-notice');
    if(!action){notice?.remove();return;}
    if(!notice){notice=document.createElement('div');notice.id='corporate-action-notice';notice.className='info-note action-note';notice.setAttribute('role','status');stats.parentElement.insertBefore(notice,stats);}
    const title=action.kind==='split'?(action.ratio?escapeHtml(action.ratio)+' split':'Stock split'):'Ex-dividend $'+escapeHtml(Number(action.amount_usd).toFixed(2));
    const when=new Date(action.ex_date+'T12:00:00').toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'});
    const change=action.expected_price_change_pct===null?'':' · expected price change '+(action.expected_price_change_pct>0?'+':'')+escapeHtml(action.expected_price_change_pct)+'%';
    const status=action.close_only?' <strong class="action-close-only">Close-only now.</strong>':action.close_only_from?' Close-only from '+new Date(action.close_only_from).toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+'.':'';
    notice.innerHTML='<strong>📅 '+title+' · '+when+change+'</strong> '+escapeHtml(action.summary)+status;
  }
  function paintOpeningBell(bell,symbol){
    const stats=root.querySelector('.chart-stats');
    if(!stats)return;
    let notice=root.querySelector('#opening-bell-notice');
    clearInterval(window.__FLOATSHEETS_BELL_TIMER__);
    if(!bell){notice?.remove();return;}
    if(!notice){notice=document.createElement('div');notice.id='opening-bell-notice';notice.className='info-note bell-note';notice.setAttribute('role','status');stats.parentElement.insertBefore(notice,stats);}
    const endsAt=new Date(bell.ends_at).getTime();
    const ticket=bell.max_ticket_usdg?'$'+Number(bell.max_ticket_usdg).toLocaleString(undefined,{maximumFractionDigits:0}):'half size';
    const paint=function(){
      const left=Math.max(0,Math.round((endsAt-Date.now())/1000));
      if(left===0){clearInterval(window.__FLOATSHEETS_BELL_TIMER__);notice.remove();return;}
      notice.innerHTML='<strong>🔔 Opening bell · '+Math.floor(left/60)+':'+String(left%60).padStart(2,'0')+' left</strong> The real '+escapeHtml(symbol||'')+' just opened and is repricing faster than its pool. Until '+new Date(endsAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+', new positions pay +'+escapeHtml(bell.extra_spread_bps)+' bps and are limited to '+ticket+' per ticket, so nobody can trade the vault at a stale price. Closing is unchanged.';
    };
    paint();
    window.__FLOATSHEETS_BELL_TIMER__=setInterval(paint,1000);
  }
  async function paintWeekendAllowance(notice,symbol){
    const wallet=walletState(),api=window.__FLOATSHEETS_SERVER_API__;
    if(!wallet?.connected||!wallet.address||!api?.getWeekendAllowance)return;
    try{
      const payload=await api.getWeekendAllowance(symbol,wallet.address,selectedContractVersion());
      const allowance=payload&&payload.allowance;
      if(!allowance||!notice.isConnected)return;
      const usd=function(value){return '$'+Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});};
      const cooldown=allowance.cooldown_until?' Next weekend open available at '+new Date(allowance.cooldown_until).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+'.':'';
      let line=notice.querySelector('.weekend-allowance');
      if(!line){line=document.createElement('span');line.className='weekend-allowance';notice.appendChild(line);}
      line.innerHTML=' <strong>Your weekend allowance on '+escapeHtml(allowance.market)+': '+usd(allowance.remaining_usdg)+' of '+usd(allowance.cap_usdg)+' left.</strong>'+cooldown;
    }catch(error){console.warn('FloatSheets weekend allowance failed',error);}
  }
  function paintWeekendBand(band){
    const stats=root.querySelector('.chart-stats');
    if(!stats)return;
    let notice=root.querySelector('#weekend-band-notice');
    if(!band){notice?.remove();return;}
    if(!notice){notice=document.createElement('div');notice.id='weekend-band-notice';notice.className='info-note band-note';notice.setAttribute('role','status');stats.parentElement.insertBefore(notice,stats);}
    const usd=function(value){return '$'+Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});};
    const reopens=new Date(band.reopens_at).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'});
    const width=(band.band_bps/100).toLocaleString(undefined,{maximumFractionDigits:2});
    const shifted=band.shifts_up||band.shifts_down?' The band has shifted '+(band.shifts_up?band.shifts_up+'× up':'')+(band.shifts_up&&band.shifts_down?' and ':'')+(band.shifts_down?band.shifts_down+'× down':'')+' after a sustained move.':'';
    const position=band.pool_outside?'<strong class="band-outside">Pool is trading '+escapeHtml(band.pool_outside)+' the band at '+usd(band.pool_price_usdg)+'.</strong> New positions are paused until it returns; you can still close.':'Pool price '+(band.pool_price_usdg?usd(band.pool_price_usdg)+' is inside the band.':'is inside the band.');
    notice.innerHTML='<strong>Weekend band · '+usd(band.lower_usdg)+' – '+usd(band.upper_usdg)+'</strong> (±'+width+'% around the last close of '+usd(band.anchor_price_usdg)+'). The real stock is closed until '+escapeHtml(reopens)+'. Oracle marks stay inside this band, so a thin-liquidity wick cannot liquidate you. '+position+shifted;
    void paintWeekendAllowance(notice,band.symbol);
  }
  function paintExchangeHalt(halt){
    const stats=root.querySelector('.chart-stats');
    if(!stats)return;
    let notice=root.querySelector('#exchange-halt-notice');
    if(!halt){notice?.remove();return;}
    if(!notice){notice=document.createElement('div');notice.id='exchange-halt-notice';notice.className='info-note halt-note';notice.setAttribute('role','status');stats.parentElement.insertBefore(notice,stats);}
    const since=new Date(halt.halted_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
    const resumes=halt.resumption_trade_at?'Trading resumes at '+new Date(halt.resumption_trade_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+'.':'No resumption time announced yet.';
    notice.innerHTML='<strong>'+escapeHtml(halt.symbol)+' is halted on '+escapeHtml(halt.listing_market)+'</strong> since '+since+' · '+escapeHtml(halt.reason)+' ('+escapeHtml(halt.reason_code)+'). While the real stock cannot trade, FloatSheets pauses new positions on this market. You can still close. '+resumes;
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
      stateValue.textContent=data.state==='LIVE'?'LIVE':data.state==='READY'?'READY':data.state==='HALTED'?'HALTED':data.state==='EXCHANGE_HALT'?'EXCHANGE HALT':data.state==='CORPORATE_ACTION'?'CORPORATE ACTION':data.state==='WEEKEND_BAND'?'WEEKEND BAND':data.state==='CLOSE_ONLY'?'CLOSE ONLY':'UNAVAILABLE';
      stateValue.title=data.state==='READY'?'A current oracle price is published when you request a quote.':data.exchange_halt?'Halted on '+data.exchange_halt.listing_market+': '+data.exchange_halt.reason:'Current on-chain market and oracle check';
    }
    paintExchangeHalt(data.exchange_halt);
    paintCorporateAction(data.corporate_action);
    paintWeekendBand(data.exchange_halt?null:data.weekend_band);
    paintOpeningBell(data.exchange_halt?null:data.opening_bell,data.market);
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
