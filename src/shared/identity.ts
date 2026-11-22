import { z } from 'zod';
const uuid = z.string().uuid();

/** UUID identity is case-insensitive; opaque domain identifiers remain exact. */
export function canonicalIdentity(value: string): string {
  return uuid.safeParse(value).success ? value.toLowerCase() : value;
}
