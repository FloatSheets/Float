(function(){
  const abs = value => value < 0n ? -value : value;
  function signedDecimal(raw, decimals = 6){
    const value = BigInt(raw), scale = 10n ** BigInt(decimals), magnitude = abs(value);
    return (value < 0n ? '−' : '+') + (magnitude / scale).toString() + '.' + (magnitude % scale).toString().padStart(decimals, '0');
  }
  function percentage(pnl, margin){
    const denominator = BigInt(margin);
    return denominator <= 0n ? '—' : signedDecimal(BigInt(pnl) * 100000000n / denominator) + '%';
  }
  globalThis.FloatSheetsPnlDisplay = { signedDecimal, percentage };
})();
