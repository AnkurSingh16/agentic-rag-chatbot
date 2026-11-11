import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatbotError, loadInstanceConfig, parseEvalSet } from '@agentic-rag/core';
import type { CliContext } from '../context.js';
import { checkInstanceId, instanceDirectory } from '../context.js';

function instanceYaml(id: string): string {
  return `# Instance configuration. Reference: docs/reference/instance-config.md
id: ${id}
displayName: ${id} assistant
persona:
  systemPrompt: You answer questions using only the documents provided for this instance.
  answerStyle: Short, factual answers in plain English, with citations.
  outOfScope: I can only answer questions about the documents for this assistant.
# Chat model: LLM_MODEL or claude-haiku-5-5 unless set here, e.g. models.chat: claude-sonnet-5-5.
# Local embeddings run inside Node; EMBEDDING_PROVIDER=mock overrides them for offline use.
# Switching provider or model needs a new training run.
embedding:
  provider: local
  model: Xenova/all-MiniLM-L6-v2
auth:
  mode: public
allowedOrigins:
  - http://localhost:5173
sources:
  - type: folder
    path: data
evalSet: evals.yaml
`;
}

const SAMPLE_DOCUMENT = `# Welcome

This is a sample document. Replace it with your own markdown or text files in this folder.

## Opening hours

The help desk is open Monday to Friday, 9am to 5pm.

## Contact

Email the help desk at help@example.com.
`;

const SAMPLE_EVALS = `# Questions that "ragctl eval" asks this instance.
# Format: docs/guides/create-an-instance.md
questions:
  - id: opening-hours
    question: When is the help desk open?
    answer: Monday to Friday, 9am to 5pm.
    sources: [data/welcome.md]
  - id: contact
    question: How do I contact the help desk?
    answer: Email help@example.com.
    sources: [data/welcome.md]
  - id: unanswerable-pricing
    question: How much does the premium plan cost?
    answerable: false
`;

export async function initCommand(
  context: CliContext,
  positionals: readonly string[],
  instancesDir: string,
): Promise<void> {
  if (positionals.length > 1) {
    throw new ChatbotError('invalid_input', 'Usage: ragctl init <id>');
  }
  const id = checkInstanceId(positionals[0]);
  const directory = instanceDirectory(context, instancesDir, id);
  const config = instanceYaml(id);
  // Generated files must always pass the same validation train applies.
  loadInstanceConfig(config, {});
  parseEvalSet(SAMPLE_EVALS);

  await mkdir(join(directory, '..'), { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ChatbotError('invalid_input', `${directory} already exists; nothing was changed`);
    }
    throw error;
  }
  await mkdir(join(directory, 'data'));
  await writeFile(join(directory, 'instance.yaml'), config);
  await writeFile(join(directory, 'data', 'welcome.md'), SAMPLE_DOCUMENT);
  await writeFile(join(directory, 'evals.yaml'), SAMPLE_EVALS);

  context.stdout(`Created ${directory}
  instance.yaml    public mode, local embeddings
  data/welcome.md  sample document
  evals.yaml       sample eval set

Next: edit instance.yaml, add documents to data/, then run "ragctl train ${id}".
`);
}
