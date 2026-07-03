import { useEffect, useRef } from "react";
import { useUpdateStore } from "../update/store";

export function AutoUpdater() {
  const runningRef = useRef(false);
  const checkNow = useUpdateStore((s) => s.checkNow);
  const downloadNow = useUpdateStore((s) => s.downloadNow);
  const installNow = useUpdateStore((s) => s.installNow);
  const ignoreVersion = useUpdateStore((s) => s.ignoreVersion);

  useEffect(() => {
    let active = true;

    async function run() {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        const info = await checkNow({ automatic: true });
        if (!active || !info) return;
        const shouldDownload = window.confirm(`milim ${info.version} is available. Download it now?`);
        if (!active) return;
        if (!shouldDownload) {
          ignoreVersion(info.version);
          return;
        }
        const path = await downloadNow(info);
        if (!active || !path) return;
        if (window.confirm("Update downloaded. Restart milim now to install it?")) {
          await installNow();
        }
      } catch (error) {
        console.warn("Auto-update check failed:", error);
      } finally {
        runningRef.current = false;
      }
    }

    void run();
    const timer = window.setInterval(() => void run(), 60 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [checkNow, downloadNow, ignoreVersion, installNow]);

  return null;
}
