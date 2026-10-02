exports.up = (pgm) =>
  pgm.sql(
    "ALTER TABLE demo_daily_usage ADD COLUMN session_count integer NOT NULL DEFAULT 0 CHECK (session_count BETWEEN 0 AND 200)",
  );
exports.down = (pgm) =>
  pgm.sql("ALTER TABLE demo_daily_usage DROP COLUMN session_count");
