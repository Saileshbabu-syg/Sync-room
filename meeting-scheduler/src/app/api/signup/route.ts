import { NextResponse } from "next/server";
import bcrypt from "bcrypt";
import { db } from "@/app/db";
import { organizers } from "@/app/db/schema";
import { eq } from "drizzle-orm";

export async function POST(req: Request) {
  try {
    const { name, email, password } = await req.json();

    const existingUser = await db
      .select()
      .from(organizers)
      .where(eq(organizers.email, email));

    if (existingUser.length > 0) {
      return NextResponse.json(
        { message: "Email already exists" },
        { status: 400 }
      );
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await db.insert(organizers).values({
      name,
      email,
      password: hashedPassword,
      role: "Organizer",
      provider: "credentials",
    });

    return NextResponse.json({
      message: "Signup successful",
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { message: "Something went wrong" },
      { status: 500 }
    );
  }
}