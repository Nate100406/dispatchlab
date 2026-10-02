exports.up = (pgm) =>
  pgm.sql(
    "ALTER TABLE deliveries ADD CONSTRAINT receiver_behaviour_present CHECK (receiver->>'behaviour' IS NOT NULL)",
  );
exports.down = (pgm) =>
  pgm.sql("ALTER TABLE deliveries DROP CONSTRAINT receiver_behaviour_present");
