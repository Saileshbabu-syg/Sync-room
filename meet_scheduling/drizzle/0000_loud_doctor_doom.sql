CREATE TABLE "roles" (
	"role_id" serial PRIMARY KEY NOT NULL,
	"role_name" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "roles_role_name_unique" UNIQUE("role_name")
);
--> statement-breakpoint
CREATE TABLE "availability_master" (
	"availability_status_id" serial PRIMARY KEY NOT NULL,
	"availability_status_code" varchar(30),
	"created_at" timestamp,
	CONSTRAINT "availability_master_availability_status_code_unique" UNIQUE("availability_status_code")
);
--> statement-breakpoint
CREATE TABLE "employee" (
	"employee_id" serial PRIMARY KEY NOT NULL,
	"role_id" integer NOT NULL,
	"employee_name" varchar(100) NOT NULL,
	"email" varchar(150) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "employee_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "room" (
	"room_id" serial PRIMARY KEY NOT NULL,
	"room_name" varchar(100),
	"room_capacity" integer,
	"room_location" varchar(100),
	"facilities" varchar(255),
	"availability_status_id" integer,
	"room_description" varchar(255),
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "meeting_types" (
	"meeting_type_id" serial PRIMARY KEY NOT NULL,
	"meeting_type_name" varchar(50) NOT NULL,
	CONSTRAINT "meeting_types_meeting_type_name_unique" UNIQUE("meeting_type_name")
);
--> statement-breakpoint
CREATE TABLE "meeting_statuses" (
	"meeting_status_id" serial PRIMARY KEY NOT NULL,
	"meeting_status_name" varchar(30),
	CONSTRAINT "meeting_statuses_meeting_status_name_unique" UNIQUE("meeting_status_name")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"meeting_id" serial PRIMARY KEY NOT NULL,
	"title" varchar(200) NOT NULL,
	"meeting_date" date NOT NULL,
	"organizer_employee_id" integer NOT NULL,
	"room_id" integer NOT NULL,
	"participant_count" integer NOT NULL,
	"meeting_type_id" integer NOT NULL,
	"meeting_status_id" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "meeting_attendees" (
	"meeting_attendee_id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer,
	"employee_id" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_role_id_roles_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("role_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_availability_status_id_availability_master_availability_status_id_fk" FOREIGN KEY ("availability_status_id") REFERENCES "public"."availability_master"("availability_status_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organizer_employee_id_employee_employee_id_fk" FOREIGN KEY ("organizer_employee_id") REFERENCES "public"."employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_room_id_room_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."room"("room_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_meeting_type_id_meeting_types_meeting_type_id_fk" FOREIGN KEY ("meeting_type_id") REFERENCES "public"."meeting_types"("meeting_type_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_meeting_status_id_meeting_statuses_meeting_status_id_fk" FOREIGN KEY ("meeting_status_id") REFERENCES "public"."meeting_statuses"("meeting_status_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meeting_id_meetings_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_employee_id_employee_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("employee_id") ON DELETE no action ON UPDATE no action;