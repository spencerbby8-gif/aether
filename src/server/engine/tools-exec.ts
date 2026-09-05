import type { ToolSchema } from "@/lib/types";

/**
 * The engine's real tools. These are executed by the ENGINE itself inside its
 * own `/api/chat` agent loop — the engine runs `run_command` on the engine
 * host, `web_search`/`fetch_page`/`crawl_site` on the engine's network, and
 * `generate_image`/`generate_voice` on the engine's GPU. Aether does NOT
 * re-implement these; it relays the engine's `/api/chat` agent loop.
 *
 * These schemas are kept as the canonical documentation of the engine's
 * capability surface. There is deliberately NO per-tool execution endpoint:
 * the engine executes tools internally, so there is nothing to proxy.
 */

export const REAL_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "web_search",
    description: "Search the web. Returns ranked sources with titles, URLs and snippets (citations).",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "fetch_page",
    description: "Fetch one URL and return its readable text content.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "crawl_site",
    description: "Crawl a site from a seed URL with depth and page limits; returns normalized sources.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        depth: { type: "number" },
        max_pages: { type: "number" },
      },
      required: ["url"],
    },
  },
  {
    name: "run_command",
    description:
      "Run any shell command on the engine host (Ubuntu, root access, internet ON, python3/pip/curl/git/wget available, working dir /kaggle/working). You can install packages (pip install, npm install, apt-get install), install and use headless browsers for web automation (pip install playwright && playwright install chromium), clone repos (git clone), compile code, run scripts, chain commands with &&, use pipes and redirects, download files, inspect the system, and run background processes. For browser tasks: install playwright first, then write and execute a Python script that uses it to navigate, fill forms, screenshot, or log in to pages. Always check exit codes and read stderr.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Full shell command (e.g. 'pip install requests', 'git clone https://github.com/user/repo && cd repo && ls -la', 'pip install playwright && playwright install chromium')",
        },
        timeout: { type: "number", description: "seconds, default 60 max 150" },
      },
      required: ["command"],
    },
  },
  {
    name: "generate_image",
    description: "Generate a JPG image from a prompt. Returns the image artifact.",
    parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  },
  {
    name: "browser",
    description:
      "Automate a headless browser for web tasks: navigate to URLs, click elements, fill forms, log in to sites, take screenshots, extract content, and interact with JavaScript-rendered pages. Uses Playwright (Chromium). The browser is installed on demand via run_command if not already present. Write browser automation as a Python script and execute it via run_command.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "What to do: 'navigate' (go to URL), 'screenshot' (capture page), 'extract' (get page content), 'interact' (click/fill), or 'script' (run custom Playwright code)",
        },
        url: { type: "string", description: "Target URL for navigation" },
        selector: { type: "string", description: "CSS selector for interaction" },
        value: { type: "string", description: "Value to fill in (for forms)" },
        script: { type: "string", description: "Custom Playwright Python code to execute" },
      },
      required: ["action"],
    },
  },
  {
    name: "generate_voice",
    description: "Synthesize WAV speech/audio from text. Returns the audio artifact.",
    parameters: { type: "object", properties: { text: { type: "string" }, voice: { type: "string" } }, required: ["text"] },
  },
];
