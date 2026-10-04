import type { AutomationJob } from '@shared/domain'
import type { AppContext } from '../kernel/appContext'

/**
 * The Refiner contract.
 *
 * The Refiner is a prompt-rewriting specialist, not a planner and not an
 * implementer. It takes the user's rough request and returns a cleaner
 * version of that same request — better wording, clearer intent, preserved
 * scope, preserved language (or the job's requested output language when one
 * is set). Anything else (code, shell commands, patches,
 * JSON workflows, worker/task decomposition, an answer to the original task)
 * is a contract violation and is repaired before the result is stored.
 */
export const REFINER_SYSTEM_PROMPT = [
  'You are a prompt refinement specialist.',
  '',
  'Your only job is to improve the wording of the request you are given. You do not do the work the request asks for.',
  '',
  'Procedure:',
  '1. Understand what the user is actually asking for.',
  '2. Preserve their intended scope, requirements and constraints exactly — invent nothing that conflicts with them.',
  '3. Resolve obvious ambiguity and make the request precise and self-contained.',
  '4. Preserve every important constraint the user stated.',
  '5. Preserve the user\'s language. English in, English out; German in, German out; Japanese in, Japanese out. Never translate, never switch language, never return two languages. Only technical terms that have no natural translation stay as they are.',
  '',
  'Output rules:',
  '- Return only the refined request — one polished natural-language paragraph, at most two.',
  '- Write it as a request the user could submit, not as an analysis of the request.',
  '- Do not answer the request yourself and do not start carrying it out.',
  '- Do not plan, decompose, schedule or estimate anything, and do not mention workers, agents, planners, models or the orchestration system.',
  '- Never output code, code snippets, file contents, diffs, patches, shell commands, terminal output, JSON, YAML, XML, tables or numbered step lists.',
  '- No preamble, no headings, no bullet points, no explanations, no "here is" phrasing, no quotation marks around the whole result.',
  '- If the original request is already clear, return a lightly polished version of it.',
].join('\n')

/**
 * Appended to the system message when an explicit non-English output language
 * is active. Rule 5 above preserves the *input* language; this overrides it so
 * the refined request comes back in the language the user asked for. Nothing is
 * appended for the default `English`, which keeps those prompts byte-identical.
 */
export function refinerSystemPrompt(language: string): string {
  if (!language || language === 'English') return REFINER_SYSTEM_PROMPT
  return [
    REFINER_SYSTEM_PROMPT,
    '',
    `Output language override: write the refined request in ${language}, even when the original request is written in a different language. This supersedes rule 5. Translate the request faithfully — keep every constraint, and leave code identifiers, file paths, commands and technical terms unchanged.`,
  ].join('\n')
}

/* -------------------------------------------------------------------------- */
/* Contract validation                                                         */
/* -------------------------------------------------------------------------- */

export interface RefinerViolation {
  code: 'code_fence' | 'shell' | 'code' | 'json' | 'patch' | 'plan' | 'language' | 'prose_wrappers' | 'truncated' | 'answered'
  detail: string
}

