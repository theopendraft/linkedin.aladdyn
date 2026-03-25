import prisma from '../lib/prisma';
import { sendDM } from './inboxReader';

export interface TemplateContext {
  name?: string;
  company?: string;
  post_title?: string;
  job_title?: string;
}

export interface EnrollParams {
  sequenceId: string;
  profileId: string;
  triggerPostTitle?: string;
}

export interface SequenceProcessResult {
  processed: number;
  sent: number;
  completed: number;
  errors: number;
}

/**
 * Replace {{name}}, {{company}}, {{post_title}}, {{job_title}} tokens
 * in a template string with values from context, using sensible fallbacks.
 */
export function resolveTemplate(
  template: string,
  context: TemplateContext
): string {
  return template
    .replace(/\{\{name\}\}/g, context.name || 'there')
    .replace(/\{\{company\}\}/g, context.company || 'your company')
    .replace(/\{\{post_title\}\}/g, context.post_title || 'a recent post')
    .replace(/\{\{job_title\}\}/g, context.job_title || 'your role');
}

/**
 * Processes all sequence enrollments where nextStepAt <= now.
 * Each enrollment is handled independently — a single failure does not
 * stop the rest of the batch.
 */
export async function processSequenceDueMessages(): Promise<SequenceProcessResult> {
  const now = new Date();
  let processed = 0;
  let sent = 0;
  let completed = 0;
  let errors = 0;

  const enrollments = await prisma.linkedInSequenceEnrollment.findMany({
    where: {
      status: 'ACTIVE',
      nextStepAt: { lte: now },
    },
    include: {
      sequence: {
        include: { account: true },
      },
      currentStep: true,
      profile: true,
    },
  });

  for (const enrollment of enrollments) {
    processed++;

    try {
      const { sequence, profile } = enrollment;

      // Skip if sequence is no longer active
      if (sequence.status !== 'ACTIVE') {
        continue;
      }

      // --- Daily message limit ---
      const resetDate = sequence.messageLimitReset
        ? new Date(sequence.messageLimitReset)
        : null;

      if (!resetDate || resetDate < now) {
        // Reset counter for the new day
        await prisma.linkedInSequence.update({
          where: { id: sequence.id },
          data: {
            messagesSentToday: 0,
            messageLimitReset: new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate() + 1
            ),
          },
        });
        sequence.messagesSentToday = 0;
      }

      if (sequence.messagesSentToday >= (sequence.maxDailyMessages ?? 30)) {
        continue;
      }

      // --- Determine current step ---
      let step = enrollment.currentStep;

      if (!step) {
        // First step — find the one with the lowest order
        step = await prisma.linkedInSequenceStep.findFirst({
          where: { sequenceId: sequence.id },
          orderBy: { order: 'asc' },
        });
      }

      if (!step) {
        continue;
      }

      // --- Resolve message template ---
      const message = resolveTemplate(step.template, {
        name: profile.name ?? undefined,
        company: profile.company ?? undefined,
        post_title: enrollment.triggerPostTitle ?? undefined,
        job_title: profile.jobTitle ?? undefined,
      });

      // --- Send the DM ---
      await sendDM({
        accountId: sequence.account.id,
        participantLinkedInId: profile.linkedinId,
        message,
      });

      sent++;

      // --- Advance to next step or complete ---
      const nextStep = await prisma.linkedInSequenceStep.findFirst({
        where: {
          sequenceId: sequence.id,
          order: step.order + 1,
        },
      });

      if (nextStep) {
        await prisma.linkedInSequenceEnrollment.update({
          where: { id: enrollment.id },
          data: {
            currentStepId: nextStep.id,
            nextStepAt: new Date(
              now.getTime() + nextStep.delayHours * 3600 * 1000
            ),
            lastMessageAt: now,
          },
        });
      } else {
        // Sequence complete
        await prisma.linkedInSequenceEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: 'COMPLETED',
            completedAt: now,
            lastMessageAt: now,
          },
        });
        completed++;
      }

      // Increment daily counter
      await prisma.linkedInSequence.update({
        where: { id: sequence.id },
        data: {
          messagesSentToday: { increment: 1 },
        },
      });
    } catch (err) {
      errors++;
      console.error(
        `[SequenceEngine] Error processing enrollment ${enrollment.id}:`,
        err
      );
    }
  }

  console.log(
    `[SequenceEngine] Processed ${processed} enrollments: ${sent} sent, ${completed} completed, ${errors} errors`
  );

  return { processed, sent, completed, errors };
}

