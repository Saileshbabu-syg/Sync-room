import nodemailer from "nodemailer";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { seedGroups } from "@/db/seed-groups";
import { seedLookups } from "@/db/seed-lookups";
import {
  employee,
  groups,
  meetingTypes,
  organizers,
  roleMeetingTypes,
  roles,
  room,
  userGroups,
  groupMeetingTypes,
} from "@/db/schema";
import { setMailTransport } from "@/lib/services/email.service";
import { setOnlineDispatchEnabled } from "@/lib/services/online-meeting.service";
import { nowInAppTimezone } from "@/lib/time";

import { migrateDatabase } from "./migrate";

let migrated = false;

// Brings the isolated test database up to date (no-op when already current).
export async function ensureMigrated() {
  if (migrated) return;

  await migrateDatabase(process.env.TEST_DATABASE_URL!);
  migrated = true;
}

// Empties every application table. The database is a dedicated, disposable test
// database (enforced by tests/helpers/safety.ts), so everything in it is
// test-owned.
export async function resetData() {
  await db.execute(sql`
    TRUNCATE
      booking_priority_history, group_audit_logs, user_groups, group_permissions, groups,
      meeting_audit_logs, reminder_logs, notifications, reschedule_requests, room_requests,
      meeting_attendees, meeting, recurring_meetings,
      "Session", "Account", "Organizer", "Employee",
      role_meeting_types, meeting_types, rooms,
      notification_type_master, recurrence_frequency_master,
      meeting_statuses, availability_master, roles
    RESTART IDENTITY CASCADE
  `);
}

// Mirrors db/seed-priority.ts (the source of the real matrix).
const ROLE_TYPES: Record<string, string[]> = {
  Admin: ["One-on-One", "Others"],
  Manager: [
    "Client Meeting",
    "Interview",
    "Team Meeting",
    "Training",
    "One-on-One",
    "Others",
  ],
  "Team Lead": [
    "Client Meeting",
    "Team Meeting",
    "Training",
    "One-on-One",
    "Others",
  ],
  HR: ["Interview", "Training", "One-on-One", "Others"],
  Employee: ["Team Meeting", "One-on-One", "Others"],
};

const TYPES = [
  ["Client Meeting", 1],
  ["Interview", 2],
  ["Team Meeting", 3],
  ["Training", 4],
  ["One-on-One", 4],
  ["Others", 5],
] as const;

export type Fixtures = Awaited<ReturnType<typeof seedFixtures>>;

