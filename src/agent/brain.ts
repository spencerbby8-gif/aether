import type {
  ContextPack,
  Observation,
  PlanStepSpec,
  StepState,
  TaskStep,
  ToolSchema,
} from "@/lib/types";
import { truncate, uid } from "@/lib/utils";

/**
 * The Phase 2 stand-in intelligence.
 * Pure TypeScript, deterministic, no DOM/Node APIs — it runs identically in
 * the browser (MockAgentModel) and on the server (/api/agent/model).
 * It only ever selects tools from the schemas it is given, which keeps the
 * orchestration loop honest: the remote model will do the same in Phase 3.
 * Internal reasoning is never exposed — only safe, user-facing outputs.
 */

const TASK_VERBS =
  /(search|find|look up|lookup|earlier|previous|before|history|recall|remember|save|note|record|draft|write|create|build|analy[sz]e|compare|audit|review|summar|checklist|plan|roadmap|gather|collect|run|execute|install|fetch|crawl|screenshot|inspect|fix|draw|paint|generate|render|compose|synthesize|edit|upscale)/;

/* ---------------- Phase 4: media intent detection ---------------- */

const MEDIA = {
  imageEdit:
    /\bedit\b.*\b(image|picture|photo|it)\b|(brighten|darken|desaturate|saturate|blur|invert|soften)\b.*\b(image|picture|photo|it|this)\b|\b(image|picture|photo|it)\b\s+(gr[ae]yscale|black and white|b&w|sepia|warmer?|cooler?|blurry|darker|brighter|muted?|inverted)\b|make (it|this)( image)? (gr[ae]yscale|brighter|darker|warmer?|cooler?|sepia|blurry|inverted|muted?|black and white)/i,
  upscale: /\bupscale\b|higher res|high.?resolution version|sharper|2x\b/,
  video: /(generate|create|make|render|animate|produce)\b.*\b(video|clip|animation)\b|\bvideo of\b/,
  audio: /(generate|create|compose|make|synthesize|play)\b.*\b(audio|sound|music|melody|tune|tone|song)\b|\baudio clip\b/,
  image: /(draw|paint|sketch|generate|create|make|design|render)\b.*\b(image|picture|artwork|art|illustration|poster|wallpaper)\b|^(draw|paint)\s/,
  highQuality: /\bhigh.?quality\b|\b4k\b|upscaled|enhanced|ultra|hi.?res\b/,
  variants: /\btwo\b|\b2 (versions|variants|images)\b|variants?\b|versions?\b/,
};

/* ---------------- Phase 3: code templates that really run ---------------- */

export interface CodeTemplate {
  path: string;
  content: string;
  command: string;
  args: string[];
}

const TEMPLATES: Array<{ match: RegExp; template: CodeTemplate }> = [
  {
    match: /fib|fibonacci/,
    template: {
      path: "fib.js",
      command: "node",
      args: ["fib.js"],
      content: `// Prints the first 10 Fibonacci numbers.
const out = [];
let a = 0, b = 1;
for (let i = 0; i < 10; i += 1) {
  out.push(a);
  [a, b] = [b, a + b];
}
console.log(out.join(" "));
`,
    },
  },
  {
    match: /prime/,
    template: {
      path: "primes.js",
      command: "node",
      args: ["primes.js"],
      content: `// Prints the first 15 primes.
const isPrime = (n) => {
  for (let i = 2; i * i <= n; i += 1) if (n % i === 0) return false;
  return n > 1;
};
const primes = [];
for (let n = 2; primes.length < 15; n += 1) if (isPrime(n)) primes.push(n);
console.log(primes.join(" "));
`,
    },
  },
  {
    match: /sort/,
    template: {
      path: "sort.js",
      command: "node",
      args: ["sort.js"],
      content: `// Sorts sample data and prints before/after.
const data = [42, 7, 19, 3, 88, 25];
console.log("before:", data.join(" "));
data.sort((x, y) => x - y);
console.log("after: ", data.join(" "));
`,
    },
  },
];

const DEFAULT_TEMPLATE: CodeTemplate = {
  path: "hello.js",
  command: "node",
  args: ["hello.js"],
  content: `console.log("Hello from the Aether sandbox workspace.");
console.log("node", process.version);
`,
};

export function codeTemplateFor(goal: string): CodeTemplate {
  const g = goal.toLowerCase();
  for (const entry of TEMPLATES) {
    if (entry.match.test(g)) return entry.template;
  }
  return DEFAULT_TEMPLATE;
}

