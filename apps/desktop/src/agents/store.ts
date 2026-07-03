import { create } from "zustand";
import { listAgents, type Agent } from "../api";

interface AgentsState {
  agents: Agent[];
  refresh: () => Promise<void>;
}

export const useAgents = create<AgentsState>()((set) => ({
  agents: [],
  refresh: async () => {
    set({ agents: await listAgents() });
  },
}));