export async function seedFixtures() {
  // Teams work runs only when a test calls the worker (no background calls
  // racing the test).
  setOnlineDispatchEnabled(false);

  await ensureMigrated();
  await resetData();
  await seedLookups(db);
  await seedGroups(db);

  // Mirrors ROLE_BOOST in db/seed-priority.ts.
  await db.update(roles).set({ priorityBoost: 1 }).where(eq(roles.roleName, "Manager"));

  const roleRows = await db.select().from(roles);
  const roleId = (name: string) =>
    roleRows.find((r) => r.roleName === name)!.roleId;

  const typeRows = await db
    .insert(meetingTypes)
    .values(TYPES.map(([meetingTypeName, priorityRank]) => ({ meetingTypeName, priorityRank })))
    .returning();

  const typeId = (name: string) =>
    typeRows.find((t) => t.meetingTypeName === name)!.meetingTypeId;

  for (const [roleName, typeNames] of Object.entries(ROLE_TYPES)) {
    await db.insert(roleMeetingTypes).values(
      typeNames.map((n) => ({
        roleId: roleId(roleName),
        meetingTypeId: typeId(n),
      }))
    );
  }

  const people = [
    ["admin", "Alice Admin", "alice.admin@example.test", "Admin", true],
    ["manager", "Mona Manager", "mona.manager@example.test", "Manager", true],
    ["bob", "Bob Employee", "bob.emp@example.test", "Employee", true],
    ["carol", "Carol Employee", "carol.emp@example.test", "Employee", true],
    // Employee row, but never signed in (no Organizer row).
    ["dave", "Dave NoLogin", "dave.nologin@example.test", "Employee", false],
  ] as const;

  const users: Record<
    "admin" | "manager" | "bob" | "carol" | "dave",
    { employeeId: number; email: string; name: string; role: string }
  > = {} as never;

  for (const [key, name, email, role, hasOrganizer] of people) {
    const [emp] = await db
      .insert(employee)
      .values({ role_id: roleId(role), employee_name: name, email })
      .returning();

    if (hasOrganizer) {
      await db.insert(organizers).values({
        employeeId: emp.employee_id,
        name,
        email,
        role,
        provider: "google",
      });
    }

    users[key] = { employeeId: emp.employee_id, email, name, role };
  }

  const [alpha, beta, gamma] = await db
    .insert(room)
    .values([
      { room_name: "Alpha", room_capacity: 10, roomLocation: "Floor 1", availabilityStatusId: 1 },
      { room_name: "Beta", room_capacity: 4, roomLocation: "Floor 2", availabilityStatusId: 1 },
      { room_name: "Gamma", room_capacity: 10, roomLocation: "Floor 3", availabilityStatusId: 2 },
    ])
    .returning();

  // Application groups: Manager and Employee users are placed like the real
  // migration does. Alice (Admin) and Dave stay unassigned on purpose (default
  // policy: lowest priority, no preemption).
  const groupRows = await db.select().from(groups);
  const groupId = (name: string) => groupRows.find((g) => g.name === name)!.id;

  await db.insert(userGroups).values([
    { employeeId: users.manager.employeeId, groupId: groupId("Manager") },
    { employeeId: users.bob.employeeId, groupId: groupId("Employee") },
    { employeeId: users.carol.employeeId, groupId: groupId("Employee") },
  ]);

  // What each group may book: the same lists the real migration copies over
  // from the namesake role (Leadership gets every type).
  const groupRoles: Record<string, string> = {
    Manager: "Manager",
    Employee: "Employee",
    HR: "HR",
    TL: "Team Lead",
    Admin: "Admin",
  };

  await db.insert(groupMeetingTypes).values([
    ...typeRows.map((t) => ({
      groupId: groupId("Leadership"),
      meetingTypeId: t.meetingTypeId,
    })),
    ...Object.entries(groupRoles).flatMap(([group, role]) =>
      ROLE_TYPES[role].map((n) => ({
        groupId: groupId(group),
        meetingTypeId: typeId(n),
      }))
    ),
  ]);

  return {
    users,
    groupIds: {
      leadership: groupId("Leadership"),
      hr: groupId("HR"),
      manager: groupId("Manager"),
      tl: groupId("TL"),
      employee: groupId("Employee"),
    },
    rooms: { alpha, beta, gamma },
    types: {
      client: typeId("Client Meeting"),
      interview: typeId("Interview"),
      team: typeId("Team Meeting"),
      training: typeId("Training"),
      oneOnOne: typeId("One-on-One"),
      others: typeId("Others"),
    },
  };
}

// "YYYY-MM-DD" `days` from today in the application's timezone.
export function dateFromToday(days: number) {
  const d = new Date(`${nowInAppTimezone().date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Replaces the mail transport with an in-memory JSON transport and records
// every message "sent". Nothing leaves the process.
// A moment `minutes` from now: e-mail retries back off exponentially
// (lib/delivery-policy.ts), so a test retries "later" by passing this clock.
export const minutesFromNow = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000);

export function captureMail(options: { failTimes?: number } = {}) {
  const sent: {
    from: string;
    to: string;
    visibleTo: string;
    bcc: string;
    subject: string;
    html: string;
    text: string;
    ics: string;
  }[] = [];
  let failuresLeft = options.failTimes ?? 0;

  const transport = nodemailer.createTransport({ jsonTransport: true });
  const original = transport.sendMail.bind(transport);

  (transport as unknown as { sendMail: unknown }).sendMail = async (
    message: Parameters<typeof original>[0]
  ) => {
    if (failuresLeft > 0) {
      failuresLeft--;
      throw new Error("simulated SMTP outage");
    }

    const info = await original(message);
    const m = message as Record<string, unknown>;

    const attachment = (m.attachments as { content?: unknown }[] | undefined)?.[0];

    const list = (value: unknown) =>
      value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)];

    sent.push({
      from: String(m.from),
      // Everyone the message was delivered to (To and Bcc) ...
      to: [...list(m.to), ...list(m.bcc)].join(","),
      // ... and what each recipient can SEE in the To / Cc headers.
      visibleTo: [...list(m.to), ...list(m.cc)].join(","),
      bcc: list(m.bcc).join(","),
      subject: String(m.subject),
      html: String(m.html),
      text: String(m.text),
      ics: String(attachment?.content ?? ""),
    });

    return info;
  };

  setMailTransport(transport);

  return {
    sent,
    setFailures(n: number) {
      failuresLeft = n;
    },
    restore() {
      setMailTransport(null);
    },
  };
}
