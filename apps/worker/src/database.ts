export function databaseUrl(env: {
  MODE: "local" | "hosted";
  DATABASE_URL: string;
  HYPERDRIVE?: { connectionString: string };
}) {
  return env.MODE === "hosted" && env.HYPERDRIVE
    ? env.HYPERDRIVE.connectionString
    : env.DATABASE_URL;
}
