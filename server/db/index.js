const postgres = require("postgres");
const { drizzle } = require("drizzle-orm/postgres-js");
const schema = require("./schema");

// This is where your Supabase database connection lives.
// Set DATABASE_URL in your .env file to your Supabase connection string
// (Supabase dashboard -> Project Settings -> Database -> Connection string -> URI).
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Add it to your .env file with your Supabase connection string."
  );
}

const client = postgres(connectionString, { prepare: false });
const db = drizzle(client, { schema });

module.exports = { db, schema, client };
