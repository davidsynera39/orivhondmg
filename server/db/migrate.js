require("dotenv").config();
const postgres = require("postgres");
const { drizzle } = require("drizzle-orm/postgres-js");
const { migrate } = require("drizzle-orm/postgres-js/migrator");
const path = require("path");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Add it to your .env file with your Supabase connection string.");
  }

  const client = postgres(connectionString, { max: 1, prepare: false });
  const db = drizzle(client);

  await migrate(db, { migrationsFolder: path.join(__dirname, "..", "..", "drizzle") });
  console.log("Migrations applied.");

  await client.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
