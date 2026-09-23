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
      const fragment=document.createDocumentFragment();
      String(textNode.nodeValue).split(/(USDG|ETH)/g).forEach(function(part){
        if(!icon[part]) { fragment.append(document.createTextNode(part)); return; }
        const wrap=document.createElement('span'); wrap.className='asset-ref';
        const image=document.createElement('img'); image.src=icon[part]; image.alt=part; wrap.append(image,document.createTextNode(part)); fragment.append(wrap);
      });
      textNode.parentNode?.replaceChild(fragment,textNode);
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

  render=function(){
    originalRender();
    removeSimulationControls();
    genuinePageContent();
    decorateAssets();
    installThemeToggle();
    window.__FLOATSHEETS_INSTALL_WALLET__?.();
  };
  // Discard any local design-time account state before the first live render.
  state={balance:0,positions:[],orders:[],activity:[],nominations:[],vault:0,staked:0,float:0,preferences:{notifications:true,reduced:false},name:'Trading account'};
  save=function(){};
  render();
})();
