/**
 * Grok Build (`grok agent stdio`) が話す ACP = Agent Client Protocol の型。
 *
 * 本家 codex-plugin-cc はここで `../../.generated/app-server-types/` を import して
 * いたが、それは Codex の schema から CI が生成する成果物で、本リポジトリには
 * 存在しない。Grok 側には同等の生成物がないため、実測した通信内容
 * （grok 0.2.118 / protocolVersion 1）をもとに手書きで自己完結させている。
 *
 * `_x.ai/` 接頭辞の付いたメソッドと `_meta` 配下は xAI の独自拡張で、
 * ACP 本体の仕様には無い。将来の grok 更新で変わりうる箇所として分けて書く。
 */

export interface ClientInfo {
  name: string;
  title?: string;
  version: string;
}

export interface FileSystemCapability {
  readTextFile: boolean;
  writeTextFile: boolean;
}

export interface ClientCapabilities {
  fs: FileSystemCapability;
  terminal?: boolean;
}

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
  clientInfo?: ClientInfo;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

export interface ModelDescriptor {
  modelId: string;
  name: string;
  description?: string;
  _meta?: {
    totalContextTokens?: number;
    agentType?: string;
    supportsReasoningEffort?: boolean;
    reasoningEffort?: string;
    reasoningEfforts?: Array<{
      id: string;
      value: string;
      label: string;
      description?: string;
      default?: boolean;
    }>;
  };
}

export interface ModelState {
  currentModelId: string;
  availableModels: ModelDescriptor[];
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: { list?: Record<string, unknown> };
  auth?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  authMethods?: AuthMethod[];
  _meta?: {
    currentWorkingDirectory?: string;
    agentVersion?: string;
    agentId?: string;
    agentInstanceId?: string;
    modelState?: ModelState;
    availableCommands?: AvailableCommand[];
    [key: string]: unknown;
  };
}

export interface AuthenticateParams {
  methodId: string;
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  type?: "stdio" | "http" | "sse";
  url?: string;
}

export interface SessionNewParams {
  cwd: string;
  mcpServers: McpServerConfig[];
  _meta?: Record<string, unknown>;
}

export interface SessionNewResponse {
  sessionId: string;
  models?: ModelState;
  modes?: unknown;
}

export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: McpServerConfig[];
}

export interface SessionLoadResponse {
  models?: ModelState;
  modes?: unknown;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: "image"; data: string; mimeType: string };

export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

/**
 * ターンの終了理由。`end_turn` が正常完了、`max_tokens` / `max_turn_requests` は
 * 打ち切り、`refusal` はモデルの拒否、`cancelled` は session/cancel による中断。
 */
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export interface SessionPromptResponse {
  stopReason: StopReason;
  _meta?: Record<string, unknown>;
}

export interface SessionCancelParams {
  sessionId: string;
}

export interface SessionSetModelParams {
  sessionId: string;
  modelId: string;
}

export interface SessionListParams {
  cwd?: string;
  limit?: number;
}

export interface SessionSummary {
  sessionId: string;
  title: string | null;
  cwd: string;
  isWorktree?: boolean;
  modelId?: string;
  activity?: string;
  lastChangeUnixMs?: number;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint?: string } | null;
}

/** ツール呼び出しの権限確認。agent -> client 方向のリクエスト。 */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
  };
  options: PermissionOption[];
}

export type RequestPermissionResponse =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

/** ファイル I/O。clientCapabilities.fs を true で申告したときだけ飛んでくる。 */
export interface ReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface WriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

/** session/update 通知の中身。sessionUpdate で判別する。 */
export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: string;
      rawInput?: unknown;
      locations?: Array<{ path: string; line?: number }>;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: "pending" | "in_progress" | "completed" | "failed";
      rawInput?: unknown;
      rawOutput?: unknown;
      locations?: Array<{ path: string; line?: number }>;
    }
  | { sessionUpdate: "plan"; entries: Array<{ content: string; priority?: string; status?: string }> }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "session_info_update"; title?: string }
  | { sessionUpdate: "current_mode_update"; currentModeId: string };

export interface SessionUpdateNotification {
  jsonrpc?: "2.0";
  method: "session/update";
  params: {
    sessionId: string;
    update: SessionUpdate;
    _meta?: Record<string, unknown>;
  };
}

/**
 * xAI 独自の通知。ACP 本体には無い。
 * 実測で観測したもの: `_x.ai/session_notification`（response_completed /
 * pending_interaction / interaction_resolved / hook_execution /
 * tool_call_delta_chunk / session_summary_generated）、`_x.ai/mcp/*`、
 * `_x.ai/queue/changed`、`_x.ai/sessions/changed`。
 */
export interface XaiNotification {
  jsonrpc?: "2.0";
  method: string;
  params: Record<string, unknown>;
}

export type AcpNotification = SessionUpdateNotification | XaiNotification;
export type AcpNotificationHandler = (message: AcpNotification) => void;

export interface AcpClientOptions {
  env?: NodeJS.ProcessEnv;
  clientInfo?: ClientInfo;
  clientCapabilities?: ClientCapabilities;
  protocolVersion?: number;
  /** `grok` 実行ファイルのパス。未指定なら PATH 上の `grok`。 */
  grokBin?: string;
  permissionHandler?: (params: RequestPermissionParams) => RequestPermissionResponse;
  brokerEndpoint?: string;
  disableBroker?: boolean;
  reuseExistingBroker?: boolean;
}

export interface AcpMethodMap {
  initialize: { params: InitializeParams; result: InitializeResponse };
  authenticate: { params: AuthenticateParams; result: Record<string, never> };
  "session/new": { params: SessionNewParams; result: SessionNewResponse };
  "session/load": { params: SessionLoadParams; result: SessionLoadResponse };
  "session/prompt": { params: SessionPromptParams; result: SessionPromptResponse };
  "session/cancel": { params: SessionCancelParams; result: Record<string, never> };
  "session/set_model": { params: SessionSetModelParams; result: Record<string, never> };
  "session/list": { params: SessionListParams; result: SessionListResponse };
}

export type AcpMethod = keyof AcpMethodMap;
export type AcpRequestParams<M extends AcpMethod> = AcpMethodMap[M]["params"];
export type AcpResponse<M extends AcpMethod> = AcpMethodMap[M]["result"];
