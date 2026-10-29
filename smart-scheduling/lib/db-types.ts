import type { db } from "@/db";

// Either the shared client or a transaction handle — services accept both so
// they can join a caller's transaction.
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbExecutor = typeof db | Tx;
