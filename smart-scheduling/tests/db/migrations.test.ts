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
        "groups", "user_groups", "group_permissions",
        "booking_priority_history", "group_audit_logs",
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

      // PREEMPTED (6) no longer holds the room, like cancelled (3) and pending (4).
      const overlap = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'meeting_no_room_overlap'`
      );
      assert.match(overlap.rows[0].def, /3, 4, 6/);

      // One active group per employee, enforced by the database.
      const index = await pool.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'user_groups_one_active_per_employee_idx'`
      );
      assert.match(index.rows[0].indexdef, /UNIQUE.*employee_id.*effective_until IS NULL/);

      const seeded = await pool.query(`SELECT name, priority FROM groups ORDER BY priority, id`);
      assert.deepEqual(
        seeded.rows.map((g) => [g.name, g.priority]),
        [["Leadership", 1], ["HR", 2], ["Manager", 3], ["TL", 4], ["Employee", 5], ["Admin", 5]]
      );

      const status = await pool.query(`SELECT meeting_status_name FROM meeting_statuses WHERE meeting_status_id = 6`);
      assert.equal(status.rows[0].meeting_status_name, "PREEMPTED");

      // 0029: optional participants, Entra object id, per-group meeting types.
      const columns = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE (table_name = 'meeting_attendees' AND column_name = 'is_optional')
            OR (table_name = 'Employee' AND column_name = 'entra_object_id')`
      );
      assert.equal(columns.rowCount, 2);

      const optional = await pool.query(
        `SELECT is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'meeting_attendees' AND column_name = 'is_optional'`
      );
      assert.equal(optional.rows[0].is_nullable, "NO");
      assert.match(optional.rows[0].column_default, /false/);

      const unique = await pool.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'Employee_entra_object_id_unique' AND contype = 'u'`
      );
      assert.equal(unique.rowCount, 1, "one employee per Entra object id");

      const oneRunning = await pool.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'employee_sync_runs_one_running_idx'`
      );
      assert.match(oneRunning.rows[0].indexdef, /UNIQUE.*RUNNING/);

      // Every group starts with the meeting types of its namesake role (none
      // here: a new database has no roles mapped yet), and Admin is a group.
      assert.equal(
        (await pool.query(`SELECT 1 FROM groups WHERE name = 'Admin'`)).rowCount,
        1
      );
      assert.equal(
        (await pool.query(`SELECT 1 FROM group_meeting_types`)).rowCount,
        0
      );
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

// Phase 7 (DB-02 / DB-03): 0041_room_archive on a database that already holds
// rooms and meetings, and the documented manual rollback of the Phase 3-6
// migrations (0036-0041) on a throw-away database.
const SEED_SQL = `
  INSERT INTO roles (role_name) VALUES ('Employee');
  INSERT INTO availability_master (availability_status_code) VALUES ('Available');
  INSERT INTO meeting_statuses (meeting_status_id, meeting_status_name) VALUES (1,'Scheduled'),(2,'Completed'),(3,'Cancelled');
  INSERT INTO meeting_types (meeting_type_name) VALUES ('Team Meeting');
  INSERT INTO "Employee" (role_id, employee_name, email) VALUES (1, 'Bob', 'bob@example.test');
  INSERT INTO rooms (room_name, room_capacity, availability_status_id) VALUES ('Alpha', 8, 1), ('Beta', 4, 1);
  INSERT INTO meeting (title, room_id, meeting_date, organizer_employee_id, participant_count,
                       meeting_type_id, meeting_status_id, start_time, end_time) VALUES
    ('kept', 1, '2030-01-01', 1, 2, 1, 1, '10:00', '11:00'),
    ('past', 2, '2020-01-01', 1, 2, 1, 2, '10:00', '11:00');
