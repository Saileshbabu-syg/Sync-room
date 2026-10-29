import assert from "node:assert/strict";
import { describe, it } from "node:test";

import nodemailer from "nodemailer";

import {
  EmailConfigError,
  buildSmtpOptions,
  emailConfigProblems,
  getMailSender,
} from "@/lib/services/email.service";
import { startSmtpSink } from "../helpers/smtp-sink";

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe("buildSmtpOptions", () => {
  it("requires SMTP_HOST", () => {
    assert.throws(() => buildSmtpOptions(env({})), EmailConfigError);
  });

  it("defaults to mandatory STARTTLS on port 587", () => {
    const o = buildSmtpOptions(env({ SMTP_HOST: "smtp.example.test" }));

    assert.equal(o.port, 587);
    assert.equal(o.secure, false);
    assert.equal(o.requireTLS, true);
    assert.equal((o.tls as { minVersion?: string }).minVersion, "TLSv1.2");
    assert.notEqual(
      (o.tls as { rejectUnauthorized?: boolean }).rejectUnauthorized,
      false
    );
  });

  it("uses implicit TLS on 465 when SMTP_SECURE is unset", () => {
    const o = buildSmtpOptions(
      env({ SMTP_HOST: "smtp.example.test", SMTP_PORT: "465" })
    );

    assert.equal(o.secure, true);
    assert.equal(o.requireTLS, undefined);
  });

  it("honours an explicit SMTP_SECURE for either mode", () => {
    assert.equal(
      buildSmtpOptions(
        env({ SMTP_HOST: "h.test", SMTP_PORT: "2525", SMTP_SECURE: "true" })
      ).secure,
      true
    );

    const starttls = buildSmtpOptions(
      env({ SMTP_HOST: "h.test", SMTP_PORT: "465", SMTP_SECURE: "false" })
    );

    assert.equal(starttls.secure, false);
    assert.equal(starttls.requireTLS, true);
  });

  it("rejects malformed port, SMTP_SECURE and half-configured auth", () => {
    const cases: Record<string, string>[] = [
      { SMTP_PORT: "abc" },
      { SMTP_PORT: "0" },
      { SMTP_PORT: "70000" },
      { SMTP_SECURE: "yes" },
      { SMTP_USER: "u" },
    ];

    for (const bad of cases) {
      assert.throws(
        () => buildSmtpOptions(env({ SMTP_HOST: "h.test", ...bad })),
        EmailConfigError,
        JSON.stringify(bad)
      );
    }
  });

  it("only drops mandatory TLS with SMTP_ALLOW_INSECURE", () => {
    const o = buildSmtpOptions(
      env({ SMTP_HOST: "127.0.0.1", SMTP_ALLOW_INSECURE: "true" })
    );

    assert.equal(o.requireTLS, undefined);
  });

  it("refuses SMTP_ALLOW_INSECURE for a remote host in production", () => {
    assert.throws(
      () =>
        buildSmtpOptions(
          env({
            SMTP_HOST: "smtp.example.test",
            SMTP_ALLOW_INSECURE: "true",
            NODE_ENV: "production",
          })
        ),
      EmailConfigError
    );
  });
});

describe("SMTP without TLS", () => {
  it("does not fall back to plaintext when the server lacks STARTTLS", async () => {
    const sink = await startSmtpSink();

    try {
      const transport = nodemailer.createTransport(
        buildSmtpOptions(
          env({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(sink.port) })
        )
      );

      await assert.rejects(
        transport.sendMail({
          from: "a@example.invalid",
          to: "b@example.invalid",
          subject: "x",
          text: "x",
        })
      );
      assert.equal(sink.messages.length, 0);
    } finally {
      await sink.close();
    }
  });

  it("delivers to the local sink only when explicitly allowed", async () => {
    const sink = await startSmtpSink();

    try {
      const transport = nodemailer.createTransport(
        buildSmtpOptions(
          env({
            SMTP_HOST: "127.0.0.1",
            SMTP_PORT: String(sink.port),
            SMTP_ALLOW_INSECURE: "true",
          })
        )
      );

      await transport.sendMail({
        from: "a@example.invalid",
        to: "b@example.invalid",
        subject: "x",
        text: "x",
      });
      assert.equal(sink.messages.length, 1);
    } finally {
      await sink.close();
    }
  });
});

describe("sender (EMAIL_FROM)", () => {
  const withFrom = (value: string | undefined, fn: () => void) => {
    const saved = process.env.EMAIL_FROM;

    if (value === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = value;

    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = saved;
    }
  };

  it("accepts a bare or display-name address", () => {
    withFrom("rooms@example.com", () =>
      assert.equal(getMailSender(), "rooms@example.com")
    );
    withFrom("Meeting Rooms <rooms@example.com>", () =>
      assert.equal(getMailSender(), "Meeting Rooms <rooms@example.com>")
    );
  });

  it("rejects missing, malformed, list and header-injecting values", () => {
    for (const bad of [
      undefined,
      "",
      "not-an-address",
      "a@b.com, c@d.com",
      "a@b.com\r\nBcc: x@y.com",
      "<>",
    ]) {
      withFrom(bad, () =>
        assert.throws(() => getMailSender(), EmailConfigError, String(bad))
      );
    }
  });
});

describe("emailConfigProblems", () => {
  it("is empty for a valid configuration", () => {
    assert.deepEqual(
      emailConfigProblems(
        env({ SMTP_HOST: "smtp.example.test", EMAIL_FROM: "rooms@example.com" })
      ),
      []
    );
  });

  it("reports missing settings and the legacy EMAIL_USER names, without values", () => {
    const problems = emailConfigProblems(
      env({ EMAIL_USER: "u@example.com", EMAIL_PASSWORD: "hunter2-secret" })
    );

    assert.equal(problems.length, 3);
    assert.ok(problems.some((p) => /SMTP_HOST/.test(p)));
    assert.ok(problems.some((p) => /EMAIL_FROM/.test(p)));
    assert.ok(problems.some((p) => /SMTP_USER/.test(p)));
    assert.ok(!problems.join(" ").includes("hunter2-secret"));
  });
});
