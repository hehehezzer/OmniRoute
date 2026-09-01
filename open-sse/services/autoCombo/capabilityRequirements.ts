/**
 * Capability-aware request classification for auto-combo routing.
 *
 * Intelligence, cost, and health are selection signals only after a candidate
 * can safely perform the requested work. Unknown providers are deliberately
 * chat-only: they may answer conversations, but they cannot satisfy execution
 * requirements until the registry declares an execution environment.
 */

export type RequestType =
  | "conversation"
  | "research"
  | "coding"
  | "repository_execution"
  | "infrastructure"
  | "security"
  | "document_generation";

export type ExecutionCapability =
  | "browser"
  | "filesystem"
  | "shell"
  | "git"
  | "code_editing"
  | "code_execution"
  | "code_analysis"
  | "repository_access"
  | "sandbox_write"
  | "reasoning"
  | "long_context";

export type SandboxCapability = "none" | "read_only" | "workspace_write" | "full_access";

export interface ProviderExecutionCapabilities {
  chat: boolean;
  browser: boolean;
  filesystem: boolean;
  shell: boolean;
  git: boolean;
  codeEditing: boolean;
  codeExecution: boolean;
  codeAnalysis: boolean;
  repositoryAccess: boolean;
  sandbox: SandboxCapability;
  reasoning: boolean;
  longContext: boolean;
}

export interface ProviderCapabilityRegistryEntry {
  provider: string;
  /** "*" applies to every model registered for this provider. */
  model: string;
  capabilities: ProviderExecutionCapabilities;
}

export interface CapabilityRoutingDecision {
  requestType: RequestType;
  requiredCapabilities: readonly ExecutionCapability[];
  preferredCapabilities: readonly ExecutionCapability[];
  signals: readonly string[];
}

const CHAT_ONLY: Readonly<ProviderExecutionCapabilities> = Object.freeze({
  chat: true,
  browser: false,
  filesystem: false,
  shell: false,
  git: false,
  codeEditing: false,
  codeExecution: false,
  codeAnalysis: true,
  repositoryAccess: false,
  sandbox: "none",
  reasoning: true,
  longContext: false,
});

const WEB_ONLY: Readonly<ProviderExecutionCapabilities> = Object.freeze({
  ...CHAT_ONLY,
  browser: true,
});

const EXECUTION_ENABLED: Readonly<ProviderExecutionCapabilities> = Object.freeze({
  chat: true,
  browser: true,
  filesystem: true,
  shell: true,
  git: true,
  codeEditing: true,
  codeExecution: true,
  codeAnalysis: true,
  repositoryAccess: true,
  sandbox: "workspace_write",
  reasoning: true,
  longContext: true,
});

/**
 * The capability registry is intentionally conservative. Browser-backed
 * providers are explicitly non-execution routes; a new provider must opt in
 * here before it can receive a repository/infrastructure/security request.
 */
export const PROVIDER_CAPABILITY_REGISTRY: readonly ProviderCapabilityRegistryEntry[] = [
  { provider: "chatgpt-web", model: "*", capabilities: WEB_ONLY },
  { provider: "chatgpt-web-codex", model: "*", capabilities: WEB_ONLY },
  { provider: "deepseek-web", model: "*", capabilities: WEB_ONLY },
  { provider: "grok-web", model: "*", capabilities: WEB_ONLY },
  { provider: "zai-web", model: "*", capabilities: WEB_ONLY },
  { provider: "codex", model: "*", capabilities: EXECUTION_ENABLED },
  // These routes may be code-oriented, but OmniRoute does not verify a writable
  // local repository execution surface for them. Keep them fail-closed until a
  // provider-specific execution adapter proves those capabilities at dispatch.
  { provider: "cursor", model: "*", capabilities: CHAT_ONLY },
  { provider: "codex-app-server", model: "*", capabilities: CHAT_ONLY },
];

const REQUIREMENTS: Readonly<Record<RequestType, CapabilityRoutingDecision>> = {
  conversation: {
    requestType: "conversation",
    requiredCapabilities: [],
    preferredCapabilities: ["reasoning"],
    signals: [],
  },
  research: {
    requestType: "research",
    requiredCapabilities: ["browser"],
    preferredCapabilities: ["reasoning", "long_context"],
    signals: [],
  },
  coding: {
    requestType: "coding",
    requiredCapabilities: ["code_analysis"],
    preferredCapabilities: ["reasoning", "long_context"],
    signals: [],
  },
  repository_execution: {
    requestType: "repository_execution",
    requiredCapabilities: [
      "filesystem",
      "shell",
      "git",
      "code_editing",
      "code_execution",
      "repository_access",
      "sandbox_write",
    ],
    preferredCapabilities: ["reasoning", "long_context"],
    signals: [],
  },
  infrastructure: {
    requestType: "infrastructure",
    requiredCapabilities: [
      "filesystem",
      "shell",
      "code_execution",
      "repository_access",
      "sandbox_write",
    ],
    preferredCapabilities: ["reasoning", "long_context"],
    signals: [],
  },
  security: {
    requestType: "security",
    requiredCapabilities: ["filesystem", "code_analysis", "repository_access"],
    preferredCapabilities: ["reasoning", "long_context"],
    signals: [],
  },
  document_generation: {
    requestType: "document_generation",
    requiredCapabilities: [],
    preferredCapabilities: ["reasoning", "long_context"],
    signals: [],
  },
};

