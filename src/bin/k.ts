import { assertConfig, profileConfigState, readConfig } from "../modules/config";
import { assertProfileConfigurationParity } from "../modules/config/profile-parity";
import { createDatabase } from "../modules/db/database";
import { ProblemError } from "../modules/http/problems";
import { IdentityService } from "../modules/identity/service";

function parseArgs(argv: string[]) {
	const args = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (!value.startsWith("--")) {
			continue;
		}
		args.set(value.slice(2), argv[index + 1] ?? "");
	}
	return args;
	}

const [, , commandGroup, command] = process.argv;
	if (commandGroup !== "admin" || command !== "credential-code") {
		process.stderr.write("Usage: k admin credential-code --profile <slug> --purpose <setup|recovery> [--ttl 15m] [--issuer operator]\n");
		process.exit(2);
	}

const args = parseArgs(process.argv.slice(4));
const ttlValue = args.get("ttl") ?? "15m";
const ttlMatch = ttlValue.match(/^(\d+)(m|h)$/);
	if (!ttlMatch) {
		process.stderr.write("TTL must look like 15m or 1h\n");
		process.exit(2);
	}

const ttlMinutes = Number.parseInt(ttlMatch[1], 10) * (ttlMatch[2] === "h" ? 60 : 1);
	if (ttlMinutes < 1 || ttlMinutes > 24 * 60) {
		process.stderr.write("TTL must be between 1 minute and 24 hours\n");
		process.exit(2);
	}

const profileSlug = args.get("profile") ?? "";
const purpose = args.get("purpose") as "setup" | "recovery" | undefined;
if (!profileSlug || (purpose !== "setup" && purpose !== "recovery")) {
	process.stderr.write("--profile and --purpose are required\n");
	process.exit(2);
}

const config = assertConfig(readConfig());
const database = createDatabase(config);
try {
	await assertProfileConfigurationParity(database, profileConfigState(config).value);
	const identity = new IdentityService(database, config);
	const result = await identity.issueCredentialCode({
		issuerLabel: args.get("issuer") ?? "operator-cli",
		profileSlug,
		purpose,
		reason: purpose === "recovery" ? "Operator recovery issuance" : "Operator setup issuance",
		ttlMinutes,
	});

	process.stdout.write(`${result.code}\n`);
} catch (error) {
	if (error instanceof ProblemError) {
		process.stderr.write(`${error.code}: ${error.message}\n`);
	} else {
		process.stderr.write("Credential code command failed\n");
	}
	process.exitCode = 1;
} finally {
	await database.close();
}