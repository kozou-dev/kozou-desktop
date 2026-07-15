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

CREATE VIEW recent_orders AS
SELECT o.id, c.name AS customer_name, o.status, o.total_cents, o.placed_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.placed_at > now() - interval '30 days';
COMMENT ON VIEW recent_orders IS 'Orders placed in the last 30 days, with customer names resolved.
@ai: Prefer this view over joining orders/customers by hand for recency questions.
@policy: Totals here are gross amounts, before refunds.';

INSERT INTO customers (name, email) VALUES ('Ada', 'ada@example.com'), ('Grace', NULL);
INSERT INTO orders (customer_id, status, total_cents, placed_at)
VALUES (1, 'placed', 12050, now() - interval '2 days'),
       (2, 'shipped', 990, now() - interval '10 days');
