CREATE TABLE "meeting" (
	"meeting_id" serial PRIMARY KEY NOT NULL,
	"title" varchar(200) NOT NULL,
	"meeting_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
