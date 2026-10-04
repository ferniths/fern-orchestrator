import type { Task, WorkflowEdge, WorkflowNode } from '@shared/domain'
import { agentRoleSchema } from '@shared/domain'
import { z } from 'zod'
import type { AppContext } from '../kernel/appContext'
import { AppError } from '../kernel/errors'
import { newId } from '../kernel/ids'
import type { AutomationJob } from '@shared/domain'
import { looksLikeArtifactPath } from '../opencode/artifactCollector'
import { planUserPrompt } from './prompts'

export const planStepSchema = z.object({
  id: z.string().min(1).max(16),
  title: z.string().min(1),
  role: agentRoleSchema,
  dependsOn: z.array(z.string()).default([]),
  objective: z.string().default(''),
  prompt: z.string().min(1),
  expectedArtifacts: z.array(z.string()).default([]),
  successCriteria: z.array(z.string()).default([]),
  rationale: z.string().default(''),
  complexity: z.enum(['low', 'medium', 'high']).default('medium'),
  timeoutMinutes: z.number().int().min(1).max(240).default(30),
})
export type PlanStep = z.infer<typeof planStepSchema>

export const planDataSchema = z.object({
  summary: z.string().default(''),
  risks: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).default([]),
  steps: z.array(planStepSchema).min(1),
})
export type PlanData = z.infer<typeof planDataSchema>

/** Structured-output contract handed to the model's json_schema mode. */
export const PLAN_JSON_SCHEMA = {
  name: 'job_plan',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'risks', 'acceptance', 'steps'],
    properties: {
      summary: { type: 'string', description: 'One paragraph describing how the plan delivers the goal' },
      risks: { type: 'array', items: { type: 'string' } },
      acceptance: { type: 'array', items: { type: 'string' } },
      steps: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'title',
            'role',
            'dependsOn',
            'objective',
            'prompt',
            'expectedArtifacts',
            'successCriteria',
            'rationale',
            'complexity',
            'timeoutMinutes',
          ],
          properties: {
            id: { type: 'string', description: 'Short stable id like s1, s2' },
            title: { type: 'string' },
            role: { type: 'string', enum: [...agentRoleSchema.options] },
            dependsOn: { type: 'array', items: { type: 'string' } },
            objective: { type: 'string' },
            prompt: { type: 'string', description: 'Self-contained instruction for the worker' },
            expectedArtifacts: {
              type: 'array',
              items: { type: 'string' },
              description: 'File paths relative to the workspace that must exist when the step finishes (e.g. report.md). Never sentences or acceptance criteria.',
            },
            successCriteria: { type: 'array', items: { type: 'string' } },
            rationale: { type: 'string' },
            complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
            timeoutMinutes: { type: 'integer', minimum: 1, maximum: 240 },
          },
        },
      },
    },
  },
} as const

/** Review verdict contract for the loop/final review pass. */
export const REVIEW_JSON_SCHEMA = {
  name: 'job_review',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'summary', 'problems', 'changes'],
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail', 'needs_more_work', 'stop'] },
      summary: { type: 'string' },
      problems: { type: 'array', items: { type: 'string' } },
      changes: { type: 'array', items: { type: 'string' } },
    },
  },
} as const

export const reviewDataSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'needs_more_work', 'stop']),
  summary: z.string().default(''),
  problems: z.array(z.string()).default([]),
  changes: z.array(z.string()).default([]),
})
export type ReviewData = z.infer<typeof reviewDataSchema>

/**
 * Planner system prompt.
 *
 * `language` is the effective output language for the job. For the default
 * `English` no language line is added, so those prompts stay exactly as they
 * were before the output-language feature existed. Only user-facing prose is
 * localized: JSON keys, the `role`/`complexity` enums, step ids and the worker
 * instruction field `prompt` always stay in English.
 */
