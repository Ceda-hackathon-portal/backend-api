import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  unlink,
  rmdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { HttpError } from "../../shared/errors.js";

/** Streams bytes to a private ClamD socket. No file is released before a clean verdict. */
export async function scanDocument(
  bytes: Buffer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (
    env.UPLOAD_SCANNER === "defender" ||
    (!env.UPLOAD_SCANNER &&
      !env.CLAMAV_HOST &&
      env.NODE_ENV === "development" &&
      process.platform === "win32")
  )
    return scanWithDefender(bytes, env);
  const host = env.CLAMAV_HOST;
  if (!host) {
    if (env.NODE_ENV === "production" || env.UPLOAD_SCAN_REQUIRED === "true")
      throw new HttpError(
        503,
        "SCANNER_UNAVAILABLE",
        "Document scanning is unavailable. Please retry later.",
      );
    return;
  }
  const port = Number(env.CLAMAV_PORT || 3310);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new HttpError(
      503,
      "SCANNER_UNAVAILABLE",
      "Document scanning is unavailable.",
    );
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    let reply = "",
      settled = false;
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }
    const unavailable = () =>
      new HttpError(
        503,
        "SCANNER_UNAVAILABLE",
        "The document could not be scanned. Retry later.",
      );
    socket.setTimeout(15000, () => finish(unavailable()));
    socket.on("error", () => finish(unavailable()));
    socket.on("close", () => {
      if (!settled) finish(unavailable());
    });
    socket.on("end", () => {
      if (!settled) finish(unavailable());
    });
    socket.on("data", (chunk) => {
      reply += chunk.toString("utf8");
      if (reply.length > 2048) {
        finish(unavailable());
        return;
      }
      if (!reply.includes("\0") && !reply.includes("\n")) return;
      if (/: OK[\0\r\n]/.test(reply)) finish();
      else if (reply.includes(" FOUND"))
        finish(
          new HttpError(
            422,
            "MALWARE_DETECTED",
            "This file was rejected by the security scanner. Choose a clean document.",
          ),
        );
      else finish(unavailable());
    });
    socket.on("connect", () => {
      socket.write(Buffer.from("zINSTREAM\0"));
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const chunk = bytes.subarray(offset, offset + 65536),
          size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

/** Windows development/hosting adapter. Custom scan never changes security settings. */
async function scanWithDefender(
  bytes: Buffer,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (process.platform !== "win32")
    throw new HttpError(
      503,
      "SCANNER_UNAVAILABLE",
      "This scanner is not available on the server.",
    );
  const root = resolve(
    env.APPLICATION_QUARANTINE_DIR || ".runtime/upload-quarantine",
  );
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "scan-"));
  const file = join(directory, "upload.bin");
  try {
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    // Fixed trusted Windows path, shell disabled, and only this private temporary file is scanned.
    const binary = join(
      process.env.ProgramFiles || "C:\\Program Files",
      "Windows Defender",
      "MpCmdRun.exe",
    );
    await promisify(execFile)(
      binary,
      ["-Scan", "-ScanType", "3", "-File", file, "-DisableRemediation"],
      { timeout: 20000, windowsHide: true, maxBuffer: 32768 },
    );
    const scanned = await readFile(file);
    if (
      createHash("sha256").update(scanned).digest("hex") !==
      createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error("SCANNED_CONTENT_CHANGED");
  } catch {
    // Exit code 2 covers both threats and scan errors. Neither is a clean verdict.
    throw new HttpError(
      503,
      "DOCUMENT_NOT_CLEARED",
      "This file did not receive a clean security verdict. Choose another file or contact support.",
    );
  } finally {
    try {
      await unlink(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await rmdir(directory);
  }
}
