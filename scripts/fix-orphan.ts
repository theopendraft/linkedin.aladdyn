import prisma from '../src/lib/prisma';

async function main() {
  // Migrate messages from old URN-based conversation to be accessible,
  // and delete the orphan DOM-based conversation with 0 messages.

  // 1. Delete orphan (pankaj-yadav with 0 messages)
  const deleted = await prisma.linkedInConversation.deleteMany({
    where: {
      id: 'bbae6258-194a-4ac1-9700-a64d56a56545',
    },
  });
  console.log('Deleted orphan conversations:', deleted.count);

  // 2. Update the old conversation's participantLinkedInId to the DOM-extracted value
  // so future syncs match it correctly
  const updated = await prisma.linkedInConversation.update({
    where: { id: 'dab986d1-dbfb-4438-a6fc-612ebc611e65' },
    data: { participantLinkedInId: 'pankaj-yadav' },
  });
  console.log('Updated conversation participantLinkedInId to:', updated.participantLinkedInId);

  // 3. Reset lastAutoReplyAt so auto-reply can fire again on next sync
  await prisma.linkedInConversation.update({
    where: { id: 'dab986d1-dbfb-4438-a6fc-612ebc611e65' },
    data: { lastAutoReplyAt: null },
  });
  console.log('Reset lastAutoReplyAt for testing');

  // Verify
  const convs = await prisma.linkedInConversation.findMany({
    where: { accountId: '5763314b-ccae-4b5d-89e8-a6983e6cf500' },
    include: { messages: { take: 3, orderBy: { sentAt: 'desc' } } },
  });
  console.log(`\nConversations remaining: ${convs.length}`);
  for (const c of convs) {
    console.log(`  ${c.id} | ${c.participantLinkedInId} | msgs=${c.messages.length}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
