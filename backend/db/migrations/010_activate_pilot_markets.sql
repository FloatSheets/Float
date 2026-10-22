-- QUBT and PLTR are enabled for new positions after quote monitoring was
-- corrected to evaluate notionals within each market's configured ticket cap.
UPDATE markets
SET status = 'active', updated_at = now()
WHERE symbol IN ('QUBT', 'PLTR')
  AND status IN ('pilot', 'restricted');
