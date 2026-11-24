/** @type {import('drizzle-kit').Config} */
module.exports = {
  schema: "./server/db/schema.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
};
