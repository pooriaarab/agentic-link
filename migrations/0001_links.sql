-- One row per short link. c is ciphertext the Worker cannot read.
CREATE TABLE links (
  id TEXT PRIMARY KEY,
  c TEXT NOT NULL,
  iv TEXT NOT NULL,
  exp INTEGER NOT NULL
);
CREATE INDEX links_exp ON links (exp);

-- One row per address per UTC day. h is a keyed hash, never the address.
CREATE TABLE brakes (
  h TEXT NOT NULL,
  day INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (h, day)
);
