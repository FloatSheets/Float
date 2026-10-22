-- On 2026-10-22 the backend integration suite was run once against the
-- production database. Remove only the rows those tests fabricate: the fake
-- keeper liquidation (transaction hash 0xabab...ab), zero-padded test traders,
-- and the two synthetic weekend-limit wallets. Keeper cursors that the tests
-- moved past the chain head are reset by the keeper itself.
DELETE FROM keeper_actions WHERE transaction_hash = '0x' || repeat('ab', 32);
DELETE FROM keeper_positions WHERE trader ~ '^0x0{38}[0-9a-f]{2}$';
DELETE FROM weekend_quotes WHERE trader IN ('0x00000000000000000000000000000000000000aa', '0x00000000000000000000000000000000000000bb');
