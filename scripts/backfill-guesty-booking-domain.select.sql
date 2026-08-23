-- NOT EXECUTED — prepared for the next step (backfill).
-- Identifies villanet-enabled listings whose guesty_booking_domain is null/empty
-- or invalid (legacy book.guesty.com, or any host not on *.guestybookings.com).
--
-- Expected ~55+ rows with null today; also catches any non-guestybookings values
-- if they appear later. Review before running an UPDATE.

SELECT
  listing_id,
  name,
  guesty_booking_domain,
  CASE
    WHEN guesty_booking_domain IS NULL OR btrim(guesty_booking_domain) = '' THEN 'null_or_empty'
    WHEN lower(guesty_booking_domain) LIKE '%book.guesty.com%' THEN 'legacy_book_guesty'
    ELSE 'non_guestybookings_host'
  END AS invalid_reason
FROM listings
WHERE villanet_enabled = true
  AND (
    guesty_booking_domain IS NULL
    OR btrim(guesty_booking_domain) = ''
    OR lower(guesty_booking_domain) LIKE '%book.guesty.com%'
    OR lower(
         regexp_replace(
           regexp_replace(btrim(guesty_booking_domain), '^https?://', '', 'i'),
           '/.*$',
           ''
         )
       ) NOT LIKE '%guestybookings.com'
  )
ORDER BY invalid_reason, name;

-- Optional count:
-- SELECT COUNT(*) FROM ( ... same WHERE ... ) AS invalid_listings;
