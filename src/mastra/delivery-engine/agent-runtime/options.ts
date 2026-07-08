import { WORKSPACE_TOOLS } from '@mastra/core/workspace';

export const requiredAgent = (mastra: any, id: string) => {
  const agent = mastra?.getAgentById(id);
  if (!agent) throw new Error(`${id} agent is not registered`);
  return agent as {
    generate: (message: string, options: Record<string, unknown>) => Promise<{ object?: unknown; text?: string }>;
  };
};

export const structuredNoToolOptions = {
  activeTools: [] as string[],
  maxSteps: 1,
};

export const implementationWorkspaceTools = [
  WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
  WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
] as string[];

export const implementationWriteOnlyWorkspaceTools = [
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
] as string[];

export const implementationRepairWorkspaceTools = [
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
] as string[];

const envTimeoutMs = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const deliveryAgentTimeouts = {
  standard: envTimeoutMs('DELIVERY_AGENT_CALL_TIMEOUT_MS', 300_000),
  build: envTimeoutMs('DELIVERY_BUILD_CALL_TIMEOUT_MS', 180_000),
  buildNoTool: envTimeoutMs('DELIVERY_BUILD_NO_TOOL_TIMEOUT_MS', 60_000),
  buildPostWriteQuiet: envTimeoutMs('DELIVERY_BUILD_POST_WRITE_QUIET_TIMEOUT_MS', 60_000),
  judge: envTimeoutMs('DELIVERY_JUDGE_CALL_TIMEOUT_MS', 300_000),
};

export const repairPostWriteQuietTimeoutMs = 8_000;
export const preWriteReadBudgetBlockLimit = 2;
