import { z } from "zod";

// Source: https://gov.bw/public-holidays (2026 dates, checked 23 November 2026).
const published2026Holidays = [
  "2026-01-01",
  "2026-04-03",
  "2026-04-04",
  "2026-04-06",
  "2026-05-01",
  "2026-05-14",
  "2026-07-01",
  "2026-07-20",
  "2026-07-21",
  "2026-09-30",
  "2026-10-01",
  "2026-12-25",
  "2026-12-26",
];
export const serviceConfigSchema = z
  .object({
    SUPPORT_HOLIDAYS: z
      .string()
      .default("")
      .transform((s) =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    TURN_URL: z.string().optional(),
    TURN_SECRET: z.string().min(24).optional(),
    EMAIL_API_URL: z.url().optional(),
    EMAIL_API_KEY: z.string().optional(),
    EMAIL_FROM: z.email().optional(),
    PUBLIC_PORTAL_URL: z.url().default("http://localhost:5174"),
  })
  .superRefine((c, ctx) => {
    if (Boolean(c.TURN_URL) !== Boolean(c.TURN_SECRET))
      ctx.addIssue({
        code: "custom",
        message: "TURN URL and secret must be configured together",
      });
    if (
      [c.EMAIL_API_URL, c.EMAIL_API_KEY, c.EMAIL_FROM].filter(Boolean).length %
      3
    )
      ctx.addIssue({
        code: "custom",
        message: "Email configuration must be complete",
      });
    if (c.EMAIL_API_URL && !c.EMAIL_API_URL.startsWith("https://"))
      ctx.addIssue({ code: "custom", message: "Email requires HTTPS" });
  });
export type ServiceConfig = z.infer<typeof serviceConfigSchema>;
export function officeHours(now = new Date(), holidays: string[] = []) {
  const cat = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const day = cat.getUTCDay();
  return (
    day > 0 &&
    day < 6 &&
    cat.getUTCHours() >= 9 &&
    cat.getUTCHours() < 16 &&
    ![...published2026Holidays, ...holidays].includes(
      cat.toISOString().slice(0, 10),
    )
  );
}
export function availability(
  open: boolean,
  freeAgents: number,
  onlineAgents: number,
) {
  if (!open)
    return {
      code: "CLOSED",
      message:
        "Consultants are available Monday–Friday, 09:00–16:00 CAT, excluding published holidays. Leave a message for the next working day.",
    };
  if (!onlineAgents)
    return {
      code: "OFFLINE",
      message:
        "No consultant is online. Leave a message and we will respond when available.",
    };
  if (!freeAgents)
    return {
      code: "BUSY",
      message:
        "All consultants are helping other applicants. Your message will stay in the queue.",
    };
  return {
    code: "AVAILABLE",
    message: "A consultant is available. Start a conversation.",
  };
}
