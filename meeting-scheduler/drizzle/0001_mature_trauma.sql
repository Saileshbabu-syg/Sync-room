ALTER TABLE "Employee" RENAME TO "employee";--> statement-breakpoint
ALTER TABLE "employee" DROP CONSTRAINT "Employee_email_unique";--> statement-breakpoint
ALTER TABLE "Organizer" DROP CONSTRAINT "Organizer_employee_id_Employee_employee_id_fk";
--> statement-breakpoint
ALTER TABLE "Organizer" ADD CONSTRAINT "Organizer_employee_id_employee_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_email_unique" UNIQUE("email");