function normalized(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function has(text: string, expression: RegExp): boolean {
  return expression.test(text);
}

function decisionFor(requestType: RequestType, signals: string[]): CapabilityRoutingDecision {
  const template = REQUIREMENTS[requestType];
  return {
    ...template,
    requiredCapabilities: [...template.requiredCapabilities],
    preferredCapabilities: [...template.preferredCapabilities],
    signals,
  };
}

/** Deterministic, local classifier. It never reads a repository or invokes a model. */
export function classifyRequestCapabilities(prompt: string): CapabilityRoutingDecision {
  const text = normalized(prompt);
  const repositoryTarget = has(
    text,
    /\b(?:repository|repo|codebase|working tree|git(?:\s+repo(?:sitory)?)?|project)\b|(?:^|\s)(?:~\/|\/|[a-z]:[\\/])/i
  );
  const executionVerb = has(
    text,
    /\b(?:modify|change|edit|refactor|implement|fix|update|prepare|harden|migrate|run|execute|test|commit|push|install)\b/i
  );
  const security = has(text, /\b(?:security|vulnerability|threat model|penetration test|audit)\b/i);
  const infrastructure = has(
    text,
    /\b(?:infrastructure|terraform|kubernetes|k8s|docker|deployment|deploy|ci\/?cd|systemd)\b/i
  );
  const research = has(
    text,
    /\b(?:research|investigate online|web search|find sources|compare sources)\b/i
  );
  const document = has(
    text,
    /\b(?:generate|draft|write|create|prepare)\b.{0,48}\b(?:document|documentation|proposal|report|summary|readme)\b/i
  );
  const coding = has(
    text,
    /\b(?:code|function|class|api|bug|debug|typescript|javascript|python|program)\b/i
  );

  if (security && (repositoryTarget || executionVerb || coding)) {
    return decisionFor("security", ["security", ...(repositoryTarget ? ["repository"] : [])]);
  }
  if (infrastructure && (repositoryTarget || executionVerb)) {
    return decisionFor("infrastructure", [
      "infrastructure",
      ...(repositoryTarget ? ["repository"] : []),
    ]);
  }
  if (repositoryTarget && executionVerb) {
    return decisionFor("repository_execution", ["repository", "execution_verb"]);
  }
  if (research) return decisionFor("research", ["research"]);
  if (document) return decisionFor("document_generation", ["document"]);
  if (coding) return decisionFor("coding", ["coding"]);
  return decisionFor("conversation", []);
}

export function getProviderExecutionCapabilities(
  provider: string | null | undefined,
  model: string | null | undefined
): ProviderExecutionCapabilities {
  const providerId = normalized(provider);
  const modelId = normalized(model);
  const entry = PROVIDER_CAPABILITY_REGISTRY.find(
    (candidate) =>
      candidate.provider === providerId && (candidate.model === "*" || candidate.model === modelId)
  );
  return { ...(entry?.capabilities || CHAT_ONLY) };
}

export function missingRequiredCapabilities(
  capabilities: ProviderExecutionCapabilities,
  required: readonly ExecutionCapability[]
): ExecutionCapability[] {
  return required.filter((capability) => {
    switch (capability) {
      case "browser":
        return !capabilities.browser;
      case "filesystem":
        return !capabilities.filesystem;
      case "shell":
        return !capabilities.shell;
      case "git":
        return !capabilities.git;
      case "code_editing":
        return !capabilities.codeEditing;
      case "code_execution":
        return !capabilities.codeExecution;
      case "code_analysis":
        return !capabilities.codeAnalysis;
      case "repository_access":
        return !capabilities.repositoryAccess;
      case "sandbox_write":
        return capabilities.sandbox !== "workspace_write" && capabilities.sandbox !== "full_access";
      case "reasoning":
        return !capabilities.reasoning;
      case "long_context":
        return !capabilities.longContext;
    }
  });
}

export function isExecutionRequest(requestType: RequestType): boolean {
  return requestType === "repository_execution" || requestType === "infrastructure";
}
