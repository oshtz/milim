import { useEffect, useRef } from "react";
import { useUpdateStore } from "../update/store";

export function AutoUpdater() {
  const runningRef = useRef(false);
  const checkNow = useUpdateStore((s) => s.checkNow);

  useEffect(() => {
    async function run() {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        await checkNow({ automatic: true });
      } catch (error) {
        console.warn("Auto-update check failed:", error);
      } finally {
        runningRef.current = false;
      }
    }

    void run();
    const timer = window.setInterval(() => void run(), 60 * 60 * 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [checkNow]);

  return null;
}
