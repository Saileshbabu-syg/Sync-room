import net from "node:net";

// A tiny in-process SMTP server that accepts and stores mail. Used by the HTTP
// tests so the real app code path (nodemailer -> SMTP) runs without anything
// leaving the machine.

export type SinkMessage = { from: string; to: string[]; data: string };

export async function startSmtpSink() {
  const messages: SinkMessage[] = [];

  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current: SinkMessage = { from: "", to: [], data: "" };

    const reply = (line: string) => socket.write(line + "\r\n");

    reply("220 sink ESMTP");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");

          if (end === -1) return;

          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          current = { from: "", to: [], data: "" };
          reply("250 queued");
          continue;
        }

        const eol = buffer.indexOf("\r\n");

        if (eol === -1) return;

        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const command = line.slice(0, 4).toUpperCase();

        if (command === "EHLO" || command === "HELO") reply("250 sink");
        else if (command === "MAIL") {
          current.from = line.slice(10);
          reply("250 ok");
        } else if (command === "RCPT") {
          current.to.push(line.slice(8).replace(/[<>]/g, ""));
          reply("250 ok");
        } else if (command === "DATA") {
          inData = true;
          reply("354 go ahead");
        } else if (command === "QUIT") {
          reply("221 bye");
          socket.end();
          return;
        } else reply("250 ok");
      }
    });

    socket.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Decodes quoted-printable text/html bodies enough to assert on content.
export function decodeQuotedPrintable(input: string) {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}
