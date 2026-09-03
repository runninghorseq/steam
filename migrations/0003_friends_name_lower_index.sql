-- /api/friends/country matches friends case-insensitively:
--     WHERE lower(friend_name) = lower(?)
-- The existing idx_friends_name is on the RAW column, so SQLite/libSQL cannot use
-- it for the lower() expression — each lookup full-scanned the entire friends
-- table (~27k rows). Across a country file that's millions of row reads in one
-- request, which is what blew D1's daily read limit and 500'd the endpoint.
--
-- This expression index matches the query exactly, turning each lookup into an
-- index seek. friend_steam_id lookups are already covered by idx_friends_steamid.
CREATE INDEX IF NOT EXISTS idx_friends_name_lower ON friends (lower(friend_name));