/**
 * Enrolls a profile in a sequence. Validates sequence status and applies
 * filter matching. Uses upsert to prevent duplicate enrollments.
 */
export async function enrollProfileInSequence(
  params: EnrollParams
): Promise<void> {
  const { sequenceId, profileId, triggerPostTitle } = params;

  const sequence = await prisma.linkedInSequence.findUnique({
    where: { id: sequenceId },
  });

  if (!sequence || sequence.status !== 'ACTIVE') {
    return;
  }

  const profile = await prisma.linkedInProfile.findUnique({
    where: { id: profileId },
  });

  if (!profile) {
    return;
  }

  // --- Check filters ---
  if (
    sequence.filterJobTitle &&
    (!profile.jobTitle ||
      !profile.jobTitle
        .toLowerCase()
        .includes(sequence.filterJobTitle.toLowerCase()))
  ) {
    return;
  }

  if (
    sequence.filterCompany &&
    (!profile.company ||
      !profile.company
        .toLowerCase()
        .includes(sequence.filterCompany.toLowerCase()))
  ) {
    return;
  }

  if (
    sequence.filterIndustry &&
    (!profile.industry ||
      !profile.industry
        .toLowerCase()
        .includes(sequence.filterIndustry.toLowerCase()))
  ) {
    return;
  }

  if (
    sequence.filterLocation &&
    (!profile.location ||
      !profile.location
        .toLowerCase()
        .includes(sequence.filterLocation.toLowerCase()))
  ) {
    return;
  }

  // --- Find first step ---
  const firstStep = await prisma.linkedInSequenceStep.findFirst({
    where: { sequenceId },
    orderBy: { order: 'asc' },
  });

  if (!firstStep) {
    return;
  }

  const now = new Date();

  await prisma.linkedInSequenceEnrollment.upsert({
    where: {
      sequenceId_profileId: {
        sequenceId,
        profileId,
      },
    },
    create: {
      sequenceId,
      profileId,
      status: 'ACTIVE',
      currentStepId: firstStep.id,
      nextStepAt: new Date(now.getTime() + firstStep.delayHours * 3600 * 1000),
      triggerPostTitle,
    },
    update: {},
  });
}

/**
 * Auto-enrolls profiles that engaged with a given post into any sequences
 * configured to trigger on POST_ENGAGEMENT for that post.
 * Returns the total number of profiles enrolled.
 */
export async function autoEnrollEngagedProfiles(
  postId: string
): Promise<number> {
  let totalEnrolled = 0;

  const sequences = await prisma.linkedInSequence.findMany({
    where: {
      triggerType: 'POST_ENGAGEMENT',
      triggerPostId: postId,
      status: 'ACTIVE',
    },
  });

  for (const sequence of sequences) {
    const engagements = await prisma.linkedInEngagement.findMany({
      where: {
        postId,
        ...(sequence.triggerEngagementTypes &&
        sequence.triggerEngagementTypes.length > 0
          ? { type: { in: sequence.triggerEngagementTypes } }
          : {}),
      },
      include: { profile: true },
    });

    for (const engagement of engagements) {
      if (!engagement.profile) {
        continue;
      }

      try {
        await enrollProfileInSequence({
          sequenceId: sequence.id,
          profileId: engagement.profile.id,
        });
        totalEnrolled++;
      } catch (err) {
        console.error(
          `[SequenceEngine] Failed to enroll profile ${engagement.profile.id} in sequence ${sequence.id}:`,
          err
        );
      }
    }
  }

  return totalEnrolled;
}
