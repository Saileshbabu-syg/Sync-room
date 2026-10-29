import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { assertSafeTestDatabaseUrl } from "./safety";

// Applies a drizzle migrations folder to a test database (programmatic
// equivalent of `drizzle-kit migrate`, but it surfaces SQL errors).
export async function migrateDatabase(
  url: string,
  migrationsFolder = "drizzle"
) {
  assertSafeTestDatabaseUrl(url);

  const pool = new Pool({ connectionString: url });

  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
