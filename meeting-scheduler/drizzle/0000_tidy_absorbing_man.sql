CREATE TABLE "Account" (
	"account_id" serial PRIMARY KEY NOT NULL,
	"organizer_id" integer NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"expires_at" bigint,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "Account_provider_account_id_unique" UNIQUE("provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "Employee" (
	"employee_id" serial PRIMARY KEY NOT NULL,
	"employee_name" varchar(100) NOT NULL,
	"email" varchar(150) NOT NULL,
	"role" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "Employee_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "Organizer" (
	"organizer_id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer,
	"name" varchar(100) NOT NULL,
	"email" varchar(150) NOT NULL,
	"image_url" text,
	"role" varchar(50) NOT NULL,
	"password" varchar(255),
	"provider" varchar(50) DEFAULT 'google',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "Organizer_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "Session" (
	"session_id" serial PRIMARY KEY NOT NULL,
	"organizer_id" integer NOT NULL,
	"session_token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "Session_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
ALTER TABLE "Account" ADD CONSTRAINT "Account_organizer_id_Organizer_organizer_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."Organizer"("organizer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Organizer" ADD CONSTRAINT "Organizer_employee_id_Employee_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Session" ADD CONSTRAINT "Session_organizer_id_Organizer_organizer_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."Organizer"("organizer_id") ON DELETE cascade ON UPDATE no action;