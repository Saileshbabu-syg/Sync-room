CREATE TABLE "availability_master" (
	"availability_status_id" serial PRIMARY KEY NOT NULL,
	"availability_status_code" varchar(30),
	"created_at" timestamp,
	CONSTRAINT "availability_master_availability_status_code_unique" UNIQUE("availability_status_code")
);
--> statement-breakpoint
CREATE TABLE "meeting_statuses" (
	"meeting_status_id" serial PRIMARY KEY NOT NULL,
	"meeting_status_name" varchar(30),
	CONSTRAINT "meeting_statuses_meeting_status_name_unique" UNIQUE("meeting_status_name")
);
--> statement-breakpoint
CREATE TABLE "meeting_types" (
	"meeting_type_id" serial PRIMARY KEY NOT NULL,
	"meeting_type_name" varchar(50) NOT NULL,
	CONSTRAINT "meeting_types_meeting_type_name_unique" UNIQUE("meeting_type_name")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"role_id" serial PRIMARY KEY NOT NULL,
	"role_name" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "roles_role_name_unique" UNIQUE("role_name")
);
--> statement-breakpoint
ALTER TABLE "Employee" ADD COLUMN "role_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "organizer_employee_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "participant_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "meeting_type_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "meeting_status_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "room_location" varchar(100);--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "facilities" varchar(255);--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "availability_status_id" integer;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "room_description" varchar(255);--> statement-breakpoint
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_role_id_roles_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("role_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_organizer_employee_id_Employee_employee_id_fk" FOREIGN KEY ("organizer_employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_meeting_type_id_meeting_types_meeting_type_id_fk" FOREIGN KEY ("meeting_type_id") REFERENCES "public"."meeting_types"("meeting_type_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_meeting_status_id_meeting_statuses_meeting_status_id_fk" FOREIGN KEY ("meeting_status_id") REFERENCES "public"."meeting_statuses"("meeting_status_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_availability_status_id_availability_master_availability_status_id_fk" FOREIGN KEY ("availability_status_id") REFERENCES "public"."availability_master"("availability_status_id") ON DELETE no action ON UPDATE no action;