const FENCE = /```/

/** Lines that are shell commands: verb + (flag | path | file | known subcommand). */
const SHELL_LINE = new RegExp(
  String.raw`^\s*(?:` +
    String.raw`(?:npm|npx|pnpm|yarn|pnpx|bun|deno|node|python[23]?|pip[23]?|poetry|uv|ruby|bundle|php|composer|` +
    String.raw`go|cargo|rustc|javac|mvn|gradle|dotnet|make|cmake|docker|podman|kubectl|helm|terraform|ansible|` +
    String.raw`brew|apt(?:-get)?|dnf|yum|pacman|scoop|choco|winget|pacman|` +
    String.raw`git|gh|svn|hg|` +
    String.raw`cd|mkdir|rmdir|rm|cp|mv|touch|cat|head|tail|grep|rg|find|chmod|chown|ln|tar|unzip|curl|wget|ssh|scp|rsync|` +
    String.raw`code|vim|nano|open|start|explorer|powershell|pwsh|cmd|bash|zsh|sh|` +
    String.raw`Get-ChildItem|Set-Content|Get-Content|New-Item|Remove-Item|Test-Path|npm-run` +
    String.raw`)\b` +
    String.raw`(?:\s+(?:run|install|ci|test|start|build|dev|add|init|update|upgrade|publish|audit|serve|preview|lint|format|fix|` +
    String.raw`commit|push|pull|fetch|checkout|clone|merge|rebase|status|diff|branch|stash|reset|log|tag|cherry-pick|` +
    String.raw`exec|run-script|pack|link|list|show|info|config|login|logout|deploy|apply|plan|destroy|build|ps|logs|attach|` +
    String.raw`-{1,2}[\w-]+|` +
    String.raw`[./][\w./\\-]+|` +
    String.raw`[A-Za-z]:[\\/][\w.\\/-]+|` +
    String.raw`[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|sh|ps1|bat|cmd|json|ya?ml|toml|lock|md|txt|html|css|scss))` +
    String.raw`)\S*)`,
  'im',
)

const SHELL_PROMPT_MARKER = /^(?:\s)*(?:\$|PS\s+[A-Za-z]:\\|>|C:\\>)\s+\S/m

const CODE_DECLARATION =
  /(?:^|\n)\s*(?:import\s+[\w*{].*from\s+['"]|export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type)\s+\w|function\s+\w+\s*\([^)]*\)\s*\{|(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:\(|function|async|[\w.]+\(|`)|(?:public|private|protected|static)\s+[\w<>[\]]+\s+\w+\s*\(|def\s+\w+\s*\([^)]*\)\s*:?|class\s+\w+\s*(?:\(|extends|implements|\{))/

const CODE_PUNCTUATION = /(?:=>\s*\{|;\s*$|\b(?:else|try|catch|finally)\s*{)/m

const JSON_PAYLOAD = /^\s*[{[][\s\S]*[\]}]\s*$/

const PATCH_HUNK = /(?:^|\n)@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

const PLAN_TERMS = new RegExp(
  String.raw`\b(?:dependsOn|dependency[- ]ordered|DAG\b|task decomposition|execution plan|implementation plan|` +
    String.raw`model rout(?:e|ing)|worker\s+[a-z]\b|Create (?:Worker|Task|Agent)|assign(?:ed)? to (?:worker|agent)|` +
    String.raw`subagent|milestone\s+\d|phase\s+\d+\s*:)`,
  'i',
)

const IMPL_SENTENCE = new RegExp(
  String.raw`\b(?:run|execute|execute the following|install|execute this)\s+(?:the\s+)?(?:command\s+)?(?:\`|")?` +
    String.raw`(?:npm|npx|pnpm|yarn|pip|python|node|git|cargo|go|docker|make|brew|apt|powershell)\b`,
  'i',
)

/** Chat assistants greet, preface and explain — a submitted prompt never does. */
const CHAT_WRAPPER =
  /^\s*(?:sure\b|certainly\b|of course\b|here(?:'s| is| are)\b|as an ai\b|i (?:'d|would) (?:be happy|suggest|recommend)\b|let'?s (?:begin|start|get started)\b)/i

/**
 * Past-tense completion claims: the model reported the work as done instead of
 * rewriting the request. Observed end-to-end — the "refined" job prompt came
 * back as `Created harness-smoke-test.txt with exact content … DONE`, so the
 * planner inherited a report and built a verification-only plan. A request is
 * written in the imperative ("Create …"), never in the completed past ("Created …").
 */
const COMPLETION_CLAIM =
  /^\s*(?:created|built|made|completed|finished|implemented|resolved|verified|installed|executed|wrote|tested|fixed|updated|configured|deployed|deleted|removed|added|ran|done|all done|the (?:files?|work|task|request) (?:has|have) been)\b/i

/* letters → writing system, used for the language-preservation check */
const SCRIPT_RANGES: [RegExp, string][] = [
  [/\p{Script=Hiragana}|\p{Script=Katakana}/gu, 'kana'],
  [/\p{Script=Hangul}/gu, 'hangul'],
  [/\p{Script=Han}/gu, 'han'],
  [/\p{Script=Cyrillic}/gu, 'cyrillic'],
  [/\p{Script=Hebrew}/gu, 'hebrew'],
  [/\p{Script=Arabic}/gu, 'arabic'],
  [/\p{Script=Greek}/gu, 'greek'],
  [/\p{Script=Thai}/gu, 'thai'],
  [/\p{Script=Devanagari}/gu, 'devanagari'],
]

export interface ScriptProfile {
  letters: number
  nonAsciiLetters: number
  scripts: Record<string, number>
}

/** Counts letters per writing system so we can tell "same language" from "translated". */
export function scriptProfile(text: string): ScriptProfile {
  const profile: ScriptProfile = { letters: 0, nonAsciiLetters: 0, scripts: {} }
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue
    profile.letters++
    if (ch.charCodeAt(0) > 127) profile.nonAsciiLetters++
    for (const [re, name] of SCRIPT_RANGES) {
      re.lastIndex = 0
      if (re.test(ch)) {
        profile.scripts[name] = (profile.scripts[name] ?? 0) + 1
        break
      }
    }
  }
  return profile
}

function dominantNonLatin(profile: ScriptProfile): { name: string; count: number } | null {
  let best: { name: string; count: number } | null = null
  for (const [name, count] of Object.entries(profile.scripts)) {
    if (!best || count > best.count) best = { name, count }
  }
  return best && best.count >= 3 ? best : null
}

/** Words that mark English prose and almost never appear in another language. */
const ENGLISH_MARKERS = [
  'the', 'and', 'that', 'with', 'this', 'from', 'when', 'then', 'they', 'their', 'there',
  'which', 'what', 'where', 'your', 'would', 'should', 'about', 'other', 'into', 'after',
  'before', 'only', 'been', 'have', 'than', 'them', 'these', 'those', 'while', 'because',
]

/** Content-word overlap: how much of the refinement still uses the original's vocabulary. */
function lexicalOverlap(original: string, refined: string): number {
  const before = new Set(original.toLowerCase().match(/\p{L}{4,}/gu) ?? [])
  const after = refined.toLowerCase().match(/\p{L}{4,}/gu) ?? []
  if (after.length === 0) return 1
  let hits = 0
  for (const token of after) if (before.has(token)) hits++
  return hits / after.length
}

function englishMarkerCount(text: string): number {
  const words = text.toLowerCase().match(/\p{L}{2,}/gu) ?? []
  let hits = 0
  for (const w of words) if (ENGLISH_MARKERS.includes(w)) hits++
  return hits
}

/**
 * Does `text` read as the requested output language? Best-effort by writing
 * system: Japanese is script-detectable, the Latin-script languages are not
 * (Spanish, Portuguese, Patois and English share an alphabet), so any Latin
 * text counts as a match rather than risking a false rejection. Returns false
 * only when the text is confidently written in a different script.
 */
function matchesOutputLanguage(language: string, profile: ScriptProfile): boolean {
  if (language === 'Japanese') {
    const japanese = (profile.scripts['kana'] ?? 0) + (profile.scripts['han'] ?? 0)
    return japanese >= 3 || japanese / Math.max(1, profile.letters) > 0.3
  }
  return !dominantNonLatin(profile)
}

/**
 * Detects a language switch. The original is the authority: if it is written
 * in a non-Latin script, the refinement must keep that script; if it is plain
 * English, the refinement must keep English vocabulary instead of coming back
 * translated (Latin script, different words) or heavily accented.
 *
 * `targetLanguage` is the job's requested output language. When it is not the
 * default `English`, output written in that language is never a switch — the
 * validator must not reject the very language the user asked for. With the
 * default target the original behaviour (preserve the input language) applies
 * unchanged.
 */
export function languageSwitched(original: string, refined: string, targetLanguage = 'English'): boolean {
  const a = scriptProfile(original)
  const b = scriptProfile(refined)
  if (a.letters === 0 || b.letters === 0) return false

  if (targetLanguage !== 'English' && matchesOutputLanguage(targetLanguage, b)) return false

  const aDom = dominantNonLatin(a)
  if (aDom) {
    const kept = (b.scripts[aDom.name] ?? 0) / Math.max(1, b.letters)
    return kept < 0.15
  }

  // Original is Latin/ASCII: a non-Latin script is always a switch.
  const bDom = dominantNonLatin(b)
  if (bDom) return true

  // Accented-Latin flood that plain English would never produce.
  if (b.nonAsciiLetters / b.letters > 0.05 && a.nonAsciiLetters / a.letters < 0.01) return true

  // Same script, different language: the refinement dropped almost all of the
  // original vocabulary and does not carry English function words. A heavily
  // reworded but same-language answer still shares vocabulary or reads English.
  if (englishMarkerCount(refined) >= 2) return false
  const after = refined.match(/\p{L}{4,}/gu) ?? []
  if (after.length < 6) return false
  return lexicalOverlap(original, refined) < 0.2
}

/** Everything that makes a "refined prompt" unusable as a prompt. */
export function detectViolations(original: string, refined: string, targetLanguage = 'English'): RefinerViolation[] {
  const out: RefinerViolation[] = []
  const text = refined.trim()
  if (!text) return out

  // A refinement that kept almost none of the original is a truncation, not a
  // rewrite. A real regression observed end-to-end: a prompt ending in
  // "Reply with DONE when both files exist." came back as the single word
  // `DONE`, which sailed through every structural check and then steered the
  // planner into a verification-only plan. Note that `DONE` scores high on
  // vocabulary overlap because it is quoted inside the original, so the
  // collapse test needs an absolute floor as well: no genuine refinement of a
  // real request is a handful of characters. Length alone across languages
  // would be wrong, so a requested translation is exempt.
  const requestedTranslation = targetLanguage !== 'English' && !languageSwitched(original, text, targetLanguage)
  const source = original.trim()
  if (!requestedTranslation && source.length >= 40) {
    const severelyShort = text.length < source.length * 0.3
    const degenerate = text.length < 60 || text.split(/\s+/).length < 6 || lexicalOverlap(source, text) < 0.2
    if (severelyShort && degenerate) {
      out.push({
        code: 'truncated',
        detail: `keeps only ${text.length} of ${source.length} characters instead of the original request`,
      })
    }
  }

  if (FENCE.test(text)) out.push({ code: 'code_fence', detail: 'contains a fenced code block' })
  if (SHELL_PROMPT_MARKER.test(text)) out.push({ code: 'shell', detail: 'contains a shell prompt/command' })
  else if (SHELL_LINE.test(text)) out.push({ code: 'shell', detail: 'contains a shell command line' })
  else if (IMPL_SENTENCE.test(text)) out.push({ code: 'shell', detail: 'contains an instruction to run a command' })

  if (PATCH_HUNK.test(text)) out.push({ code: 'patch', detail: 'contains a diff/patch' })
  else if (JSON_PAYLOAD.test(text)) out.push({ code: 'json', detail: 'is a JSON payload instead of a request' })

  if (CODE_DECLARATION.test(text) || CODE_PUNCTUATION.test(text)) {
    out.push({ code: 'code', detail: 'contains source code' })
  }
  if (PLAN_TERMS.test(text)) out.push({ code: 'plan', detail: 'reads like a work plan or worker breakdown' })
  if (CHAT_WRAPPER.test(text)) out.push({ code: 'prose_wrappers', detail: 'answers the request instead of rewriting it' })
  if (COMPLETION_CLAIM.test(text)) {
    out.push({ code: 'answered', detail: 'reports the work as completed instead of restating the request' })
  }
  if (languageSwitched(original, text, targetLanguage)) {
    out.push({
      code: 'language',
      detail:
        targetLanguage === 'English'
          ? 'switched away from the original language'
          : `switched away from the original language and is not written in ${targetLanguage}`,
    })
  }

  return out
}

/* -------------------------------------------------------------------------- */
/* Repair pass                                                                 */
/* -------------------------------------------------------------------------- */

function stripWrappers(text: string): string {
  return text
    .replace(/^\s*(?:refined request|refined prompt|output)\s*:\s*/i, '')
    .replace(/^["“']([\s\S]*)["”']$/, '$1')
    .trim()
}

const MAX_ATTEMPTS = 3

/**
 * Rewrites the user's rough prompt into a precise, natural-language request.
 *
 * Runs the model, validates the output against the Refiner contract, and
 * regenerates with a corrective instruction when it comes back as code, a
 * shell session, a work plan or the wrong language. If every attempt is
 * unusable the original prompt is returned unchanged — a rough prompt is
 * always a valid prompt; malformed model output never is.
 *
 * The output language is the job's per-job override, falling back to the
 * global Settings → General language (`English` when neither is available).
 */
export async function refinePrompt(ctx: AppContext, job: AutomationJob, signal?: AbortSignal): Promise<string> {
  const original = job.originalPrompt
  const language = job.language ?? globalLanguage(ctx)
  const messages = [
    { role: 'system' as const, content: refinerSystemPrompt(language) },
    { role: 'user' as const, content: original },
  ]

  let lastRejected = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await ctx.ai.runText({
      role: 'refiner',
      jobId: job.id,
      ...(job.routeId ? { routeId: job.routeId } : {}),
      messages:
        attempt === 1 ? messages : [...messages, { role: 'user' as const, content: repairInstruction(lastRejected, language) }],
      temperature: 0.2,
      signal,
    })

    const refined = stripWrappers(result.text)
    const violations = detectViolations(original, refined, language)
    if (violations.length === 0 && refined.trim()) return refined.trim()

    lastRejected = violations.map((v) => v.detail).join('; ') || 'was empty'
    ctx.log('orchestration').warn('refiner output rejected', { jobId: job.id, attempt, violations: lastRejected })
  }

  ctx.log('orchestration').warn('refiner could not produce a valid prompt — keeping the original', { jobId: job.id })
  return original
}

/** Global output language; tolerant of test contexts that stub only `ai`/`log`. */
function globalLanguage(ctx: AppContext): string {
  return ctx.config?.get?.()?.general.language ?? 'English'
}

function repairInstruction(violations: string, language = 'English'): string {
  const languageClause =
    language === 'English'
      ? 'and in the same language as the original request'
      : `and written in ${language}`
  return [
    `Your previous reply violated the refinement contract: ${violations}.`,
    'Reply again with only the refined request itself.',
    `It must be natural language only — no code, no commands, no JSON, no patches, no steps, no worker or task breakdown, ${languageClause}.`,
  ].join(' ')
}
