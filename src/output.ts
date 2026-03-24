/**
 * Consistent output formatting for all xenv commands.
 * Every command builds a typed data object, then pipes it through print_output.
 */

export function format_output(
  data: unknown,
  json_mode: boolean,
  human_formatter: (d: any) => string
): string {
  if (json_mode) {
    return JSON.stringify(data, null, 2);
  }
  return human_formatter(data);
}

export function print_output(
  data: unknown,
  json_mode: boolean,
  human_formatter: (d: any) => string
): void {
  const output = format_output(data, json_mode, human_formatter);
  if (output.length > 0) {
    console.log(output);
  }
}
