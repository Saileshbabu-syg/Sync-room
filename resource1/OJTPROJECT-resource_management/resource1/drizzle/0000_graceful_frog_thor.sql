CREATE TABLE "availability_master" (
	"availability_status_id" serial PRIMARY KEY NOT NULL,
	"availability_status_code" varchar(30) NOT NULL,
	"availability_status_description" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "availability_master_availability_status_code_unique" UNIQUE("availability_status_code")
);
