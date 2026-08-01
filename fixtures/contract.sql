-- Generic contract-test fixture: enough structure to exercise the semantic
-- surfaces the app renders — COMMENTs with @ai/@policy tags, an FK with its
-- own COMMENT (relationship meaning), a view (lineage + concept), and an enum.
-- Deliberately generic sample data; carries no real-world schema.

CREATE TYPE order_status AS ENUM ('draft', 'placed', 'shipped', 'cancelled');
COMMENT ON TYPE order_status IS 'Lifecycle of a customer order.';

CREATE TABLE customers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE,
  -- A calendar date, which the PostgreSQL driver would parse into a Date at
  -- local midnight: enough for a test to tell "the value" apart from "an
  -- instant derived from the value".
  birthday date,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE customers IS 'People who buy from the store.
@ai: One row per customer. Use email as the natural lookup key.
@policy: Never expose email addresses in aggregated reports.';
COMMENT ON COLUMN customers.email IS 'Unique contact address.
@ai: may be NULL for walk-in customers.';

CREATE TABLE orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL,
  status order_status NOT NULL DEFAULT 'draft',
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  placed_at timestamptz,
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)
);
COMMENT ON TABLE orders IS 'Customer orders.
@ai: total_cents is in cents; divide by 100 for display currency.';
COMMENT ON CONSTRAINT orders_customer_fk ON orders IS 'The customer who placed this order.';

-- A relation with no primary key. kozou offers it no page cursors (there is no
-- total order to walk) and no item route (there is no id to address a row by),
-- so the desktop browses it a page at a time and offers no row editor.
--
-- It also carries one column of each remaining temporal type, so a test can
-- pin how they cross the wire: the driver parses this whole family into
-- JavaScript objects that do not convert back, and the row-data pool overrides
-- that (see src/worker/runData.ts).
CREATE TABLE audit_log (
  at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  noted_at timestamp,
  shift_start time,
  span interval
);
COMMENT ON TABLE audit_log IS 'Append-only trail of actions, with no primary key.
@ai: There is no key here; correlate by timestamp.';

-- A table keyed by text long enough that a browse page must shorten it. What is
-- shown is then the BEGINNING of a key, which can be another row's key in full,
-- so such a row cannot be addressed at all.
CREATE TABLE long_key (
  k text PRIMARY KEY,
  note text
);
COMMENT ON TABLE long_key IS 'Keyed by a text value larger than a browse page will carry.';
INSERT INTO long_key (k, note) VALUES (repeat('k', 1100), 'key longer than the wire budget');

CREATE VIEW recent_orders AS
SELECT o.id, c.name AS customer_name, o.status, o.total_cents, o.placed_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.placed_at > now() - interval '30 days';
COMMENT ON VIEW recent_orders IS 'Orders placed in the last 30 days, with customer names resolved.
@ai: Prefer this view over joining orders/customers by hand for recency questions.
@policy: Totals here are gross amounts, before refunds.';

-- A MATERIALIZED view, carrying the two tag forms the context builder lifts OUT
-- of `description`: an `@example:` block on the relation and `@widget:` on a
-- column. Both are load-bearing for the comment editor:
--
--   * relkind. Introspection reports 'v' and 'm' as one kind, but the DDL does
--     not: `COMMENT ON VIEW` is an error against this relation. The desktop
--     reads the distinction with its own catalog query.
--   * verbatim text. An editor seeded from `description` would delete the
--     `@example:` block and the `@widget:` tag on the first save, because
--     neither survives into that field.
CREATE MATERIALIZED VIEW customer_totals AS
SELECT c.id AS customer_id,
       c.name,
       count(o.id) AS order_count,
       coalesce(sum(o.total_cents), 0) AS total_cents
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.name;
COMMENT ON MATERIALIZED VIEW customer_totals IS 'Per-customer order totals.
@ai: Materialized - the numbers are as of the last REFRESH, not live.
@example: Biggest spenders
  SELECT name, total_cents FROM customer_totals ORDER BY total_cents DESC LIMIT 10;';
COMMENT ON COLUMN customer_totals.total_cents IS 'Sum of this customer''s order totals, in cents.
@widget: currency';

INSERT INTO audit_log (action, noted_at, shift_start, span)
VALUES ('fixture seeded', '2026-08-01 09:30:00', '09:30:00', '1 day 02:00:00');

INSERT INTO customers (name, email) VALUES ('Ada', 'ada@example.com'), ('Grace', NULL);
INSERT INTO orders (customer_id, status, total_cents, placed_at)
VALUES (1, 'placed', 12050, now() - interval '2 days'),
       (2, 'shipped', 990, now() - interval '10 days');

-- The materialized view was created before these rows existed, so its snapshot
-- is empty until it is told otherwise.
REFRESH MATERIALIZED VIEW customer_totals;
