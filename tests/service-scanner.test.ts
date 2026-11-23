import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { scanDocument } from "../src/modules/service-center/scanner.js";
test("required scan refuses unavailable service; ClamD protocol clean/infected verdicts", async () => {
  await assert.rejects(
    scanDocument(Buffer.from("x"), { NODE_ENV: "production" }),
    { code: "SCANNER_UNAVAILABLE" },
  );
  for (const result of [
    "stream: OK\0",
    "stream: Eicar-Test-Signature FOUND\0",
  ]) {
    const server = createServer((socket) =>
      socket.once("data", () => socket.end(result)),
    );
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const request = scanDocument(Buffer.from("test bytes"), {
        CLAMAV_HOST: "127.0.0.1",
        CLAMAV_PORT: String((server.address() as AddressInfo).port),
      });
      if (result.includes("FOUND"))
        await assert.rejects(request, { code: "MALWARE_DETECTED" });
      else await request;
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  }
});
