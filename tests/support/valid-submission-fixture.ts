import { createHash, randomUUID } from 'node:crypto';
import { after } from 'node:test';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { LocalPrivateDocumentStorage } from '../../src/modules/applications/document-storage.js';

export const requiredFixtureBudget = {
  items: [{ description: 'Fictional development cost', amount: '100.00' }],
  fundingRequested: '50.00',
  notApplicable: false,
};

const storage = new LocalPrivateDocumentStorage();
const fixtureKeys: string[] = [];
after(async () => {
  await Promise.all(fixtureKeys.map(key => storage.remove(key)));
});

/** Attach a real fictional PDF object and its metadata in database lifecycle fixtures. */
export async function attachFixtureTechnicalProposal(db: PrismaClient, applicationId: string, ownerId: string): Promise<void> {
  const id = randomUUID();
  const bytes = Buffer.from('%PDF-1.7\nFictional integration test proposal\n');
  await storage.put(id, bytes);
  fixtureKeys.push(id);
  try {
    await db.applicationDocument.create({ data: {
      id,
      applicationId,
      ownerId,
      category: 'technical-proposal',
      originalName: 'fictional-proposal.pdf',
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      storageKey: id,
    } });
  } catch (error) {
    await storage.remove(id);
    throw error;
  }
}
