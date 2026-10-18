import { installAndroidBridge } from "./android-bridge";
import { describeError, showBootError } from "./error-report";
installAndroidBridge();
// Before React mounts nothing else can report a failure, which would leave a blank page.
const fail = (reason: unknown) => {
  const root = document.getElementById("root");
  if (root && !root.childElementCount) showBootError(root, describeError(reason));
};
window.addEventListener("error", (event) => fail(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => fail(event.reason));
void import("./main").catch(fail);
