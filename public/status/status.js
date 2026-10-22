// Public status page. Reads /v1/status through the site's server bridge.
(function installStatusPage(){
  const root=document.getElementById('status-root');
  if(!root) return;
  // Client-side navigation can re-run this script; keep a single refresh timer.
  clearInterval(window.__FLOATSHEETS_STATUS_TIMER__);
  const LABEL={operational:'Operational',degraded:'Degraded',outage:'Outage'};
  const HEADLINE={operational:'All systems operational.',degraded:'Some systems degraded.',outage:'Service disruption.'};
  const DAYS=90;

  function esc(value){return String(value??'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function when(iso){return new Date(iso).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
  function duration(minutes){
    if(minutes<60) return minutes+' min';
    const hours=Math.floor(minutes/60),rest=minutes%60;
    return hours<48?hours+' h'+(rest?' '+rest+' min':''):Math.round(hours/24)+' days';
  }

  function bar(days){
    const byDay=new Map(days.map(function(item){return [item.day,item.status];}));
    const cells=[];
    for(let i=DAYS-1;i>=0;i--){
      const day=new Date(Date.now()-i*86400000).toISOString().slice(0,10);
      const status=byDay.get(day)||'none';
      cells.push('<span class="status-day '+status+'" title="'+day+' · '+(status==='none'?'No data':LABEL[status])+'"></span>');
    }
    return '<div class="status-bar" aria-hidden="true">'+cells.join('')+'</div>';
  }

  function render(report){
    const headline=document.getElementById('status-headline'),updated=document.getElementById('status-updated');
    if(headline) headline.textContent=HEADLINE[report.overall]||'Checking every system.';
    if(updated) updated.textContent='Updated '+new Date(report.generated_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'})+' · refreshes every 30 seconds';
    document.body.dataset.status=report.overall;

    const components=report.components.map(function(item){
      const uptime=item.uptime_90d===null?'Collecting history':item.uptime_90d.toFixed(2)+'% uptime · 90 days';
      return '<div class="status-component"><div class="status-component-head"><strong>'+esc(item.name)+'</strong><span class="status-pill '+item.status+'">'+LABEL[item.status]+'</span></div>'
        +(item.detail?'<p class="status-detail">'+esc(item.detail)+'</p>':'')
        +bar(item.days)+'<div class="status-meta"><span>'+DAYS+' days ago</span><span>'+uptime+'</span><span>Today</span></div></div>';
    }).join('');

    const events=report.market_events.length
      ?report.market_events.map(function(event){return '<div class="status-event"><span class="status-pill degraded">'+esc(event.market)+'</span><p>'+esc(event.summary)+'</p></div>';}).join('')
      :'<p class="status-empty">No market restrictions right now. Every market is open for new positions, subject to its normal limits.</p>';

    const incidents=report.incidents.length
      ?report.incidents.map(function(incident){
        const open=!incident.resolved_at;
        return '<article class="status-incident'+(open?' open':'')+'"><div class="status-component-head"><strong>'+esc(incident.title)+'</strong><span class="status-pill '+(open?incident.severity:'resolved')+'">'+(open?'Ongoing':'Resolved')+'</span></div>'
          +'<p class="status-incident-time">'+when(incident.started_at)+(open?' · ongoing for ':' – '+when(incident.resolved_at)+' · lasted ')+duration(incident.duration_minutes)+'</p>'
          +(incident.detail?'<p class="status-detail">'+esc(incident.detail)+'</p>':'')
          +(incident.postmortem?'<div class="status-postmortem"><span class="eyebrow">POST-MORTEM</span><p>'+esc(incident.postmortem)+'</p></div>':'')+'</article>';
      }).join('')
      :'<p class="status-empty">No incidents recorded yet.</p>';

    root.innerHTML='<section class="status-section"><span class="eyebrow">COMPONENTS</span><h2>What FloatSheets depends on.</h2><div class="status-components">'+components+'</div>'
      +'<div class="status-legend"><span><i class="status-day operational"></i>Operational</span><span><i class="status-day degraded"></i>Degraded</span><span><i class="status-day outage"></i>Outage</span><span><i class="status-day none"></i>No data</span></div></section>'
      +'<section class="status-section"><span class="eyebrow">MARKET RESTRICTIONS</span><h2>Halts, splits and dividends.</h2>'+events+'</section>'
      +'<section class="status-section"><span class="eyebrow">INCIDENT HISTORY</span><h2>Opened and resolved automatically.</h2>'+incidents+'</section>';
  }

  async function refresh(){
    const api=window.__FLOATSHEETS_SERVER_API__;
    if(!api||!api.getStatus) return;
    try{ render(await api.getStatus()); }
    catch(error){
      console.warn('FloatSheets status failed',error);
      const updated=document.getElementById('status-updated');
      if(updated) updated.textContent='Status could not be loaded. Retrying…';
    }
  }
  void refresh();
  window.__FLOATSHEETS_STATUS_TIMER__=setInterval(function(){
    if(!document.getElementById('status-root')){clearInterval(window.__FLOATSHEETS_STATUS_TIMER__);window.__FLOATSHEETS_STATUS_TIMER__=null;return;}
    void refresh();
  },30000);
})();