function packageFrom(goal: string): string {
  const match = /(?:install|add)\s+(?:the\s+)?(?:package\s+|npm package\s+)?([a-z0-9@/._-]{2,})/i.exec(goal);
  const name = match?.[1]?.toLowerCase().replace(/[.,!?]$/, "") ?? "left-pad";
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name) ? name : "left-pad";
}

function urlFrom(goal: string): string {
  const match = /(https?:\/\/[^\s"',)]+)/i.exec(goal);
  return match?.[1] ?? "https://example.com";
}

export function brainPlan(goal: string, tools: ToolSchema[]): { steps: PlanStepSpec[] } {
  const names = new Set(tools.map((t) => t.name));
  const g = goal.toLowerCase();
  const steps: PlanStepSpec[] = [];
  const add = (title: string, tool?: string) => steps.push({ id: uid(), title, tool, intent: goal });

  /* Media workflows take priority: editing > upscaling > video > audio > images. */
  if (MEDIA.imageEdit.test(g) && names.has("image.edit")) {
    add("Edit the conversation image", "image.edit");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }
  if (MEDIA.upscale.test(g) && names.has("media.upscale")) {
    add("Upscale the conversation image", "media.upscale");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }
  if (MEDIA.video.test(g) && names.has("video.generate")) {
    add("Render the video clip", "video.generate");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }
  if (MEDIA.audio.test(g) && names.has("audio.generate")) {
    add("Synthesize the audio clip", "audio.generate");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }
  if (MEDIA.image.test(g) && names.has("image.generate")) {
    const high = MEDIA.highQuality.test(g);
    add(high ? "Generate artwork (enhance + upscale pipeline)" : "Generate artwork", "image.generate");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }

  const codeWorkflow =
    /(create|write|make|build|add)\b.*\b(script|program|file|code|app)\b|\brun\b.*\b(script|code|program)\b|fibonacci|fib\b|primes?\b/.test(g) ||
    (/(script|program)/.test(g) && /(run|execute|show)/.test(g));

  /* Real-execution workflows take priority over workspace/memory heuristics. */
  if (codeWorkflow && names.has("fs.write") && names.has("shell.run")) {
    if (/(inspect|look at|check)/.test(g) && names.has("fs.list")) add("Inspect the workspace", "fs.list");
    add("Write the source file", "fs.write");
    add("Run it in the sandbox", "shell.run");
    if (/(error|fix|debug|fail)/.test(g) && names.has("fs.read")) add("Inspect the output for errors", "fs.read");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }
  if (/(install|add)\b.*\bpackage\b|npm install/.test(g) && names.has("package.install")) {
    add(`Install ${packageFrom(goal)}`, "package.install");
    if (names.has("package.list")) add("Verify installed packages", "package.list");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }
  if (/(screenshot|capture)\b.*\b(page|site|url|screen)|screenshot of/.test(g) && names.has("web.screenshot")) {
    add("Capture the page screenshot", "web.screenshot");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }
  if (/\bcrawl\b/.test(g) && names.has("web.crawl")) {
    add("Crawl from the seed URL", "web.crawl");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }
  if (/(search the web|web search|search online|look up online|news about)/.test(g) && names.has("web.search")) {
    add("Search the web", "web.search");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }
  if (/(fetch|open|read|download|get)\b.*\b(page|site|url|https?:\/\/)|https?:\/\//.test(g) && names.has("web.fetch")) {
    add("Fetch the page content", "web.fetch");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }
  if (/(inspect|explore|list)\b.*\b(files?|dir|directory|workspace)|show (me )?the files/.test(g) && names.has("fs.list")) {
    add("List the workspace files", "fs.list");
    if (names.has("fs.read")) add("Read a relevant file", "fs.read");
    steps.push({ id: uid(), title: "Compose the result" });
    return { steps };
  }

  if (/(search|find|look up|lookup|earlier|previous|before|history)/.test(g) && names.has("workspace.search")) {
    add("Search the workspace for related context", "workspace.search");
  }
  if (/(file|attachment|image|document)/.test(g) && names.has("workspace.files")) {
    add("Inspect stored files", "workspace.files");
  }
  if (/(recall|remember|know about|memory|notes about)/.test(g) && names.has("memory.read")) {
    add("Recall stored memory", "memory.read");
  }
  if (/(prefer|always|never|my style|i like)/.test(g) && names.has("preference.save")) {
    add("Save a user preference (needs approval)", "preference.save");
  } else if (/(remember|save|keep|note this)/.test(g) && names.has("memory.save")) {
    add("Store a fact in memory", "memory.save");
  }
  if (steps.length > 0 && /(record|note|log|write down)/.test(g) && names.has("task.note")) {
    add("Record working notes", "task.note");
  }
  steps.push({ id: uid(), title: steps.length > 0 ? "Compose the result" : "Answer directly" });
  return { steps };
}

/** True when the goal is worth a visible multi-step run (vs. a quick answer). */
export function isTaskGoal(goal: string): boolean {
  return TASK_VERBS.test(goal.toLowerCase()) && goal.trim().length > 12;
}

function summarizeObservations(observations: Observation[]): string {
  const useful = observations.filter((o) => o.ok);
  if (useful.length === 0) return "";
  return useful.map((o) => o.text).join("\n");
}

export type BrainStepDecision =
  | { type: "tool_call"; tool: string; args: Record<string, unknown>; description?: string }
  | { type: "answer"; text: string };

export function brainStep(input: {
  goal: string;
  context: ContextPack;
  steps: TaskStep[];
  currentStep: TaskStep;
  observations: Observation[];
  corrections: string[];
  tools: ToolSchema[];
}): BrainStepDecision {
  const { goal, currentStep, observations, corrections, tools } = input;
  const names = new Set(tools.map((t) => t.name));

  /* Recover from a bad call: fall back to a known tool or straight to an answer. */
  if (corrections.length > 0) {
    const known = tools.find((t) => !t.requiresApproval);
    if (known && currentStep.tool && names.has(currentStep.tool)) {
      /* keep trying the intended tool with cleaned-up args */
    } else if (!currentStep.tool) {
      return { type: "answer", text: brainAnswer(goal, input.steps, observations) };
    } else if (known) {
      return {
        type: "tool_call",
        tool: known.name,
        args: { query: goal },
        description: "Recovering with an available tool",
      };
    }
  }

  if (currentStep.tool && names.has(currentStep.tool)) {
    switch (currentStep.tool) {
      case "workspace.search":
        return { type: "tool_call", tool: "workspace.search", args: { query: goal }, description: "Searching past conversations" };
      case "workspace.files":
        return { type: "tool_call", tool: "workspace.files", args: { query: goal }, description: "Checking stored files" };
      case "memory.read":
        return { type: "tool_call", tool: "memory.read", args: { query: goal }, description: "Recalling memory" };
      case "memory.save":
        return {
          type: "tool_call",
          tool: "memory.save",
          args: { content: truncate(goal, 280), scope: "fact" },
          description: "Saving a fact to local memory",
        };
      case "preference.save":
        return {
          type: "tool_call",
          tool: "preference.save",
          args: { content: truncate(goal, 280) },
          description: "Saving a user preference (requires approval)",
        };
      case "task.note":
        return {
          type: "tool_call",
          tool: "task.note",
          args: { text: summarizeObservations(observations) || goal },
          description: "Recording working notes",
        };
      /* ---------------- Phase 3 real tools ---------------- */
      case "fs.write": {
        const template = codeTemplateFor(goal);
        return {
          type: "tool_call",
          tool: "fs.write",
          args: { path: template.path, content: template.content },
          description: `Writing ${template.path}`,
        };
      }
      case "shell.run": {
        const template = codeTemplateFor(goal);
        return {
          type: "tool_call",
          tool: "shell.run",
          args: { command: template.command, args: JSON.stringify(template.args), timeoutMs: 15_000 },
          description: `Running ${template.command} ${template.args.join(" ")}`,
        };
      }
      case "fs.read": {
        const lastError = [...observations].reverse().find((o) => !o.ok || /exit=([1-9])/.test(o.text));
        return {
          type: "tool_call",
          tool: "fs.read",
          args: { path: codeTemplateFor(goal).path },
          description: lastError ? "Inspecting for errors" : "Reading the file",
        };
      }
      case "fs.list":
        return { type: "tool_call", tool: "fs.list", args: { path: "." }, description: "Listing workspace files" };
      case "package.install":
        return {
          type: "tool_call",
          tool: "package.install",
          args: { name: packageFrom(goal) },
          description: `Installing ${packageFrom(goal)} (needs approval)`,
        };
      case "package.list":
        return { type: "tool_call", tool: "package.list", args: {}, description: "Listing installed packages" };
      case "web.fetch":
        return { type: "tool_call", tool: "web.fetch", args: { url: urlFrom(goal) }, description: `Fetching ${urlFrom(goal)}` };
      case "web.crawl":
        return {
          type: "tool_call",
          tool: "web.crawl",
          args: { url: urlFrom(goal), maxDepth: 1, maxPages: 4, maxRequests: 8 },
          description: `Crawling from ${urlFrom(goal)}`,
        };
      case "web.search":
        return { type: "tool_call", tool: "web.search", args: { query: goal }, description: "Searching the web" };
      case "web.screenshot":
        return { type: "tool_call", tool: "web.screenshot", args: { url: urlFrom(goal) }, description: `Screenshotting ${urlFrom(goal)}` };
      /* ---------------- Phase 4 media tools ---------------- */
      case "image.generate": {
        const gLower = goal.toLowerCase();
        return {
          type: "tool_call",
          tool: "image.generate",
          args: {
            prompt: goal,
            quality: MEDIA.highQuality.test(gLower) ? "high" : "standard",
            variants: MEDIA.variants.test(gLower) ? 2 : 1,
          },
          description: "Generating artwork",
        };
      }
      case "image.edit":
        return { type: "tool_call", tool: "image.edit", args: { instruction: goal }, description: "Editing the image" };
      case "media.upscale":
        return { type: "tool_call", tool: "media.upscale", args: {}, description: "Upscaling the image" };
      case "video.generate":
        return { type: "tool_call", tool: "video.generate", args: { prompt: goal, durationMs: 2000 }, description: "Rendering video frames" };
      case "audio.generate":
        return { type: "tool_call", tool: "audio.generate", args: { prompt: goal, durationMs: 3000 }, description: "Synthesizing audio" };
      default:
        break;
    }
  }

  return { type: "answer", text: brainAnswer(goal, input.steps, observations) };
}

export function brainAnswer(goal: string, steps: TaskStep[], observations: Observation[]): string {
  const lines: string[] = [];
  lines.push(`**Task complete.** Here's the outcome for: *${truncate(goal, 140)}*`);
  lines.push("");

  const done = steps.filter((s) => s.state === "done");
  const declined = steps.filter((s) => s.state === "declined");
  if (done.length > 0 || declined.length > 0) {
    lines.push("### What ran");
    for (const step of steps) {
      if (step.state === "pending" || step.state === "running") continue;
      const marker = step.state === "done" ? "✓" : step.state === "declined" ? "⊘" : "✗";
      const detail = step.state === "declined" ? " — declined by you" : step.result ? ` — ${truncate(step.result, 160)}` : "";
      lines.push(`- ${marker} **${step.title}**${detail}`);
    }
    lines.push("");
  }

  const useful = observations.filter((o) => o.ok && o.text.trim());
  if (useful.length > 0) {
    lines.push("### Findings");
    for (const observation of useful.slice(0, 4)) {
      lines.push(`- ${truncate(observation.text, 320)}`);
    }
    lines.push("");
  }

  lines.push(
    "> This loop runs on the mock intelligence with real sandboxed tools. When the remote model connects, planning and reasoning move to it — the runtime, tools and event protocol stay exactly the same.",
  );
  return lines.join("\n");
}

export function brainValidate(input: {
  goal: string;
  steps: TaskStep[];
  output: string;
  observations: Observation[];
}): { ok: boolean; note?: string } {
  const state: StepState[] = input.steps.map((s) => s.state);
  const openSteps = state.filter((s) => s === "pending" || s === "running").length;
  if (openSteps > 0) return { ok: false, note: `${openSteps} step(s) never finished` };
  if (!input.output || input.output.trim().length < 40) {
    return { ok: false, note: "The result is too thin to be useful" };
  }
  return { ok: true };
}

export function brainSummarize(texts: string[]): string {
  const userTurns = texts.filter((t) => t.startsWith("user:"));
  const topics = userTurns.slice(-4).map((t) => truncate(t.replace(/^user:\s*/, ""), 64));
  const latest = userTurns.length > 0 ? ` Latest request: "${topics[topics.length - 1]}"` : "";
  return `Covers ${texts.length} exchanges.${topics.length > 0 ? ` Topics: ${topics.slice(0, 3).join("; ")}.` : ""}${latest}`;
}
