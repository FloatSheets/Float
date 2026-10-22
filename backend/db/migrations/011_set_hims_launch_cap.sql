-- Keep HIMS quote impact below its configured 80 bps maximum at the launch cap.
-- The contract's 25,000 USDG ceiling remains unchanged; backend quotes enforce
-- this lower operational cap until pool depth supports more size.
UPDATE markets
SET max_ticket_usdg = 15000, updated_at = now()
WHERE symbol = 'HIMS';
