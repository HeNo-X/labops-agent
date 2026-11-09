import { executeTool as realExecuteTool } from '../../server/tools/registry.ts';
import type { ToolContext, ToolExecution } from '../../server/tools/registry.ts';
export { toolSpecs, toolsForMode } from '../../server/tools/registry.ts';
export const toolResults = new Map<string, ToolExecution>();
export const executed: string[] = [];
export async function executeTool(name: unknown, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  executed.push(String(name));
  return toolResults.get(String(name)) ?? realExecuteTool(name, args, ctx);
}
