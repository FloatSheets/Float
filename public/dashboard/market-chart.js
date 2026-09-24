(function(){
  const intervals = { '1H': 60, '4H': 300, '1D': 900, '1W': 7200, '1M': 28800 };
  function readCandles(payload, range){
    if (Array.isArray(payload.candles)) {
      return payload.candles.map(c => ({
        time: new Date(c.time).getTime(), observed: new Date(c.last_observed_at || c.time).getTime(),
        open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
      })).filter(c => [c.time,c.observed,c.open,c.high,c.low,c.close].every(Number.isFinite)
        && c.low > 0 && c.low <= Math.min(c.open,c.close) && c.high >= Math.max(c.open,c.close))
        .sort((a,b) => a.time-b.time);
    }
    // Backward compatibility while the API deployment rolls out.
    const buckets = new Map(), interval = (intervals[range] || 60)*1000;
    const points = (payload.points || []).map(p => ({time:new Date(p.observed_at).getTime(),price:Number(p.twap_price_usdg ?? p.spot_price_usdg)}))
      .filter(p => Number.isFinite(p.time) && Number.isFinite(p.price) && p.price>0).sort((a,b)=>a.time-b.time);
    for (const p of points) {
      const time=Math.floor(p.time/interval)*interval, c=buckets.get(time);
      if(c){c.high=Math.max(c.high,p.price);c.low=Math.min(c.low,p.price);c.close=p.price;c.observed=p.time;}
      else buckets.set(time,{time,observed:p.time,open:p.price,high:p.price,low:p.price,close:p.price});
    }
    return [...buckets.values()];
  }
  function priceText(value){
    return value.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:value<1?8:4});
  }
  function create(canvas){
    const wrap=canvas.parentElement;
    wrap.classList.add('candlestick-chart');
    wrap.querySelector('.chart-tooltip')?.remove();
    const header=document.createElement('div'); header.className='candle-header';
    header.innerHTML='<div class="candle-price"></div><div class="candle-change"></div><div class="candle-ohlc"></div>';
    wrap.prepend(header);
    const status=document.createElement('div'); status.className='candle-status'; status.setAttribute('role','status'); wrap.append(status);
    const risk=document.createElement('div'); risk.className='candle-risk'; wrap.append(risk);
    const ctx=canvas.getContext('2d');
    let candles=[], interval=60000, range='1H', liquidation=null, hovered=null, hoverY=null, disposed=false;
    canvas.tabIndex=0;
    canvas.setAttribute('aria-label','Candlestick price history. Use left and right arrows to inspect candles.');
    function updateHeader(){
      const c=candles[hovered ?? candles.length-1];
      if(!c){header.querySelectorAll('div').forEach(el=>el.textContent='');return;}
      header.querySelector('.candle-price').textContent='$'+priceText(c.close);
      const change=c.close-candles[0].open, percentage=change/candles[0].open*100;
      const subtitle=header.querySelector('.candle-change'); subtitle.className='candle-change '+(change>=0?'is-up':'is-down');
      subtitle.textContent=(change>=0?'▲ +':'▼ −')+'$'+priceText(Math.abs(change))+' ('+(change>=0?'+':'−')+Math.abs(percentage).toFixed(2)+'%) · '+new Date(c.time).toLocaleString();
      const ohlc=header.querySelector('.candle-ohlc'); ohlc.replaceChildren();
      for(const [label,key] of [['Open','open'],['High','high'],['Low','low'],['Close','close']]){
        const item=document.createElement('span'), value=document.createElement('b');
        item.textContent=label+' ';value.textContent='$'+priceText(c[key]);item.append(value);ohlc.append(item);
      }
      canvas.setAttribute('aria-description',ohlc.textContent+' at '+new Date(c.time).toLocaleString());
    }
    function paint(){
      if(disposed || !canvas.isConnected || !ctx)return;
      const w=canvas.clientWidth,h=canvas.clientHeight;
      if(!w || !h)return;
      const dpr=window.devicePixelRatio||1;
      canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
      updateHeader();
      if(!candles.length)return;
      const dark=document.body.classList.contains('dashboard-dark'), muted=dark?'#a6b3c9':'#586b87', grid=dark?'#303a49':'#d7dfe9';
      ctx.font='11px '+getComputedStyle(canvas).fontFamily;
      const extrema=candles.flatMap(c=>[c.high,c.low]);if(liquidation)extrema.push(liquidation);
      const min=Math.min(...extrema),max=Math.max(...extrema),pad=Math.max((max-min)*.1,max*.001);
      const lo=Math.max(0,min-pad),hi=max+pad;
      const left=8,right=Math.min(w*.32,Math.max(62,ctx.measureText(priceText(hi)).width+16)),top=18,bottom=28,pw=w-left-right,ph=h-top-bottom;
      const start=candles[0].time-interval/2,end=candles[candles.length-1].time+interval/2;
      const X=t=>left+(t-start)/(end-start)*pw,Y=p=>top+(hi-p)/(hi-lo)*ph;
      ctx.fillStyle=grid;
      for(let x=left;x<=w-right;x+=24)for(let y=top;y<=h-bottom;y+=24){ctx.beginPath();ctx.arc(x,y,1,0,Math.PI*2);ctx.fill();}
      ctx.fillStyle=muted;ctx.textAlign='left';
      for(let i=0;i<5;i++)ctx.fillText(priceText(hi-i*(hi-lo)/4),w-right+8,top+i*ph/4+4);
      const body=Math.max(1,Math.min(12,pw*interval/(end-start)*.72));
      candles.forEach(c=>{
        const x=X(c.time),a=Y(c.open),b=Y(c.close),color=c.close>=c.open?'#18c77a':'#ff583f';
        ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,Y(c.high));ctx.lineTo(x,Y(c.low));ctx.stroke();ctx.fillStyle=color;
        ctx.beginPath();ctx.roundRect(x-body/2,Math.min(a,b),body,Math.max(1.5,Math.abs(a-b)),Math.min(2,body/2));ctx.fill();
      });
      function line(price,color,dash){ctx.strokeStyle=color;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(left,Y(price));ctx.lineTo(w-right,Y(price));ctx.stroke();ctx.setLineDash([]);}
      line(candles[candles.length-1].close,grid,[4,5]);
      if(liquidation){
        line(liquidation,'#ef635c',[6,4]);
        const label='Est. liquidation $'+priceText(liquidation),labelWidth=ctx.measureText(label).width+12;
        ctx.fillStyle=dark?'#311b23':'#fff0ee';ctx.fillRect(left,Y(liquidation)-17,Math.min(labelWidth,pw),17);
        ctx.fillStyle=dark?'#ff9c95':'#ab2923';ctx.textAlign='left';ctx.fillText(label,left+6,Y(liquidation)-5,pw-12);
      }
      ctx.fillStyle=muted;
      const ticks=w<480?3:5;
      for(let i=0;i<ticks;i++){
        const time=start+interval/2+i*Math.max(0,end-start-interval)/(ticks-1);
        ctx.textAlign=i===0?'left':i===ticks-1?'right':'center';
        ctx.fillText(new Date(time).toLocaleString([],range==='1W'||range==='1M'?{month:'short',day:'numeric'}:{hour:'2-digit',minute:'2-digit'}),X(time),h-6);
      }
      if(hovered!==null){
        const x=X(candles[hovered].time),y=hoverY===null?Y(candles[hovered].close):Math.max(top,Math.min(h-bottom,hoverY));
        ctx.strokeStyle=muted;ctx.lineWidth=.7;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,h-bottom);ctx.moveTo(left,y);ctx.lineTo(w-right,y);ctx.stroke();
      }
      canvas.onpointermove=function(event){
        const rect=canvas.getBoundingClientRect(),x=event.clientX-rect.left;
        const time=start+(x-left)/pw*(end-start);
        hovered=candles.reduce((best,c,i)=>Math.abs(c.time-time)<Math.abs(candles[best].time-time)?i:best,0);
        hoverY=event.clientY-rect.top;paint();
      };
    }
    canvas.onpointerleave=function(){hovered=null;hoverY=null;paint();};
    canvas.onkeydown=function(event){
      if(!candles.length || !['ArrowLeft','ArrowRight','Escape'].includes(event.key))return;
      event.preventDefault();hoverY=null;
      hovered=event.key==='Escape'?null:Math.max(0,Math.min(candles.length-1,(hovered??candles.length-1)+(event.key==='ArrowLeft'?-1:1)));paint();
    };
    const resize=new ResizeObserver(paint);resize.observe(wrap);
    const theme=new MutationObserver(paint);theme.observe(document.body,{attributes:true,attributeFilter:['class']});
    return {
      canvas,
      setData(payload,nextRange){
        candles=readCandles(payload,nextRange);range=nextRange;interval=(Number(payload.intervalSeconds)||intervals[range]||60)*1000;hovered=null;hoverY=null;
        const last=candles[candles.length-1];
        status.textContent=last?'Updated '+new Date(last.observed).toLocaleTimeString()+' · refreshes every 30s':'No recorded prices in this period.';
        if(last && Date.now()-last.observed>120000)status.textContent='Last price '+new Date(last.observed).toLocaleString()+' · waiting for an update';
        paint();
      },
      setPosition(position){
        const value=position?.liquidationPriceE18 ? Number(position.liquidationPriceE18)/1e18 : null;
        liquidation=value>0 && Number.isFinite(value)?value:null;
        risk.textContent=liquidation?'Estimated liquidation · based on your current margin. Actual liquidation depends on the oracle price and contract rounding.':position && BigInt(position.sizeE18)!==0n?'No positive liquidation price at your current margin.':'';
        paint();
      },
      loading(){if(!candles.length)status.textContent='Loading price history…';},
      unavailable(){status.textContent=candles.length?'Price update unavailable · showing last received prices. Retrying…':'Price history unavailable · retrying…';},
      destroy(){disposed=true;resize.disconnect();theme.disconnect();canvas.onpointermove=canvas.onpointerleave=canvas.onkeydown=null;header.remove();status.remove();risk.remove();},
    };
  }
  globalThis.FloatSheetsMarketChart={readCandles,create};
})();
