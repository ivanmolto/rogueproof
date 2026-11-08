/**
 * Local tool execution inside the no-egress sandbox container via
 * `docker exec`: read_file, write_file, run_command, each only
 * after the active policy allowed it. Empty until task 3.4.
 */
export const MODULE = "sandbox" as const;
