import { resolveBackend } from "../backend.ts";
import { formatReport, runP0 } from "./fixture.ts";

const args = process.argv.slice(2);
if (args[0] === "--boot-check") {
  process.stdout.write(`${resolveBackend(process.env)}\n`);
} else {
  const report = await runP0();
  process.stdout.write(formatReport(report));
  // Self-tests can pass while the feasibility gates remain unmet. CI must
  // receive a failing exit status when this command is used as the P0 gate.
  if (report.rows.some((row) => row.status !== "pass")) process.exitCode = 1;
}
