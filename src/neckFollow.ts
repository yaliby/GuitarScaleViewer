import { useCallback, useEffect, useState } from "react";
import type { FusedKey } from "./services/keyFusion";

/**
 * The neck's follow decision for the whole window.
 * Live Jam unmounts when you leave the room; this does not, so the settled key
 * and the Apply latch are still there when the room opens again.
 */
type NeckFollowMemory = {
  neckKey: FusedKey | null;
  applyDetected: boolean;
  applyPending: boolean;
  prevApply: boolean;
  lastAutoDecision: string;
  lastGateHold: string;
};

function freshMemory(): NeckFollowMemory {
  return {
    neckKey: null,
    applyDetected: true,
    applyPending: false,
    prevApply: true,
    lastAutoDecision: "",
    lastGateHold: "",
  };
}

let memory = freshMemory();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function readNeckFollow(): NeckFollowMemory {
  return memory;
}

export function resetNeckFollowForTests(): void {
  memory = freshMemory();
  emit();
}

export function useNeckFollow() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((tick) => tick + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const setNeckKey = useCallback((next: FusedKey | null) => {
    memory.neckKey = next;
    emit();
  }, []);

  const setApplyDetected = useCallback(
    (next: boolean | ((value: boolean) => boolean)) => {
      memory.applyDetected =
        typeof next === "function" ? next(memory.applyDetected) : next;
      emit();
    },
    [],
  );

  return {
    neckKey: memory.neckKey,
    applyDetected: memory.applyDetected,
    setNeckKey,
    setApplyDetected,
  };
}
