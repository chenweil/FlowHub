// src/features/agents/registry.ts — agent registry (commands, MCP servers)
import type { RegistryCommand, RegistryMcpServer, ModelOption } from '../../types';
import { state } from '../../store';
import { readTextFromUnknown } from './utils';
import { normalizeModelOption } from './model';
import { saveAgents, renderAgentList } from './actions';
import { updateCurrentAgentModelUI, updateCurrentAgentThinkUI, renderCurrentAgentModelMenu } from './ui';

// ── Registry normalizers ──────────────────────────────────────────────────────

export function normalizeRegistryCommands(rawEntries: unknown[] | undefined): RegistryCommand[] {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const normalized: RegistryCommand[] = [];
  const seen = new Set<string>();

  for (const entry of rawEntries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const rawName = readTextFromUnknown((entry as Record<string, unknown>).name);
    if (!rawName) {
      continue;
    }

    const name = rawName.startsWith('/') ? rawName : `/${rawName}`;
    const dedupeKey = name.toLowerCase();
    if (dedupeKey === '/test') {
      continue;
    }
    if (seen.has(dedupeKey)) {
      continue;
    }

    const description = readTextFromUnknown((entry as Record<string, unknown>).description);
    const scope = readTextFromUnknown((entry as Record<string, unknown>).scope);
    normalized.push({ name, description, scope });
    seen.add(dedupeKey);
  }

  return normalized;
}

export function normalizeRegistryMcpServers(rawEntries: unknown[] | undefined): RegistryMcpServer[] {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const normalized: RegistryMcpServer[] = [];
  const seen = new Set<string>();

  for (const entry of rawEntries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const rawName = readTextFromUnknown((entry as Record<string, unknown>).name);
    if (!rawName) {
      continue;
    }

    const dedupeKey = rawName.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    const description = readTextFromUnknown((entry as Record<string, unknown>).description);
    normalized.push({ name: rawName, description });
    seen.add(dedupeKey);
  }

  return normalized;
}

// ── Registry application ─────────────────────────────────────────────────────

export function applyAgentRegistry(
  agentId: string,
  rawCommands: unknown[] | undefined,
  rawMcpServers: unknown[] | undefined
): void {
  const commands = normalizeRegistryCommands(rawCommands);
  const mcpServers = normalizeRegistryMcpServers(rawMcpServers);
  if (commands.length === 0 && mcpServers.length === 0) {
    return;
  }

  state.registryByAgent[agentId] = {
    commands,
    mcpServers,
  };

  if (agentId === state.currentAgentId) {
    void import('../app').then(({ updateSlashCommandMenu }) => {
      updateSlashCommandMenu();
    });
  }
}

export function applyAgentModelRegistry(
  agentId: string,
  rawModels: unknown[] | undefined,
  rawCurrentModel: unknown
): void {
  const models = Array.isArray(rawModels)
    ? rawModels
        .map((item) => normalizeModelOption(item))
        .filter((item): item is ModelOption => Boolean(item))
    : [];

  if (models.length > 0) {
    state.modelOptionsCacheByAgent[agentId] = models;
  }

  const currentModel =
    typeof rawCurrentModel === 'string' && rawCurrentModel.trim().length > 0
      ? rawCurrentModel.trim()
      : null;

  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) {
    return;
  }

  if (currentModel && agent.selectedModel !== currentModel) {
    agent.selectedModel = currentModel;
    void saveAgents();
    renderAgentList();
  }

  if (state.currentAgentId === agentId) {
    updateCurrentAgentModelUI();
    updateCurrentAgentThinkUI();
    if (state.modelSelectorOpen) {
      renderCurrentAgentModelMenu(agent, state.modelOptionsCacheByAgent[agentId] || []);
    }
  }
}

// ── Model option normalizer ───────────────────────────────────────────────────

export { normalizeModelOption };
