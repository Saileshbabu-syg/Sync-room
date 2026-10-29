/**
 * Idempotent seed for recurrence_frequency_master.
 *
 * Only DAILY (1) and WEEKLY (2) exist in the shared database; MONTHLY is
 * required by lib/services/recurring-meeting.service.ts (frequency_id 3) and
 * the recurring-meeting UI, but was never seeded. Run once:
 *   npx tsx db/seed-recurrence-frequency.ts
 *
 * Re-running is safe: existing names are left alone, missing ones are inserted.
 */
import { eq } from "drizzle-orm";

import { db } from "./index";
import { recurrence_frequency_master } from "./schema";

const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;

async function main() {
  for (const name of FREQUENCIES) {
    const existing = await db
      .select()
      .from(recurrence_frequency_master)
      .where(eq(recurrence_frequency_master.frequency_name, name));

    if (existing.length > 0) {
      console.log(`Skipping existing frequency: ${name}`);
      continue;
    }

    await db.insert(recurrence_frequency_master).values({ frequency_name: name });
    console.log(`Inserted frequency: ${name}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
