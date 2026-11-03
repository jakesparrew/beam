import { config } from "dotenv";

config({ path: ["../../.env.local", "../../.env"], quiet: true });

const { checkDatabase } = await import("../src/health");
const result = await checkDatabase();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
