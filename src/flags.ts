/** Which answer a command line asks for before any work starts: help, the version, or neither. */
export function infoFlag(args: string[]): "help" | "version" | undefined {
  if (args.some((a) => a === "--help" || a === "-h")) return "help";
  if (args.some((a) => a === "--version" || a === "-V" || a === "-v")) return "version";
  return undefined;
}