`;

const lastApplied = (n: number) =>
  `DELETE FROM drizzle.__drizzle_migrations WHERE id IN (SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT ${n})`;

describe("0041_room_archive and the manual rollbacks (Phase 7)", () => {
  it("adds archived_at to a database with data: every room stays active, meetings keep their room", async () => {
    const { url } = await createDatabase("m41");

    await migrateDatabase(url, truncatedMigrations(40));
    await withPool(url, (pool) => pool.query(SEED_SQL));

    await migrateDatabase(url); // 0041 on top of the populated database

    await withPool(url, async (pool) => {
      const column = await pool.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_name = 'rooms' AND column_name = 'archived_at'`
      );
      assert.equal(column.rows[0].data_type, "timestamp with time zone");
      assert.equal(column.rows[0].is_nullable, "YES");

      const rooms = await pool.query(`SELECT room_name, archived_at FROM rooms ORDER BY room_id`);
      assert.deepEqual(rooms.rows, [
        { room_name: "Alpha", archived_at: null },
        { room_name: "Beta", archived_at: null },
      ]);

      const meetings = await pool.query(
        `SELECT m.title, r.room_name FROM meeting m JOIN rooms r ON r.room_id = m.room_id ORDER BY m.meeting_id`
      );
      assert.deepEqual(meetings.rows, [
        { title: "kept", room_name: "Alpha" },
        { title: "past", room_name: "Beta" },
      ]);

      // Archiving is just a timestamp; the historical meeting still joins to it.
      await pool.query(`UPDATE rooms SET archived_at = now() WHERE room_name = 'Beta'`);
      const past = await pool.query(
        `SELECT r.room_name, r.archived_at IS NOT NULL AS archived FROM meeting m JOIN rooms r ON r.room_id = m.room_id WHERE m.title = 'past'`
      );
      assert.deepEqual(past.rows, [{ room_name: "Beta", archived: true }]);
    });
  });

  it("the down scripts 0042 -> 0036 run in reverse without touching rooms or meetings, and the chain re-applies", async () => {
    const { url } = await createDatabase("rollback");

    await migrateDatabase(url);
    await withPool(url, (pool) => pool.query(SEED_SQL));

    const downs = fs
      .readdirSync(path.join(migrationsDir, "down"))
      .filter((f) => /^00(3[6-9]|4[0-2])_.*\.down\.sql$/.test(f))
      .sort()
      .reverse();

    assert.deepEqual(downs.map((f) => f.slice(0, 4)), ["0042", "0041", "0040", "0039", "0038", "0037", "0036"]);

    await withPool(url, async (pool) => {
      await pool.query(`UPDATE rooms SET archived_at = now() WHERE room_name = 'Beta'`);

      for (const file of downs) {
        await pool.query(fs.readFileSync(path.join(migrationsDir, "down", file), "utf8"));
      }

      const gone = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE (table_name = 'rooms' AND column_name = 'archived_at')
            OR (table_name = 'meeting' AND column_name IN ('online_status', 'ics_sequence'))
            OR (table_name = 'Employee' AND column_name = 'is_active')`
      );
      assert.equal(gone.rowCount, 0, "the rolled-back columns are gone");

      const meetings = await pool.query(`SELECT title FROM meeting ORDER BY meeting_id`);
      assert.deepEqual(meetings.rows.map((m) => m.title), ["kept", "past"]);
      assert.equal((await pool.query(`SELECT 1 FROM rooms`)).rowCount, 2);
      assert.equal((await pool.query(`SELECT 1 FROM "Employee"`)).rowCount, 1);

      // As documented in each script: forget the rolled-back rows, then migrate forward again.
      await pool.query(lastApplied(downs.length));
    });

    await migrateDatabase(url);

    await withPool(url, async (pool) => {
      const applied = await pool.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
      assert.equal(applied.rows[0].n, journalLength());

      const rooms = await pool.query(`SELECT room_name, archived_at IS NOT NULL AS archived FROM rooms ORDER BY room_id`);
      assert.deepEqual(rooms.rows, [
        { room_name: "Alpha", archived: false },
        { room_name: "Beta", archived: false },
      ]); // the archive flag is the one thing a rollback loses (documented in the 0041 down script)
      assert.equal((await pool.query(`SELECT 1 FROM meeting`)).rowCount, 2);
    });
  });

  it("0042: existing groups get safe defaults, and its down script removes only the booking-policy configuration", async () => {
    const { url } = await createDatabase("rollback0042");

    await migrateDatabase(url);
    await withPool(url, (pool) => pool.query(SEED_SQL));

    await withPool(url, async (pool) => {
      // A group that already had limits before the policies existed.
      const group = await pool.query(
        `INSERT INTO groups (name, priority) VALUES ('Existing', 5) RETURNING id`
      );
      const groupId = group.rows[0].id;

      await pool.query(`INSERT INTO group_settings (group_id, max_duration_minutes) VALUES ($1, 120)`, [groupId]);

      // New columns default to "inherit" / "no group limit": behaviour is unchanged.
      const defaults = await pool.query(
        `SELECT overnight_policy, max_bookings_per_day, max_bookings_per_week, max_bookings_per_month, max_duration_minutes
         FROM group_settings WHERE group_id = $1`,
        [groupId]
      );
      assert.deepEqual(defaults.rows, [
        {
          overnight_policy: "INHERIT",
          max_bookings_per_day: null,
          max_bookings_per_week: null,
          max_bookings_per_month: null,
          max_duration_minutes: 120,
        },
      ]);

      // No application row means "no application limits".
      assert.equal((await pool.query(`SELECT 1 FROM app_booking_settings`)).rowCount, 0);

      await pool.query(`UPDATE group_settings SET overnight_policy = 'NOT_ALLOWED', max_bookings_per_day = 3 WHERE group_id = $1`, [groupId]);
      await pool.query(`INSERT INTO app_booking_settings (id, max_bookings_per_day) VALUES (1, 5)`);

      await pool.query(fs.readFileSync(path.join(migrationsDir, "down", "0042_booking_policies.down.sql"), "utf8"));

      const gone = await pool.query(
        `SELECT 1 FROM information_schema.columns
           WHERE table_name = 'group_settings'
             AND column_name IN ('overnight_policy', 'max_bookings_per_day', 'max_bookings_per_week', 'max_bookings_per_month')
         UNION ALL SELECT 1 FROM information_schema.tables WHERE table_name = 'app_booking_settings'
         UNION ALL SELECT 1 FROM pg_indexes WHERE indexname = 'meeting_group_date_idx'`
      );
      assert.equal(gone.rowCount, 0, "the booking-policy configuration is gone");

      // Everything else is untouched.
      const kept = await pool.query(`SELECT max_duration_minutes FROM group_settings WHERE group_id = $1`, [groupId]);
      assert.deepEqual(kept.rows, [{ max_duration_minutes: 120 }]);
      assert.equal((await pool.query(`SELECT 1 FROM meeting`)).rowCount, 2);

      await pool.query(lastApplied(1));
    });

    await migrateDatabase(url);

    await withPool(url, async (pool) => {
      const applied = await pool.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
      assert.equal(applied.rows[0].n, journalLength());

      const back = await pool.query(`SELECT overnight_policy, max_bookings_per_day FROM group_settings`);
      assert.deepEqual(back.rows, [{ overnight_policy: "INHERIT", max_bookings_per_day: null }]);
    });
  });
});
