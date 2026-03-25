import prisma from '../src/lib/prisma';

async function main() {
  const convs = await prisma.linkedInConversation.findMany({
    where: { accountId: '5763314b-ccae-4b5d-89e8-a6983e6cf500' },
    include: { messages: { take: 5, orderBy: { sentAt: 'desc' } } },
  });

  console.log(`Found ${convs.length} conversations\n`);

  for (const c of convs) {
    console.log(`CONV: ${c.id}`);
    console.log(`  participantLinkedInId: ${c.participantLinkedInId}`);
    console.log(`  participantName: ${c.participantName}`);
    console.log(`  linkedinConversationId: ${c.linkedinConversationId}`);
    console.log(`  autoReplyEnabled: ${c.autoReplyEnabled}`);
    console.log(`  lastAutoReplyAt: ${c.lastAutoReplyAt}`);
    console.log(`  messages: ${c.messages.length}`);
    for (const m of c.messages) {
      console.log(`    [${m.direction}] ${m.content.slice(0, 50)} | ${m.sentAt.toISOString()}`);
    }
    console.log('');
  }

  const totalMsgs = await prisma.linkedInMessage.count();
  console.log(`Total messages in DB: ${totalMsgs}`);

  // Show orphaned messages (not linked to any conversation in our results)
  const allMsgs = await prisma.linkedInMessage.findMany({
    take: 10,
    orderBy: { sentAt: 'desc' },
    select: { id: true, conversationId: true, direction: true, content: true, sentAt: true },
  });
  console.log('\nLatest 10 messages (all conversations):');
  for (const m of allMsgs) {
    console.log(`  convId=${m.conversationId} [${m.direction}] ${m.content.slice(0, 40)} | ${m.sentAt.toISOString()}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
