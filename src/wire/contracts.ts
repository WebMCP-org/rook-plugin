// What the rook CLI reaches in Rook's Agents: their names, and exactly the
// callables and state fields it uses. Rook's own contracts are a superset; its
// contract test checks they still satisfy these, so neither side drifts
// unnoticed. No relative imports: Node loads this file directly as TypeScript.
import type { MCPServersState } from "agents";
import type { MCPClientManager } from "agents/mcp/client";
import type { FileUIPart } from "ai";
import { z } from "zod";

// ── Agent addresses ─────────────────────────────────────────────────────────

export const AGENT_CALL_TIMEOUT_MS = 75_000;
export const AGENT_CLASS_NAME = "BrowserThinkAgent";
export const AGENT_INSTANCE_NAME = "think";
export const CONVERSATION_AGENT_CLASS_NAME = "BrowserThinkConversation";

/** Rook's Chrome extension ids. Dev builds carry the staging key, so these two
 * are every Rook build. */
export const ROOK_EXTENSION_IDS = {
  production: "opojeelojlkcinlhkbahpcekdolfjmhi",
  staging: "abdagmfckapagjlibehlbmnpelngdmlo",
} as const;

// ── Models ──────────────────────────────────────────────────────────────────

/** What a ChatGPT sign-in uses until the side panel picks otherwise, and what
 * `rook model codex` picks when Codex here names nothing. */
export const DEFAULT_CHATGPT_MODEL_ID = "gpt-6-luna";
export const DEFAULT_CHATGPT_REASONING_EFFORT = "max";

/** A profile's own model: its ChatGPT sign-in, or an OpenAI-compatible endpoint. */
export type RookModelSource =
  | {
      kind: "chatgpt-oauth";
      status: "signed-out" | "signed-in" | "error";
      config?: { modelId: string; reasoningEffort: string };
    }
  | { kind: "openai-compatible"; baseUrl: string; modelId: string; reasoningEffort?: string };

/** An endpoint for `setOpenAiCompatibleModelSource`. Omitted capabilities are looked up. */
export type OpenAiCompatibleModelInput = {
  api: "chat-completions" | "responses";
  baseUrl: string;
  modelId: string;
  reasoningEffort?: string;
  acceptsImages?: boolean;
  acceptsPdfs?: boolean;
};

/** The model endpoint Chrome Enterprise policy sets, which Rook uses over the
 * profile's own: it needs a parseable base URL and a model id. */
export function managedModelEndpoint(
  policy: { modelBaseUrl?: string; modelId?: string } | null,
): { baseUrl: string; modelId: string } | undefined {
  if (!policy?.modelBaseUrl || !policy.modelId || !URL.canParse(policy.modelBaseUrl)) {
    return undefined;
  }
  return { baseUrl: policy.modelBaseUrl, modelId: policy.modelId };
}

// ── Tools ───────────────────────────────────────────────────────────────────

/** A tool the code tool's mcp namespace reaches: a connected server's, or an
 * open tab's WebMCP tool under server `tab:<tabId>`, carrying the tab and the
 * page's URL. */
export type McpToolDescriptor = MCPServersState["tools"][number] & {
  tabId?: number;
  url?: string;
};

/** The arguments `mcp["serverId/name"](args)` passes a tool, and the shape
 * of an automation's arguments too. Rook checks an automation's path itself. */
export const mcpToolInputSchema = z.record(z.string(), z.json());
export type McpToolInput = z.infer<typeof mcpToolInputSchema>;

// ── Automations ─────────────────────────────────────────────────────────────

/** The record a run leaves in the workspace once it ends. */
export const executionTraceFile = (executionId: string) =>
  `/executions/results/${executionId}.trace.json`;

export interface WorkspaceExecutionResult {
  executionId: string;
  files: readonly { label: string; path: string }[];
  result: unknown;
  logs: readonly string[];
}

// ── The root Agent: one per Chrome profile ──────────────────────────────────

type RookThreadStatus = "idle" | "running" | "attention" | "error" | "interrupted";

export type RookDirectoryState = {
  threads: readonly {
    id: string;
    title: string;
    updatedAt: number;
    status: RookThreadStatus;
  }[];
  browser: {
    /** Human handoffs, by execution id. */
    waits: Readonly<
      Record<string, { threadId: string; tabId: number; reason: string; expiresAt: number }>
    >;
  };
  operatingIdentity: { kind: "personal" } | { kind: "employee"; email: string };
  profileVerification:
    | { status: "unknown" | "signed-out" | "mismatch" }
    | { status: "verified"; email: string };
  model: RookModelSource;
  managedPolicy: { modelBaseUrl?: string; modelId?: string } | null;
};

export type RookDirectory = {
  /** Mints the conversation the caller named around its first message. */
  startThread(id: string, input: { text: string; files: FileUIPart[] }): Promise<void>;
  /** False when `messageId` was already submitted. */
  submitMessage(threadId: string, messageId: string, text: string): Promise<boolean>;
  runAutomation(
    threadId: string,
    path: string,
    args?: McpToolInput,
  ): Promise<WorkspaceExecutionResult>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(
    serverId: string,
    name: string,
    args: McpToolInput,
  ): ReturnType<MCPClientManager["callTool"]>;
  runBash(
    script: string,
    stdin: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Null clears the endpoint, back to the ChatGPT sign-in. */
  setOpenAiCompatibleModelSource(input: OpenAiCompatibleModelInput | null): Promise<RookModelSource>;
};

// ── A conversation Agent: one per thread ────────────────────────────────────

export type RookConversationState = {
  /** The run going on in the thread, if any. */
  executionTrace?: { executionId: string };
};

export type RookConversation = {
  turnOutcome(): Promise<"running" | "completed" | "error" | "aborted">;
  /** Resolves once the turn and its scripts have stopped. */
  stopCurrentWork(): Promise<void>;
};