export function plannerSystemPrompt(language: string): string {
  const base =
    'You are the master planner for an autonomous engineering orchestrator. ' +
    'Break the goal into the smallest set of dependency-linked steps that a single AI worker can finish autonomously. ' +
    `Each step names one role from the allowed set, a self-contained prompt, and dependsOn ids (DAG: no cycles, no orphan references). ` +
    'Plan at most 12 steps. Prefer 3-8 steps. ' +
    'Workers may edit files, run tests and write docs in the project workspace. ' +
    'Do not plan git commits or pushes — approvals handle those.'
  // Independent steps stay independent: today models emit a fully linear chain,
  // which serializes work the scheduler could run with several workers at once.
  const parallelism =
    ' Prefer independent steps: add a dependsOn edge only when a step truly consumes another step\'s output — ' +
    'otherwise leave dependsOn empty so those steps can run concurrently and several workers execute in parallel.'
  const languageLine =
    !language || language === 'English'
      ? ''
      : ` Write the user-facing prose fields (summary, title, objective, rationale, risks, acceptance) in ${language}.` +
        ' Keep JSON keys, the role and complexity enum values, step ids and the worker instruction field `prompt` in English — worker task instructions are never localized.'
  return base + parallelism + languageLine
}

/** Plans one iteration: structured steps for the DAG, plus a human-readable plan text. */
export async function createPlan(
  ctx: AppContext,
  job: AutomationJob,
  loopIndex: number,
  prior?: { problems: string[]; summary: string },
  signal?: AbortSignal,
): Promise<{ text: string; data: PlanData }> {
  const language = job.language ?? ctx.config?.get?.()?.general.language ?? 'English'

  const project = job.projectId ? ctx.repos.projects.get(job.projectId) : null
  const user = planUserPrompt(job, loopIndex, prior, project, language)

  const res = await ctx.ai.runStructured({
    role: 'planner',
    jobId: job.id,
    ...(job.routeId ? { routeId: job.routeId } : {}),
    schema: planDataSchema,
    jsonSchema: PLAN_JSON_SCHEMA,
    messages: [
      { role: 'system', content: plannerSystemPrompt(language) },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    maxAttempts: 3,
    signal,
  })

  const data = res.data
  const text = [
    data.summary || job.title,
    '',
    ...data.steps.map((s, i) => {
      const deps = s.dependsOn.length ? ` (after: ${s.dependsOn.join(', ')})` : ''
      return `${i + 1}. **${s.title}** — ${s.role}${deps}\n   ${s.objective || s.prompt.slice(0, 160)}`
    }),
    data.risks.length ? `\nRisks:\n${data.risks.map((r) => `- ${r}`).join('\n')}` : '',
    data.acceptance.length ? `\nDone when:\n${data.acceptance.map((a) => `- ${a}`).join('\n')}` : '',
  ]
    .filter((l) => l !== undefined)
    .join('\n')

  return { text, data }
}

/* -------------------------------------------------------------------------- */

export interface CompiledPlan {
  tasks: (Partial<Task> & { jobId: string; loopIndex: number; title: string })[]
  nodes: (Omit<WorkflowNode, 'createdAt' | 'updatedAt' | 'jobId' | 'loopIndex'> & { taskId: string | null; x: number; y: number })[]
  edges: Omit<WorkflowEdge, 'createdAt' | 'updatedAt' | 'jobId' | 'loopIndex'>[]
}

function nodeKindFor(step: PlanStep, terminal: boolean): WorkflowNode['kind'] {
  if (terminal && (step.role === 'synthesizer' || step.role === 'integration')) return 'final'
  if (step.role === 'synthesizer' || step.role === 'integration') return 'integration'
  if (step.role === 'researcher' || step.role === 'knowledge') return 'research'
  if (step.role === 'reviewer' || step.role === 'final_reviewer' || step.role === 'security_reviewer') return 'review'
  if (step.role === 'tester') return 'validation'
  if (step.role === 'coder' || step.role === 'debugger' || step.role === 'ui_ux' || step.role === 'architect') return 'implementation'
  return 'task'
}

/**
 * Validates the planner's DAG and turns it into tasks + graph rows.
 * Throws `invalid_response` when ids collide, deps dangle, or a cycle exists.
 */
export function compilePlan(job: AutomationJob, loopIndex: number, plan: PlanData): CompiledPlan {
  const steps = plan.steps.map((step) => ({ ...step, dependsOn: [...new Set(step.dependsOn)] }))
  if (steps.length === 0) throw new AppError('invalid_response', 'plan contained no steps')

  const ids = new Set<string>()
  for (const step of steps) {
    if (ids.has(step.id)) throw new AppError('invalid_response', `duplicate step id: ${step.id}`)
    ids.add(step.id)
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id) throw new AppError('invalid_response', `step ${step.id} depends on itself`)
      if (!ids.has(dep)) throw new AppError('invalid_response', `step ${step.id} depends on unknown step: ${dep}`)
    }
  }

  // Kahn topological sort — any leftover nodes mean a cycle.
  const indegree = new Map(steps.map((s) => [s.id, s.dependsOn.length]))
  const children = new Map<string, string[]>(steps.map((s) => [s.id, []]))
  for (const step of steps) for (const dep of step.dependsOn) children.get(dep)!.push(step.id)
  const queue = steps.filter((s) => indegree.get(s.id) === 0).map((s) => s.id)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const child of children.get(id) ?? []) {
      indegree.set(child, indegree.get(child)! - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
  }
  if (order.length !== steps.length) {
    const stuck = steps.filter((s) => !order.includes(s.id)).map((s) => s.id)
    throw new AppError('invalid_response', `plan contains a dependency cycle involving: ${stuck.join(', ')}`)
  }

  const stepById = new Map(steps.map((s) => [s.id, s]))
  const taskIdByStep = new Map(steps.map((s) => [s.id, newId('tsk')]))
  // Node ids double as the workflow_nodes primary key, so they must stay unique
  // across every job and loop that re-plans the same step ids.
  const nodeIdByStep = new Map(steps.map((s) => [s.id, `n_${job.id}_${loopIndex}_${s.id}`]))
  const layerOf = new Map<string, number>()
  for (const id of order) {
    const step = stepById.get(id)!
    const layer = step.dependsOn.reduce((acc, dep) => Math.max(acc, (layerOf.get(dep) ?? -1) + 1), 0)
    layerOf.set(id, layer)
  }
  const perLayer = new Map<number, number>()
  const terminal = steps.filter((s) => !steps.some((o) => o.dependsOn.includes(s.id)))
  const terminalIds = new Set(terminal.map((s) => s.id))

  const tasks: CompiledPlan['tasks'] = []
  const nodes: CompiledPlan['nodes'] = []
  for (const step of steps) {
    const taskId = taskIdByStep.get(step.id)!
    const nodeId = nodeIdByStep.get(step.id)!
    const layer = layerOf.get(step.id) ?? 0
    const row = perLayer.get(layer) ?? 0
    perLayer.set(layer, row + 1)

    tasks.push({
      id: taskId,
      jobId: job.id,
      loopIndex,
      nodeId,
      title: step.title,
      objective: step.objective || step.prompt.slice(0, 200),
      role: step.role,
      prompt: step.prompt,
      dependencyIds: step.dependsOn.map((dep) => taskIdByStep.get(dep)!),
      expectedArtifacts: step.expectedArtifacts.filter(looksLikeArtifactPath),
      successCriteria: step.successCriteria,
      status: step.dependsOn.length === 0 ? 'ready' : 'pending',
      priority: 50,
      timeoutMs: step.timeoutMinutes * 60_000,
      attempt: 0,
      rationale: step.rationale,
      complexity: step.complexity,
      systemPrompt: '',
    })

    nodes.push({
      id: nodeId,
      taskId,
      kind: nodeKindFor(step, terminalIds.has(step.id)),
      label: step.title,
      detail: step.objective,
      rationale: step.rationale,
      state: step.dependsOn.length === 0 ? 'ready' : 'pending',
      priority: 50,
      timeoutMs: step.timeoutMinutes * 60_000,
      condition: null,
      x: 80 + layer * 300,
      y: 60 + row * 160,
    })
  }

  const edges: CompiledPlan['edges'] = []
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      edges.push({
        id: `e_${job.id}_${loopIndex}_${dep}_${step.id}`,
        sourceNodeId: nodeIdByStep.get(dep)!,
        targetNodeId: nodeIdByStep.get(step.id)!,
        kind: 'dependency',
        label: '',
      })
    }
  }

  return { tasks, nodes, edges }
}
