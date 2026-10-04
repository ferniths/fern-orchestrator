import type { AutomationJob, Project } from '@shared/domain'

/** Human-readable context handed to the planner for one iteration. */
export function planUserPrompt(
  job: AutomationJob,
  loopIndex: number,
  prior?: { problems: string[]; summary: string },
  project?: Project | null,
  language: string = 'English',
): string {
  const parts = [
    `Goal: ${job.refinedPrompt || job.originalPrompt}`,
    '',
    `Iteration: ${loopIndex} of ${job.loopCount}`,
    project
      ? `Project: ${project.name} at ${project.path} (workers edit this folder directly)`
      : `Project: none — use the job workspace ${job.workspacePath ?? '(assigned at run time)'}`,
    `Workspace: ${job.workspacePath ?? '(assigned at run time)'}`,
  ]
  if (prior && (prior.problems.length || prior.summary)) {
    parts.push('', 'Previous iteration review — address these problems in the new plan:')
    if (prior.summary) parts.push(`Review summary: ${prior.summary}`)
    for (const p of prior.problems) parts.push(`- ${p}`)
  }
  if (language && language !== 'English') {
    parts.push(
      '',
      `Write the prose fields the user reads (summary, title, objective, rationale, risks, acceptance) in ${language}; ` +
        'keep JSON keys, role/complexity enum values and the `prompt` worker instruction in English.',
    )
  }
  parts.push('', 'Produce the step DAG as JSON.')
  return parts.join('\n')
}
