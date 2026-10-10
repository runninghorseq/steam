-- One-time backfill: copy each account's own country onto the friends rows that
-- point at it (friend_steam_id = accounts.steam_id). The upload/scan path now keeps
-- these in sync going forward (saveAccount / addAccountStub mirror a saved country
-- onto matching friends rows), but rows that predate that change are stale — usually
-- NULL — which the gift filters treat as giftable. Fill only the NULLs so we never
-- clobber a friend country that may already be set from another source.
UPDATE friends
   SET country = (SELECT a.country FROM accounts a
                   WHERE a.steam_id = friends.friend_steam_id
                     AND a.country IS NOT NULL AND a.country != ''),
       updated_at = unixepoch()
 WHERE friends.country IS NULL
   AND EXISTS (SELECT 1 FROM accounts a
                WHERE a.steam_id = friends.friend_steam_id
                  AND a.country IS NOT NULL AND a.country != '');
