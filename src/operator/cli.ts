import {
  callLocalOperator,
  OperatorClientError,
  type OperatorCommand,
} from "./client.js";
import type { OperatorErrorCode, OperatorResponse } from "./protocol.js";

const EXIT_USAGE = 2;
const EXIT_NOT_RUNNING = 3;
const EXIT_AUTHENTICATION = 4;
const EXIT_PROTOCOL = 5;
const EXIT_NOT_STOPPED = 6;
const EXIT_WRITES_IN_FLIGHT = 7;
const EXIT_GENERATION_MISMATCH = 8;
const EXIT_CAPACITY_OR_TIMEOUT = 9;

function parseArguments(argv: readonly string[]): OperatorCommand | undefined {
  if (argv.length === 1 && argv[0] === "status") return { command: "status" };
  if (argv.length === 1 && argv[0] === "stop") return { command: "stop" };
  if (
    argv.length === 3 &&
    argv[0] === "resume" &&
    argv[1] === "--generation" &&
    /^(?:0|[1-9][0-9]*)$/.test(argv[2] ?? "")
  ) {
    const generation = Number(argv[2]);
    if (Number.isSafeInteger(generation) && generation >= 1) {
      return { command: "resume", generation };
    }
  }
  return undefined;
}

function statusText(status: {
  stopped: boolean;
  inFlightWrites: number;
  maxInFlightWrites: number;
  stopGeneration: number;
}): string {
  return (
    `stopped=${status.stopped} ` +
    `inFlightWrites=${status.inFlightWrites} ` +
    `maxInFlightWrites=${status.maxInFlightWrites} ` +
    `generation=${status.stopGeneration}`
  );
}

function successText(response: Extract<OperatorResponse, { ok: true }>): string {
  if (response.command === "status") {
    return (
      `STATUS ${statusText(response.status)} ` +
      `runtime=${response.health.runtime.status} ` +
      `adapter=${response.health.adapter.status} ` +
      `audit=${response.health.audit.status} ` +
      `registeredAdapters=${response.health.adapter.registeredAdapters} ` +
      `auditWrites=${response.health.audit.outstandingWrites}`
    );
  }
  if (response.command === "stop") {
    return `STOPPED ${statusText(response.status)} alreadyStopped=${response.alreadyStopped}`;
  }
  return `RESUMED ${statusText(response.status)}`;
}

function failureExitCode(code: OperatorErrorCode): number {
  const codes: Record<OperatorErrorCode, number> = {
    AUTHENTICATION_FAILED: EXIT_AUTHENTICATION,
    CAPACITY: EXIT_CAPACITY_OR_TIMEOUT,
    GENERATION_MISMATCH: EXIT_GENERATION_MISMATCH,
    INTERNAL_ERROR: EXIT_CAPACITY_OR_TIMEOUT,
    INVALID_REQUEST: EXIT_PROTOCOL,
    NOT_STOPPED: EXIT_NOT_STOPPED,
    TIMEOUT: EXIT_CAPACITY_OR_TIMEOUT,
    WRITES_IN_FLIGHT: EXIT_WRITES_IN_FLIGHT,
  };
  return codes[code];
}

async function main(): Promise<number> {
  const command = parseArguments(process.argv.slice(2));
  if (command === undefined) {
    process.stderr.write("OPERATOR_USAGE\n");
    return EXIT_USAGE;
  }
  try {
    const response = await callLocalOperator(command);
    if (response.ok) {
      process.stdout.write(`${successText(response)}\n`);
      return 0;
    }
    process.stderr.write(`OPERATOR_ERROR code=${response.error.code}\n`);
    return failureExitCode(response.error.code);
  } catch (error) {
    const category = error instanceof OperatorClientError ? error.category : "protocol";
    const result = category === "not-running"
      ? { code: "NOT_RUNNING", exitCode: EXIT_NOT_RUNNING }
      : category === "timeout"
        ? { code: "TIMEOUT", exitCode: EXIT_CAPACITY_OR_TIMEOUT }
        : { code: "PROTOCOL", exitCode: EXIT_PROTOCOL };
    process.stderr.write(`OPERATOR_ERROR code=${result.code}\n`);
    return result.exitCode;
  }
}

process.exitCode = await main();
