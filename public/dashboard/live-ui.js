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
    root.querySelectorAll('p,span').forEach(function(el){
      el.textContent=el.textContent.replace(/fictional markets/gi,'live markets').replace(/virtual (account )?balance/gi,'wallet collateral').replace(/Illustrative equity market/gi,'Robinhood Chain market').replace(/24h change · sample/gi,'24h change · live feed');
    });
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
    decorateAssets();
    installThemeToggle();
  };
  // Discard any local design-time account state before the first live render.
  state={balance:0,positions:[],orders:[],activity:[],nominations:[],vault:0,staked:0,float:0,preferences:{notifications:true,reduced:false},name:'Trading account'};
  save=function(){};
  render();
})();
