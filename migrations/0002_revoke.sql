-- owner is a keyed hash of the creator's owner key, never the key. NULL means
-- only an admin can revoke. revoked is a tombstone: the row stays after the
-- sweep so an id is never reused, and c and iv are emptied when it is set.
ALTER TABLE links ADD COLUMN owner TEXT;
ALTER TABLE links ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0;
CREATE INDEX links_owner ON links (owner);
