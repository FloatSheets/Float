// Public proof-of-solvency page. Reads /v1/solvency through the site's server bridge.
(function installSolvencyPage(){
  const root=document.getElementById('solvency-root');
  if(!root) return;
  // Client-side navigation can re-run this script; keep a single refresh timer.
  clearInterval(window.__FLOATSHEETS_SOLVENCY_TIMER__);
  const EXPLORER='https://robinhoodchain.blockscout.com/address/';

  function esc(value){return String(value??'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function usd(value,digits){const n=Number(value);return Number.isFinite(n)?'$'+n.toLocaleString(undefined,{minimumFractionDigits:digits??2,maximumFractionDigits:digits??2}):'—';}
  function pctText(value){return value===null||value===undefined?'—':Number(value).toLocaleString(undefined,{maximumFractionDigits:2})+'%';}
  function short(address){return address.slice(0,6)+'…'+address.slice(-4);}
  function link(address,label){return '<a class="solvency-link" href="'+EXPLORER+esc(address)+'" target="_blank" rel="noopener noreferrer">'+esc(label)+' · '+esc(short(address))+' ↗</a>';}
  function metric(label,value,note,featured){return '<div class="solvency-metric'+(featured?' featured':'')+'"><small>'+esc(label)+'</small><strong>'+value+'</strong>'+(note?'<span>'+note+'</span>':'')+'</div>';}
  function meter(used,cap){
    if(used===null||used===undefined) return '<div class="solvency-meter"><i style="width:0"></i></div>';
    const width=Math.min(100,Math.max(0,used));
    return '<div class="solvency-meter'+(used>=100?' full':used>=80?' high':'')+'" title="'+pctText(used)+' of the '+esc(cap)+' cap"><i style="width:'+width+'%"></i></div>';
  }

  function render(report){
    const headline=document.getElementById('solvency-headline'),updated=document.getElementById('solvency-updated');
    const v=report.vault,t=report.traders,r=report.risk,c=report.contracts;
    const badDebt=Number(t.bad_debt_usdg)>0;
    if(headline) headline.textContent=badDebt?'Bad debt outstanding.':t.margin_fully_backed?'Fully backed, on-chain.':'Margin shortfall detected.';
    if(updated) updated.textContent='Read from Robinhood Chain at '+new Date(report.generated_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'})+' · refreshes every 30 seconds';
    document.body.dataset.status=badDebt||!t.margin_fully_backed?'outage':'operational';

    const coverage=r.stress_coverage_ratio===null?'No net exposure':r.stress_coverage_ratio.toLocaleString(undefined,{maximumFractionDigits:1})+'× covered';
    const marketRows=report.markets.map(function(m){
      const priced=Number(m.price_usdg)>0;
      return '<tr><td><strong>'+esc(m.market)+'</strong>'+(m.oracle_circuit_broken?' <span class="status-pill degraded">BREAKER</span>':'')+'</td>'
        +'<td>'+(priced?usd(m.price_usdg):'<span class="solvency-muted">No mark yet</span>')+'</td>'
        +'<td>'+usd(m.long_open_interest_usdg,0)+'</td><td>'+usd(m.short_open_interest_usdg,0)+'</td>'
        +'<td>'+usd(m.skew_usdg,0)+(m.net_side?' <span class="solvency-muted">net '+esc(m.net_side)+'</span>':'')+'</td>'
        +'<td>'+meter(m.open_interest_cap_used_pct,r.market_open_interest_cap_pct+'% open interest')+'<span class="solvency-muted">'+pctText(m.open_interest_cap_used_pct)+'</span></td>'
        +'<td>'+meter(m.skew_cap_used_pct,r.market_skew_cap_pct+'% skew')+'<span class="solvency-muted">'+pctText(m.skew_cap_used_pct)+'</span></td></tr>';
    }).join('');

    root.innerHTML=
      '<section class="status-section"><span class="eyebrow">THE VAULT</span><h2>What backs every trade.</h2><div class="solvency-grid">'
        +metric('Vault NAV',usd(v.nav_usdg),'LP value, marked to open trader PnL',true)
        +metric('USDG held',usd(v.cash_usdg),'Balance of the vault contract')
        +metric('Insurance tranche',usd(v.insurance_usdg),'First-loss buffer, funded by borrow fees')
        +metric('Available liquidity',usd(v.available_liquidity_usdg),'After the market stress reserve')
        +metric('Owed to traders',usd(v.payouts_owed_usdg),'Deferred payouts queued under the hourly cap')
        +metric('Owed to withdrawing LPs',usd(v.withdrawals_owed_usdg),'Settled withdrawals not yet claimed')
        +metric('Deposits awaiting settlement',usd(v.pending_deposits_usdg),'Join the vault at the next daily epoch')
        +metric('Bad debt',usd(t.bad_debt_usdg),badDebt?'New positions pause until covered':'Losses never exceeded trader margin')
      +'</div><p class="solvency-links">'+link(c.vault,'Vault')+link(c.usdg,'USDG')+'</p></section>'
      +'<section class="status-section"><span class="eyebrow">TRADERS</span><h2>Margin is held, not promised.</h2><div class="solvency-grid">'
        +metric('Margin held',usd(t.margin_held_usdg),'USDG in the clearing house',true)
        +metric('Margin owed',usd(t.margin_owed_usdg),t.margin_fully_backed?'Fully backed by USDG held':'Shortfall: held is below owed')
        +metric('Open positions',String(t.open_positions),'Across all markets')
        +metric('Unrealized trader PnL',usd(t.unrealized_pnl_usdg),'Positive means traders are up')
      +'</div><p class="solvency-links">'+link(c.clearing_house,'Clearing house')+link(c.oracle,'Oracle')+'</p></section>'
      +'<section class="status-section"><span class="eyebrow">RISK</span><h2>Caps enforced by the contract.</h2><div class="solvency-grid">'
        +metric('Open interest',usd(r.open_interest_usdg),pctText(r.utilization_pct)+' of NAV · cap '+r.utilization_cap_pct+'%',true)
        +metric(r.stress_move_pct+'% stress loss',usd(r.stress_loss_usdg),'If every market moved '+r.stress_move_pct+'% against the vault')
        +metric('Stress coverage',coverage,'Free cash plus insurance vs the stress loss')
        +metric('Per-market caps',r.market_open_interest_cap_pct+'% / '+r.market_skew_cap_pct+'%','Open interest / one-sided skew, of NAV')
      +'</div><div class="table-scroll solvency-table"><table><thead><tr><th>Market</th><th>Oracle mark</th><th>Long OI</th><th>Short OI</th><th>Skew</th><th>OI cap used</th><th>Skew cap used</th></tr></thead><tbody>'+marketRows+'</tbody></table></div>'
      +'<p class="status-empty">Every figure on this page is a direct read of the contracts linked above. Open them on Blockscout and call the same functions to check it yourself.</p></section>';
  }

  async function refresh(){
    const api=window.__FLOATSHEETS_SERVER_API__;
    if(!api||!api.getSolvency) return;
    try{ render(await api.getSolvency()); }
    catch(error){
      console.warn('FloatSheets solvency failed',error);
      const updated=document.getElementById('solvency-updated');
      if(updated) updated.textContent='Chain data could not be loaded. Retrying…';
    }
  }
  void refresh();
  window.__FLOATSHEETS_SOLVENCY_TIMER__=setInterval(function(){
    if(!document.getElementById('solvency-root')){clearInterval(window.__FLOATSHEETS_SOLVENCY_TIMER__);return;}
    void refresh();
  },30000);
})();
