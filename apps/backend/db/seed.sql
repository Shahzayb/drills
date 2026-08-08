-- Development seed. NOT a migration: fixtures have no business in the
-- pgmigrations ledger, and this must never run in CI or production.
--
-- Run with `pnpm db:seed` from the repo root. Re-runnable — it truncates first.
--
-- Plain sequential INSERTs inside one transaction, not a chain of data-modifying
-- CTEs. Later statements in a transaction see what earlier ones wrote, so each
-- insert can just look its parents up by name; CTEs would all share one snapshot
-- and could not. No id is hard-coded anywhere.

BEGIN;

TRUNCATE messages, conversations, memberships, users, organizations
  RESTART IDENTITY CASCADE;

INSERT INTO organizations (name, plan) VALUES
  ('Northwind Support', 'pro'),
  ('Acme Feedback',     'free');

INSERT INTO users (name) VALUES
  ('Ada Okafor'),
  ('Bruno Sato'),
  ('Chen Wei'),
  ('Dalia Haddad');

-- Ada and Bruno are in both orgs. Card 07 wants at least one identity that spans
-- tenants — a leak that only shows up for a shared user is exactly the one a
-- single-org fixture would hide.
INSERT INTO memberships (user_id, org_id, role)
SELECT u.id, o.id, v.role
FROM (VALUES
  ('Ada Okafor',   'Northwind Support', 'admin'),
  ('Bruno Sato',   'Northwind Support', 'editor'),
  ('Chen Wei',     'Northwind Support', 'editor'),
  ('Dalia Haddad', 'Acme Feedback',     'admin'),
  ('Ada Okafor',   'Acme Feedback',     'editor'),
  ('Bruno Sato',   'Acme Feedback',     'editor')
) AS v (user_name, org_name, role)
JOIN users         u ON u.name = v.user_name
JOIN organizations o ON o.name = v.org_name;

-- Conversations have no natural key — the schema gives them a uuid and nothing
-- else to grab them by — so the seed names them here and takes the uuid from
-- the column default's own function. The labels never reach the database.
CREATE TEMP TABLE seed_conversations (
  label         text PRIMARY KEY,
  id            uuid NOT NULL DEFAULT uuidv7(),
  org_name      text NOT NULL,
  status        text NOT NULL,
  assignee_name text,
  age_minutes   int  NOT NULL
) ON COMMIT DROP;

INSERT INTO seed_conversations (label, org_name, status, assignee_name, age_minutes) VALUES
  ('billing-double-charge', 'Northwind Support', 'open',   'Ada Okafor',    2880),
  ('csv-export-truncated',  'Northwind Support', 'open',   'Bruno Sato',     600),
  ('sso-safari-loop',       'Northwind Support', 'closed', NULL,           10080),
  ('dark-mode-request',     'Acme Feedback',     'open',   'Dalia Haddad',   120);

-- created_at is backdated so an inbox sort has something to sort. The uuid ids
-- are NOT backdated with it — uuidv7 embeds *insert* time, so id order and
-- created_at order disagree here on purpose. Worth remembering before treating
-- the PK as a chronological cursor.
INSERT INTO conversations (id, org_id, status, assignee_id, created_at, updated_at)
SELECT
  s.id,
  o.id,
  s.status,
  mem.id,
  now() - make_interval(mins => s.age_minutes),
  now() - make_interval(mins => s.age_minutes / 2)
FROM seed_conversations s
JOIN organizations o ON o.name = s.org_name
LEFT JOIN users u   ON u.name = s.assignee_name
LEFT JOIN memberships mem ON mem.org_id = o.id AND mem.user_id = u.id;

-- org_id comes off the conversation rather than being looked up by name again.
-- That is the denormalization working as intended: whoever holds the
-- conversation already holds the tenant.
INSERT INTO messages (conversation_id, org_id, message, created_at, updated_at)
SELECT
  c.id,
  c.org_id,
  v.message,
  now() - make_interval(mins => v.age_minutes),
  now() - make_interval(mins => v.age_minutes)
FROM (VALUES
  ('billing-double-charge', 'We were billed twice on the 3rd - same amount, two charges.',           2880),
  ('billing-double-charge', 'Confirmed a duplicate authorisation on our side. Refunding today.',     2820),
  ('billing-double-charge', 'The refund has not landed yet. Any ETA?',                                 90),
  ('csv-export-truncated',  'CSV export stops at 1000 rows with no warning.',                         600),
  ('csv-export-truncated',  'Reproduced. It is a pagination default, not a size limit.',              540),
  ('sso-safari-loop',       'Safari bounces between the IdP and the app forever.',                  10080),
  ('sso-safari-loop',       'Third-party cookie policy. Fixed by moving to a first-party callback.',  9000),
  ('dark-mode-request',     'Our team works nights. Dark mode would genuinely help.',                  120)
) AS v (label, message, age_minutes)
JOIN seed_conversations s ON s.label = v.label
JOIN conversations      c ON c.id = s.id;

COMMIT;

SELECT 'organizations' AS table_name, count(*) FROM organizations
UNION ALL SELECT 'users',         count(*) FROM users
UNION ALL SELECT 'memberships',   count(*) FROM memberships
UNION ALL SELECT 'conversations', count(*) FROM conversations
UNION ALL SELECT 'messages',      count(*) FROM messages;
