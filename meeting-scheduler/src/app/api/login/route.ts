import { NextResponse } from "next/server";
import bcrypt from "bcrypt";
import { db } from "@/app/db";
import { organizers } from "@/app/db/schema";
import { eq } from "drizzle-orm";

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();

    const user = await db
      .select()
      .from(organizers)
      .where(eq(organizers.email, email));

    if (user.length === 0) {
      return NextResponse.json(
        { message: "Invalid Email or Password" },
        { status: 401 }
      );
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      user[0].password!
    );

    if (!isPasswordValid) {
      return NextResponse.json(
        { message: "Invalid Email or Password" },
        { status: 401 }
      );
    }

    return NextResponse.json({
      message: "Login Successful",
      user: {
        organizerId: user[0].organizerId,
        employeeId: user[0].employeeId,
        name: user[0].name,
        email: user[0].email,
        role: user[0].role,
      },
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { message: "Something went wrong" },
      { status: 500 }
    );
  }
}