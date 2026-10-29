import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { Pool } from "pg";

import { db } from "@/db";
import { assertLookupIds, seedLookups } from "@/db/seed-lookups";
import { availabilityMaster, meetingStatuses } from "@/db/schema";

import { ensureMigrated } from "../helpers/fixtures";
import { migrateDatabase } from "../helpers/migrate";
import { assertSafeTestDatabaseUrl } from "../helpers/safety";

// F-14: the migration history must build a database from nothing, and must
// upgrade an existing database without losing data. Each test uses its own
// throw-away database (ss_test_mig_*) on the local server.

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
const migrationsDir = path.resolve(__dirname, "../../drizzle");

const created: string[] = [];
const tempDirs: string[] = [];

function urlFor(name: string) {
  const u = new URL(adminUrl!);
  u.pathname = `/${name}`;
  return assertSafeTestDatabaseUrl(u.toString());
}

async function createDatabase(suffix: string) {
  assert.ok(adminUrl, "TEST_ADMIN_DATABASE_URL must be set in .env.test");

  const name = `ss_test_mig_${suffix}_${process.pid}`;
  const admin = new Pool({ connectionString: adminUrl });

  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  created.push(name);

  return { name, url: urlFor(name) };
}

// Copy of the migrations folder with the journal cut after `lastIdx`.
function truncatedMigrations(lastIdx: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-migrations-"));
  tempDirs.push(dir);
  fs.cpSync(migrationsDir, dir, { recursive: true });

  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
  fs.writeFileSync(journalPath, JSON.stringify(journal));

  return dir;
}

