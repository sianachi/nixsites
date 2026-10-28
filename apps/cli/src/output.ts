/**
 * How a command says what happened, on the two streams a script reads.
 *
 * **Machine-readable by default, pretty only when a person is watching.** A CLI whose output shape
 * changes with the terminal width is one nobody can pipe, so stdout is compact JSON unless stdout is
 * a TTY and `--json` was not asked for - and `--json` forces the machine shape even on a TTY, for
 * the person scripting against their own terminal. Results go to stdout; anything that went wrong
 * goes to stderr, so `nixctl ... > out.json` keeps the data and the diagnostics apart.
 */

import { isNixApiError, NixErrorKind } from '@nix/api-client';

export interface OutputOptions {
  /** Force compact JSON even when stdout is a terminal. */
  readonly json: boolean;

  /** Whether stdout is attached to a terminal; injected so tests do not depend on the harness. */
  readonly isTty: boolean;
}

/** Reads the output shape from the parsed global flags and the real stdout. */
export function outputOptions(
  json: boolean,
  stream: { isTTY?: boolean } = process.stdout,
): OutputOptions {
  return { json, isTty: stream.isTTY === true };
}

/**
 * Prints a successful result.
 *
 * @param data The value to emit; serialised as-is.
 * @param options The output shape.
 * @param write Where it goes; the real stdout by default.
 */
export function printResult(
  data: unknown,
  options: OutputOptions,
  write: (line: string) => void = (line) => process.stdout.write(line),
): void {
  write(`${JSON.stringify(data, null, humanReadable(options) ? 2 : undefined)}\n`);
}

/** Whether a person is watching: a terminal, and `--json` not asked for. */
export function humanReadable(output: OutputOptions): boolean {
  return output.isTty && !output.json;
}

/**
 * Prints a compact table for a person watching a terminal: one header row, columns aligned to the
 * widest cell, two spaces between columns. Nothing pipeable reads this - a script wants
 * `printResult` instead - so it never has to be a real table renderer, just legible at a glance.
 *
 * @param headers The column headers, in order.
 * @param rows Each row's cells, same order and length as `headers`.
 * @param write Where it goes; the real stdout by default.
 */
export function printTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  write: (line: string) => void = (line) => process.stdout.write(line),
): void {
  if (rows.length === 0) {
    write(`${headers.join('  ')}\n(none)\n`);
    return;
  }

  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const formatRow = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();

  write(`${formatRow(headers)}\n`);
  for (const row of rows) {
    write(`${formatRow(row)}\n`);
  }
}

/**
 * The two things a failed command owes: a sentence on stderr, and an exit code a script can branch
 * on.
 */
export interface Failure {
  readonly message: string;
  readonly code: ExitCode;
}

/** Exit codes, so a caller can tell a refusal from a missing thing from a broken connection. */
export const ExitCode = {
  Ok: 0,
  /** A usage error, a config problem, or any failure without a more specific code. */
  General: 1,
  /** The caller is authenticated but not allowed, or their token is out of scope. */
  Refused: 3,
  /** What was asked for does not exist, or is not visible to the caller. */
  NotFound: 4,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Core's stable code for a personal access token that authenticates but does not reach a route. */
const INSUFFICIENT_SCOPE = 'auth.insufficient_scope';

/**
 * Appended after Core's own refusal, never in place of it: Core names the scope the route wanted,
 * and this says what a person does about it. Automation writes, for example, need `admin`.
 */
const SCOPE_HINT =
  'This profile token lacks that scope. Create a personal access token that holds it, then run ' +
  '`nixctl auth login --api-url <url> --token <token>`.';

/**
 * Turns anything thrown into a message and an exit code.
 *
 * A Nix API error carries Core's own words and a status the code maps from; anything else is a
 * client-side or usage failure and gets the general code with its own message. The full problem
 * detail is preserved verbatim - the CLI never rewrites Core's refusal into its own words.
 */
export function toFailure(error: unknown): Failure {
  if (isNixApiError(error)) {
    const detail = error.detail ?? error.title ?? error.message;
    if (error.kind === NixErrorKind.Problem || error.kind === NixErrorKind.Http) {
      if (error.status === 404) {
        return { message: detail, code: ExitCode.NotFound };
      }
      if (error.status === 401 || error.status === 403) {
        return {
          message: error.code === INSUFFICIENT_SCOPE ? `${detail}\n${SCOPE_HINT}` : detail,
          code: ExitCode.Refused,
        };
      }
    }
    return { message: detail, code: ExitCode.General };
  }

  return {
    message: error instanceof Error ? error.message : String(error),
    code: ExitCode.General,
  };
}

/**
 * Prints a failure to stderr and returns its exit code.
 *
 * @param error Whatever was thrown.
 * @param write Where the message goes; the real stderr by default.
 * @returns The exit code to leave with.
 */
export function printError(
  error: unknown,
  write: (line: string) => void = (line) => process.stderr.write(line),
): ExitCode {
  const failure = toFailure(error);
  write(`${failure.message}\n`);
  return failure.code;
}
