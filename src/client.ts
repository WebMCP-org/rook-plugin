import {
  AgentClient,
  AgentCallTimeoutError,
  AgentConnectionClosedError,
  type AgentClientOptions,
  type CallOptions,
} from "agents/client";
import type { useAgent, UseAgentOptions } from "agents/react";
import {
  AGENT_CALL_TIMEOUT_MS,
  AGENT_CLASS_NAME,
  AGENT_INSTANCE_NAME,
  CONVERSATION_AGENT_CLASS_NAME,
  type RookConversation,
  type RookDirectory,
} from "./wire/contracts";

/** Native options with the host's explicit connection deadline. */
export type RookConnection = AgentClientOptions & UseAgentOptions & { connectionTimeout: number };

export const ROOK_AGENT_OPTIONS = {
  agent: AGENT_CLASS_NAME,
  name: AGENT_INSTANCE_NAME,
  minReconnectionDelay: 250,
  maxReconnectionDelay: 1_000,
  defaultCallTimeout: AGENT_CALL_TIMEOUT_MS,
};

export function openRookAgent<Agent, State>(
  connection: RookConnection,
  agent: string,
  name: string,
): AgentClient<Agent, State> {
  return new AgentClient<Agent, State>({ ...connection, agent, name });
}

type SubmissionRef = { threadId: string; submissionId: string };

export class SubmissionOutcomeUnknown extends Error {
  constructor(
    readonly submission: SubmissionRef,
    cause: unknown,
  ) {
    super(
      `Rook has not confirmed submission ${submission.submissionId} in thread ${submission.threadId}.`,
      {
        cause,
      },
    );
  }
}

/** Read the durable receipt from the same relay route, with a separate socket. */
export async function inspectSubmission(
  connection: RookConnection,
  { threadId, submissionId }: SubmissionRef,
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(connection.connectionTimeout + 2_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  deadline.throwIfAborted();
  const chat = openRookAgent<RookConversation, unknown>(
    connection,
    CONVERSATION_AGENT_CLASS_NAME,
    threadId,
  );
  const cleanup = new AbortController();
  const stopped = new Promise<never>((_, reject) => {
    deadline.addEventListener("abort", () => reject(deadline.reason), {
      once: true,
      signal: cleanup.signal,
    });
  });
  try {
    const read = async () => {
      await chat.ready;
      if (!chat.identified || chat.readyState !== chat.OPEN) throw new Error("Rook went offline");
      return chat.stub.inspectSubmission(submissionId);
    };
    return await Promise.race([read(), stopped]);
  } finally {
    cleanup.abort();
    chat.close();
  }
}

export async function startThread<State>(
  root: AgentClient<RookDirectory, State> | ReturnType<typeof useAgent<RookDirectory, State>>,
  connection: RookConnection,
  threadId: string,
  input: Parameters<RookDirectory["startThread"]>[1],
  options?: CallOptions,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  // Agents queues sends made while disconnected. Only dispatch on the current,
  // identified socket. A lost response is reconciled by reading, never sending.
  if (!root.identified || root.readyState !== root.OPEN) throw new Error("Rook is reconnecting");
  try {
    await root.call("startThread", [threadId, input], options);
  } catch (error) {
    // The pinned Agents client rejects transmitted calls with this close error
    // or its RPC deadline. Server refusals should reach the caller intact.
    if (!(error instanceof AgentConnectionClosedError) && !(error instanceof AgentCallTimeoutError))
      throw error;
    const submission = { threadId, submissionId: threadId };
    try {
      if (await inspectSubmission(connection, submission, signal)) return;
    } catch (cause) {
      throw new SubmissionOutcomeUnknown(submission, cause);
    }
    throw new SubmissionOutcomeUnknown(submission, error);
  }
}
