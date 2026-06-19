CREATE TABLE "employee" (
	"employee_id" serial PRIMARY KEY NOT NULL,
	"employee_name" varchar(100) NOT NULL,
	"email" varchar(150),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "employee_email_unique" UNIQUE("email")
);
