/**
 * Content Scorer Service
 *
 * Uses GPT-4o-mini to score a LinkedIn post across three dimensions:
 * - hookScore (0–100): how compelling is the opening line
 * - readabilityScore (0–100): ease of reading, short sentences, clear language
 * - ctaScore (0–100): clarity and strength of the call to action
 *
 * Returns structured scores + improvement suggestions.
 */

import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const LLM_MODEL = process.env.LLM_MODEL ?? 'gpt-4o-mini';

export interface PostScoreResult {
  hookScore: number;
  readabilityScore: number;
  ctaScore: number;
  suggestions: string;
}

const SYSTEM_PROMPT = `You are an expert LinkedIn content strategist.
Score the provided LinkedIn post on three dimensions (each 0-100):

1. hookScore: How compelling is the opening line? Does it stop the scroll? Score 0-100.
2. readabilityScore: Is the post easy to read? Short sentences, clear language, good formatting? Score 0-100.
3. ctaScore: How clear and compelling is the call to action (CTA)? Does it tell the reader what to do next? Score 0-100.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "hookScore": <number>,
  "readabilityScore": <number>,
  "ctaScore": <number>,
  "suggestions": "<brief actionable improvement suggestions in 1-3 sentences>"
}`;

/**
 * Scores a LinkedIn post text using GPT-4o-mini.
 * Returns structured scores and suggestions.
 */
export async function scorePost(text: string): Promise<PostScoreResult> {
  if (!text || text.trim().length === 0) {
    throw new Error('Post text cannot be empty');
  }

  const userContent = `Score this LinkedIn post:\n\n---\n${text}\n---`;

  const completion = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    max_tokens: 300,
    temperature: 0.3,
    response_format: { type: 'json_object' },
  });

  const raw = completion.choices[0]?.message?.content?.trim();

  if (!raw) {
    throw new Error('GPT-4o-mini returned an empty response for content scoring');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse GPT-4o-mini scoring response as JSON: ${raw}`);
  }

  const hookScore = clamp(Number(parsed['hookScore'] ?? 50), 0, 100);
  const readabilityScore = clamp(Number(parsed['readabilityScore'] ?? 50), 0, 100);
  const ctaScore = clamp(Number(parsed['ctaScore'] ?? 50), 0, 100);
  const suggestions = String(parsed['suggestions'] ?? '');

  return { hookScore, readabilityScore, ctaScore, suggestions };
}

function clamp(value: number, min: number, max: number): number {
  if (isNaN(value)) return Math.floor((min + max) / 2);
  return Math.max(min, Math.min(max, Math.round(value)));
}
