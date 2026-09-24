import { describe, expect, test } from 'bun:test';
import '../public/dashboard/market-chart.js';
import { liquidationPrice, unrealizedPnl } from '../src/lib/pnl';

const { readCandles } = (globalThis as any).FloatSheetsMarketChart;
const E18=10n**18n, USDG=10n**6n;
describe('liquidation price estimate',()=>{
  test('long and short use maintenance on current notional, not entry notional',()=>{
    expect(liquidationPrice(E18,100n*E18,20n*USDG,500n)).toBe(80n*E18*10000n/9500n);
    expect(liquidationPrice(-E18,100n*E18,20n*USDG,500n)).toBe(120n*E18*10000n/10500n);
  });
  test('margin additions move liquidation away and withdrawals/fees move it closer',()=>{
    for(const size of [E18,-E18]){
      const base=liquidationPrice(size,100n*E18,20n*USDG,500n)!;
      const more=liquidationPrice(size,100n*E18,30n*USDG,500n)!;
      const less=liquidationPrice(size,100n*E18,19940000n,500n)!;
      expect(size>0n?more<base:more>base).toBe(true);
      expect(size>0n?less>base:less<base).toBe(true);
    }
  });
  test('closed positions and fully collateralized longs have no positive boundary',()=>{
    expect(liquidationPrice(0n,0n,0n,0n)).toBeNull();
    expect(liquidationPrice(E18,100n*E18,100n*USDG,500n)).toBeNull();
    expect(liquidationPrice(E18,100n*E18,150n*USDG,500n)).toBeNull();
    expect(liquidationPrice(-E18,100n*E18,100n*USDG,500n)).not.toBeNull();
  });
  test('rejects invalid on-chain config instead of displaying invented risk',()=>{
    for(const bps of [0n,10000n,-1n])expect(()=>liquidationPrice(E18,E18,USDG,bps)).toThrow();
    expect(()=>liquidationPrice(E18,0n,USDG,500n)).toThrow();
    expect(()=>liquidationPrice(E18,E18,-1n,500n)).toThrow();
  });
  test('both sides of estimate agree with contract eligibility, allowing USDG rounding',()=>{
    for(const size of [E18,-E18,800000000000000n,-800000000000000n]){
      const q=size<0n?-size:size, entry=147828300000000000000n;
      const margin=q*entry/10n**30n/5n, bps=500n;
      const level=liquidationPrice(size,entry,margin,bps)!;
      const meets=(price:bigint)=>{
        const equity=margin+unrealizedPnl(size,entry,price);
        const floored=equity<0n?0n:equity;
        return floored >= q*price/10n**30n*bps/10000n;
      };
      const difference=10n**32n/q; // $0.0001 of notional; larger than micro-USDG rounding.
      expect(meets(level+(size>0n?difference:-difference))).toBe(true);
      expect(meets(level+(size>0n?-difference:difference))).toBe(false);
    }
  });
});
describe('recorded candle data',()=>{
  const point=(seconds:number,price:string)=>({observed_at:new Date(seconds*1000).toISOString(),twap_price_usdg:price});
  test('aggregates time-ordered snapshots into genuine OHLC and leaves missing minutes empty',()=>{
    const candles=readCandles({points:[point(35,'12'),point(5,'10'),point(50,'9'),point(45,'8'),point(181,'11')]},'1H');
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({time:0,observed:50000,open:10,high:12,low:8,close:9});
    expect(candles[1].time).toBe(180000);
  });
  test('invalid points are omitted; zero/one point is safe',()=>{
    expect(readCandles({points:[]},'1H')).toEqual([]);
    expect(readCandles({points:[point(1,'0'),point(2,'NaN'),{observed_at:'bad',twap_price_usdg:'9'},point(3,'3')]},'1H')).toHaveLength(1);
  });
  test('uses server OHLC without aggregating it a second time',()=>{
    const candle={time:new Date(0).toISOString(),last_observed_at:new Date(59000).toISOString(),open:'10',high:'15',low:'8',close:'12'};
    expect(readCandles({candles:[candle]},'1H')[0]).toEqual({time:0,observed:59000,open:10,high:15,low:8,close:12});
    expect(readCandles({candles:[{...candle,high:'7'}]},'1H')).toEqual([]);
  });
  test('each selected range has appropriate candle widths',()=>{
    const points=[point(1,'1'),point(62,'2'),point(301,'3'),point(901,'4')];
    expect(readCandles({points},'1H')).toHaveLength(4);
    expect(readCandles({points},'4H')).toHaveLength(3);
    expect(readCandles({points},'1D')).toHaveLength(2);
    expect(readCandles({points},'1W')).toHaveLength(1);
  });
});
