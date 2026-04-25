import { create } from "zustand";

interface RealtimeState {
  runtimeMode: "analysis" | "paper" | "live";
  autoTradingEnabled: boolean;
  riskEnabled: boolean;
  latestSignal: string;
  update: (payload: Partial<Omit<RealtimeState, "update">>) => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  runtimeMode: "analysis",
  autoTradingEnabled: false,
  riskEnabled: true,
  latestSignal: "hold",
  update: (payload) => set((state) => ({ ...state, ...payload })),
}));