async function withPool<T>(url: string, fn: (pool: Pool) => Promise<T>) {
  const pool = new Pool({ connectionString: url });

  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

const journalLength = () =>
  JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"))
    .entries.length as number;

after(async () => {
  if (!adminUrl) return;

  const admin = new Pool({ connectionString: adminUrl });

  try {
    for (const name of created) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }

  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("migrations (F-14)", () => {
  it("builds a complete schema on an EMPTY database (0015 used to fail)", async () => {
    const { url } = await createDatabase("fresh");

    await migrateDatabase(url);

    await withPool(url, async (pool) => {
      const tables = (
        await pool.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
        )
      ).rows.map((r) => r.table_name);

      for (const t of [
        "Employee", "Organizer", "rooms", "meeting", "meeting_attendees",
        "meeting_types", "meeting_statuses", "availability_master", "roles",
        "role_meeting_types", "recurring_meetings", "recurrence_frequency_master",
        "reminder_logs", "notifications", "notification_type_master",
        "meeting_audit_logs", "reschedule_requests", "Account", "Session",
      ]) {
        assert.ok(tables.includes(t), `missing table ${t}`);
      }

      const applied = await pool.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
      assert.equal(applied.rows[0].n, journalLength());

      const constraints = (
        await pool.query(
          `SELECT conname, contype FROM pg_constraint WHERE conrelid = 'meeting'::regclass`
        )
      ).rows;
      assert.ok(constraints.some((c) => c.conname === "meeting_no_room_overlap" && c.contype === "x"));
      assert.ok(constraints.some((c) => c.conname === "meeting_end_after_start" && c.contype === "c"));
    });
  });

  it("re-running the migrations is a no-op", async () => {
    const { url } = await createDatabase("rerun");

    await migrateDatabase(url);
    await migrateDatabase(url);

    await withPool(url, async (pool) => {
      const applied = await pool.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
      assert.equal(applied.rows[0].n, journalLength());
    });
  });

  it("upgrades an existing database (state after 0018) and keeps its data", async () => {
    const { url } = await createDatabase("upgrade");

    await migrateDatabase(url, truncatedMigrations(18));

    await withPool(url, async (pool) => {
      await pool.query(`
        INSERT INTO roles (role_name) VALUES ('Employee');
        INSERT INTO availability_master (availability_status_code) VALUES ('Available');
        INSERT INTO meeting_statuses (meeting_status_name) VALUES ('Scheduled'),('Completed'),('Cancelled');
        INSERT INTO meeting_types (meeting_type_name) VALUES ('Team Meeting');
        INSERT INTO "Employee" (role_id, employee_name, email) VALUES (1, 'Bob', 'bob@example.test');
        INSERT INTO rooms (room_name, room_capacity, availability_status_id) VALUES ('Alpha', 8, 1);
        INSERT INTO meeting (title, room_id, meeting_date, organizer_employee_id, participant_count,
                             meeting_type_id, meeting_status_id, start_time, end_time) VALUES
          ('a', 1, '2030-01-01', 1, 2, 1, 1, '10:00', '11:00'),
          ('b', 1, '2030-01-01', 1, 2, 1, 1, '11:00', '12:00'),
          ('cancelled twin of a', 1, '2030-01-01', 1, 2, 1, 3, '10:00', '11:00');
      `);
    });

    await migrateDatabase(url); // 0019 + 0020 on top of the populated database

    await withPool(url, async (pool) => {
      const meetings = await pool.query(`SELECT count(*)::int AS n FROM meeting`);
      assert.equal(meetings.rows[0].n, 3, "no data lost");

      const reminders = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'reminder_logs' AND column_name = 'attempts'`
      );
      assert.equal(reminders.rowCount, 1);

      // The constraint is live: overlap rejected, back-to-back and cancelled twins fine.
      await assert.rejects(
        pool.query(`INSERT INTO meeting (title, room_id, meeting_date, organizer_employee_id, participant_count,
          meeting_type_id, meeting_status_id, start_time, end_time)
          VALUES ('x', 1, '2030-01-01', 1, 1, 1, 1, '10:30', '11:30')`),
        (e: { code?: string }) => e.code === "23P01"
      );

      await pool.query(`INSERT INTO meeting (title, room_id, meeting_date, organizer_employee_id, participant_count,
        meeting_type_id, meeting_status_id, start_time, end_time)
        VALUES ('back to back', 1, '2030-01-01', 1, 1, 1, 1, '12:00', '13:00')`);
    });
  });

  it("refuses to upgrade over existing overlapping meetings — with a clear message and no data change", async () => {
    const { url } = await createDatabase("dirty");

    await migrateDatabase(url, truncatedMigrations(19));

    await withPool(url, async (pool) => {
      await pool.query(`
        INSERT INTO roles (role_name) VALUES ('Employee');
        INSERT INTO availability_master (availability_status_code) VALUES ('Available');
        INSERT INTO meeting_statuses (meeting_status_name) VALUES ('Scheduled'),('Completed'),('Cancelled');
        INSERT INTO meeting_types (meeting_type_name) VALUES ('Team Meeting');
        INSERT INTO "Employee" (role_id, employee_name, email) VALUES (1, 'Bob', 'bob@example.test');
        INSERT INTO rooms (room_name, room_capacity, availability_status_id) VALUES ('Alpha', 8, 1);
        INSERT INTO meeting (title, room_id, meeting_date, organizer_employee_id, participant_count,
                             meeting_type_id, meeting_status_id, start_time, end_time) VALUES
          ('dup 1', 1, '2030-01-01', 1, 2, 1, 1, '10:00', '11:00'),
          ('dup 2', 1, '2030-01-01', 1, 2, 1, 1, '10:00', '11:00');
      `);
    });

    await assert.rejects(
      migrateDatabase(url),
      (e: { cause?: { message?: string }; message: string }) =>
        /meeting_no_room_overlap/.test(e.cause?.message ?? e.message)
    );

    await withPool(url, async (pool) => {
      const meetings = await pool.query(`SELECT count(*)::int AS n FROM meeting`);
      assert.equal(meetings.rows[0].n, 2, "nothing was deleted or changed");

      const constraint = await pool.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'meeting_no_room_overlap'`
      );
      assert.equal(constraint.rowCount, 0, "the migration rolled back cleanly");
    });
  });
});

describe("lookup seed (F-14)", () => {
  it("is idempotent and verifies the ids the code relies on", async () => {
    // The shared test database is built by the same migrations.
    await ensureMigrated();
    await seedLookups(db);
    const statusesBefore = (await db.select().from(meetingStatuses)).length;
    const availabilityBefore = (await db.select().from(availabilityMaster)).length;

    await seedLookups(db);

    assert.equal((await db.select().from(meetingStatuses)).length, statusesBefore);
    assert.equal((await db.select().from(availabilityMaster)).length, availabilityBefore);

    await assertLookupIds(db);
  });
});
