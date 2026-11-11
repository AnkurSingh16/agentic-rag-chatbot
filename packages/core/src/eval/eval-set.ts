import { parse } from 'yaml';
import { z } from 'zod';
import { ChatbotError } from '../errors.js';

const QUESTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const questionSchema = z
  .strictObject({
    id: z.string().regex(QUESTION_ID, 'Must be a lower-case id'),
    question: z.string().trim().min(1),
    /** False for questions the documents cannot answer; the expected outcome is a refusal. */
    answerable: z.boolean().default(true),
    /** A reference answer, for answerable questions. */
    answer: z.string().trim().min(1).optional(),
    /** Source URIs that should be retrieved and cited, for answerable questions. */
    sources: z.array(z.string().min(1)).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.answerable && value.answer === undefined) {
      ctx.addIssue({ code: 'custom', path: ['answer'], message: 'Answerable questions need one' });
    }
    if (!value.answerable && (value.answer !== undefined || value.sources.length > 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['answerable'],
        message: 'Unanswerable questions have no answer or sources',
      });
    }
  });

/** Schema of an instance's eval set file (`evalSet` in instance.yaml). */
export const evalSetSchema = z
  .strictObject({ questions: z.array(questionSchema).min(1) })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.questions.forEach((question, index) => {
      if (seen.has(question.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['questions', index, 'id'],
          message: `Duplicate id "${question.id}"`,
        });
      }
      seen.add(question.id);
    });
  });

export type EvalSet = z.infer<typeof evalSetSchema>;
export type EvalQuestion = EvalSet['questions'][number];

/**
 * Parses and validates an eval set file. `runRetrievalEval` runs it against an
 * index version.
 *
 * @throws ChatbotError `invalid_config` naming the offending field.
 */
export function parseEvalSet(yamlText: string): EvalSet {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (error) {
    throw new ChatbotError('invalid_config', 'Eval set is not valid YAML', { cause: error });
  }
  const result = evalSetSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ChatbotError('invalid_config', `Invalid eval set: ${issues}`);
  }
  return result.data;
}
