const express = require("express");
const { eq } = require("drizzle-orm");
const { db, schema } = require("../db");
const { requireAuth } = require("../lib/auth");

const router = express.Router();
const auth = requireAuth(db, schema, eq);

router.get("/", auth, async (req, res) => {
  const rows = await db.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, req.user.id)).limit(1);
  const profile = rows[0] || {};
  res.json({
    profile: {
      ...profile,
      skills: profile.skills ? JSON.parse(profile.skills) : [],
    },
  });
});

module.exports = router;
