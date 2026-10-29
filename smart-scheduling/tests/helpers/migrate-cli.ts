import { migrateDatabase } from "./migrate";

const [url, folder] = process.argv.slice(2);

migrateDatabase(url, folder)
  .then(() => console.log("migrations applied"))
  .catch((error) => {
    console.error("MIGRATION FAILED:", error?.cause?.message ?? error?.message ?? error);
    process.exitCode = 1;
  });
