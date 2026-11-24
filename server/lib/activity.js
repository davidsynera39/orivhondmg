async function logActivity(db, schema, userId, type, summary, metadata) {
  await db.insert(schema.activities).values({
    userId,
    type,
    summary,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
}

module.exports = { logActivity };
